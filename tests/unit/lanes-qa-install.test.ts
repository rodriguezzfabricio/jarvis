import { createHash } from "node:crypto";
import { closeSync, cpSync, existsSync, ftruncateSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ChecksStore, protectedCheckPath, hashCheckArtifacts } from "../../packages/cli/src/checks/store.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { installChecks, readApprovedChecks } from "../../packages/cli/src/runner/checks-author.ts";
import { buildQaToolchainManifest, installQaToolchain } from "../../packages/cli/src/lanes/qa-install.ts";
import { fakeToolchain } from "../fixtures/qa/toolchain.ts";
const roots: string[] = [];
const temp = () => { const root = mkdtempSync("/private/tmp/j-qa-install-"); roots.push(root); return root; };
afterEach(() => roots.splice(0).forEach(root => rmSync(root, {recursive:true,force:true})));
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
function setup() {
  const source = fakeToolchain(temp()), project = temp(), store = new ChecksStore(project), ledger = Ledger.open(project);
  mkdirSync(store.checksDir);
  return {source, store, ledger, input:{source:source.toolchain.root, manifest:source.manifest}};
}
it("installs the caller's pinned manifest into the reserved fixtures, independently of the source, without approving", () => {
  const f = setup(), clone = vi.fn((source:string, dest:string) => cpSync(source,dest,{recursive:true}));
  const result = installQaToolchain(f.store,f.input,{clone});
  expect(clone).toHaveBeenCalledOnce();
  expect(result.root).toBe(join(f.store.checksDir,"fixtures/qa-toolchain"));
  expect(result.manifest).toEqual(f.input.manifest);
  expect(result.manifestHash).toBe(sha(readFileSync(result.manifestPath)));
  expect(f.store.verify(f.ledger).ok).toBe(false);
  f.store.approve(f.ledger,"reviewed");
  writeFileSync(join(f.input.source,"axe.js"),"source changed");
  expect(f.store.verify(f.ledger).ok).toBe(true);
  expect(() => installQaToolchain(f.store,f.input)).toThrow();
});
it.each(["flip","extra","symlink","hardlink","oversize"])("refuses %s in the source before copying", fault => {
  const f=setup(), file=join(f.input.source,"axe.js"), clone=vi.fn();
  if(fault==="flip") writeFileSync(file,"changed");
  if(fault==="extra") writeFileSync(join(f.input.source,"extra"),"extra");
  if(fault==="symlink") {rmSync(file);symlinkSync(join(f.input.source,"cli.cjs"),file);}
  if(fault==="hardlink") linkSync(file,join(f.input.source,"alias"));
  if(fault==="oversize") {
    const fd=openSync(file,"r+");ftruncateSync(fd,256*1024*1024+1);closeSync(fd);
    // Even a correctly pinned oversized source must fail before a copy begins.
    f.input.manifest.files["axe.js"]=hashCheckArtifacts(f.input.source)["axe.js"]!;
    writeFileSync(join(f.input.source,"manifest.json"),JSON.stringify(f.input.manifest));
  }
  expect(() => installQaToolchain(f.store,f.input,{clone})).toThrow();
  expect(clone).not.toHaveBeenCalled();
});
it("checks the clone's hashes, rejects injected files and removes a failed install", () => {
  const f=setup();
  expect(() => installQaToolchain(f.store,f.input,{clone:(source,dest)=>{cpSync(source,dest,{recursive:true});writeFileSync(join(dest,"axe.js"),"corrupt");}})).toThrow();
  expect(existsSync(join(f.store.checksDir,"fixtures/qa-toolchain"))).toBe(false);
});
it("falls back after removing a partial APFS clone", () => {
  const f=setup();
  const result=installQaToolchain(f.store,f.input,{clone:(_source,dest)=>{mkdirSync(dest);writeFileSync(join(dest,"partial"),"partial");throw Error("no clone");}});
  expect(existsSync(join(result.root,"partial"))).toBe(false);
  expect(result.manifestHash).toBe(sha(readFileSync(result.manifestPath)));
});
it("reserves both roots in every case and preserves opaque QA bytes across architect installation", async () => {
  const f=setup(); installQaToolchain(f.store,f.input);
  for(const path of ["qa-toolchain", "QA-TOOLCHAIN/sub/file", "fixtures/Qa-Toolchain/manifest.json"]) expect(protectedCheckPath(path)).toBe(true);
  f.store.approve(f.ledger,"reviewed runtime");
  const check={name:"unit",criteria:[],cases:[{id:"unit",command:"node --test"}],verify:'echo "JARVIS-CHECK-COMPLETE $(cat "$JARVIS_COMPLETION_FILE")"',timeoutMs:1000};
  await installChecks(f.store,{checks:[check],files:{"unit.check.json":JSON.stringify(check)}},f.ledger,{spec:{criteria:[]},reviewVerdict:async()=>({status:"pass"})});
  expect(readApprovedChecks(f.store,f.ledger).map(c=>c.name)).toEqual(["unit"]);
  expect(f.store.verify(f.ledger).ok).toBe(true);
});
it.each(["flip","extra","symlink","hardlink","oversize"])("the store refuses QA %s after approval, including reapproval of oversize", fault=>{
  const f=setup(), root=join(f.store.checksDir,"fixtures/QA-Toolchain");mkdirSync(root,{recursive:true});
  const file=join(root,"binary");writeFileSync(file,Buffer.from([255,0,7]));f.store.approve(f.ledger,"reviewed");
  if(fault==="flip")writeFileSync(file,Buffer.from([255,0,8]));
  if(fault==="extra")writeFileSync(join(root,"extra"),"extra");
  if(fault==="symlink"){rmSync(file);symlinkSync(join(f.input.source,"axe.js"),file);}
  if(fault==="hardlink")linkSync(file,join(root,"alias"));
  if(fault==="oversize"){const fd=openSync(file,"r+");ftruncateSync(fd,256*1024*1024+1);closeSync(fd);expect(()=>f.store.approve(f.ledger,"oversize")).toThrow();}
  if(fault==="hardlink"||fault==="symlink")expect(()=>f.store.approve(f.ledger,"linked runtime")).toThrow();
  expect(f.store.verify(f.ledger).ok).toBe(false);
});
it("refuses overlapping source and destination before copying",()=>{
 const f=setup(),clone=vi.fn();
 const manifest={...f.input.manifest,files:f.source.toolchain.store.hashAll()};
 expect(()=>installQaToolchain(f.source.toolchain.store,{source:f.source.toolchain.store.checksDir,manifest},{clone})).toThrow();
 expect(clone).not.toHaveBeenCalled();
});
it("does not overwrite an already installed toolchain with unchanged reviewed source",()=>{
 const f=setup();installQaToolchain(f.store,f.input);const before=f.store.hashAll(),clone=vi.fn();
 expect(()=>installQaToolchain(f.store,f.input,{clone})).toThrow(/already installed/);
 expect(clone).not.toHaveBeenCalled();expect(f.store.hashAll()).toEqual(before);
});

it("builds the manifest from pinned installed packages and explicit entry points",()=>{
 const f=setup(), {version:_pw,...playwright}=f.input.manifest.playwright, {version:_axe,...axe}=f.input.manifest.axe;
 const input={source:f.input.source,files:f.input.manifest.files,playwright,axe};
 const manifest=buildQaToolchainManifest(input);
 expect(manifest).toEqual(f.input.manifest);
 expect(installQaToolchain(f.store,{source:f.input.source,manifest}).manifest).toEqual(manifest);
 expect(()=>buildQaToolchainManifest({...input,axe:{...axe,package:"../outside"}})).toThrow();
 writeFileSync(join(input.source,"axe-package.json"),JSON.stringify({version:"9.9.9"}));
 expect(()=>buildQaToolchainManifest(input)).toThrow(/hash/);
});
