import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import { installDesignChecks } from "../../packages/cli/src/lanes/impeccable-install.ts";
import { runSession } from "../../packages/cli/src/proc/session.ts";
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const FAKE_ENGINE='#!/bin/sh\nif [ "$1" = "--version" ]; then printf "0.1.16+engine\\n"; else printf "[]\\n"; fi\n';
const sha=(text:string|Buffer)=>createHash("sha256").update(text).digest("hex");
function engine(root:string,content=FAKE_ENGINE){const bin=join(root,"fake-impeccable");writeFileSync(bin,content,{mode:0o700});return {bin,version:"0.1.16",sha256:sha(FAKE_ENGINE)};}
const plan={designId:"one",flows:[{id:"add",screen:"today",url:"http://127.0.0.1:3000/",steps:[],expectText:"Ready"}]};
const browser={manifest:"/tools/manifest.json",manifestHash:"a".repeat(64),url:"http://127.0.0.1:3000/",port:9222};
describe("protected design installation",()=>{
  it("installs driver dependencies and separate verifiers, without approving or overwriting",()=>{
    const root=mkdtempSync(join(tmpdir(),"design-install-"));roots.push(root);const store=new ChecksStore(join(root,"project"));
    const input={nodeBin:"/node",scanner:{pin:engine(root),files:["App.tsx"],browser},plan,axeVersion:"4.14.0"};
    const defs=installDesignChecks(store,input);
    expect(Object.keys(defs)).toEqual(["impeccable-source","impeccable-url","design-browser"]);
    expect(existsSync(store.lockPath)).toBe(false);
    const files=store.hashAll();
    for(const file of ["fixtures/design-runtime/lanes/impeccable-driver.ts","design-runtime/lanes/impeccable-verify.ts","fixtures/design-runtime/review/design-browser.ts","design-runtime/review/design-check.ts","fixtures/design-runtime/node_modules/zod/package.json","design-runtime/node_modules/zod/package.json"])expect(files).toHaveProperty(file);
    expect(defs["design-browser"].cases[0]!.command).toContain("$JARVIS_FIXTURES");
    expect(defs["design-browser"].verify).toContain("$JARVIS_CHECKS");
    expect(JSON.parse(readFileSync(join(store.checksDir,"design-plan.json"),"utf8"))).toMatchObject(input.plan);
    expect(JSON.parse(readFileSync(join(store.checksDir,"design-checks.json"),"utf8"))).toEqual(defs);
    expect(()=>installDesignChecks(store,input)).toThrow(/already/);
  });
  it("copies the pinned engine into the protected fixtures, because a gate case can't read the home folder (decision 124)",()=>{
    const root=mkdtempSync(join(tmpdir(),"design-engine-"));roots.push(root);const store=new ChecksStore(join(root,"project"));
    const pin=engine(root);
    installDesignChecks(store,{nodeBin:"/node",scanner:{pin,files:["App.tsx"],browser},plan,axeVersion:"4.14.0"});
    const config=JSON.parse(readFileSync(join(store.checksDir,"fixtures","impeccable.json"),"utf8")) as {pin:{bin:string;version:string;sha256:string}};
    const copy=join(realpathSync(join(store.checksDir,"fixtures")),"design-runtime","impeccable","0.1.16","impeccable");
    expect(config.pin).toEqual({bin:copy,version:"0.1.16",sha256:pin.sha256});
    expect(sha(readFileSync(copy))).toBe(pin.sha256);
    expect(statSync(copy).mode&0o111).not.toBe(0);
    expect(store.hashAll()).toHaveProperty("fixtures/design-runtime/impeccable/0.1.16/impeccable",pin.sha256);
  });
  it("refuses an engine whose bytes differ from the pin and installs nothing",()=>{
    const root=mkdtempSync(join(tmpdir(),"design-engine-bad-"));roots.push(root);const store=new ChecksStore(join(root,"project"));
    const pin={...engine(root,FAKE_ENGINE+"# swapped\n")};
    expect(()=>installDesignChecks(store,{nodeBin:"/node",scanner:{pin,files:["App.tsx"],browser},plan,axeVersion:"4.14.0"})).toThrow(/sha256|hash/);
    expect(existsSync(store.checksDir)&&Object.keys(store.hashAll()).length>0).toBe(false);
    expect(()=>installDesignChecks(store,{nodeBin:"/node",scanner:{pin:{...engine(root),sha256:"bad"},files:["App.tsx"],browser},plan,axeVersion:"4.14.0"})).toThrow();
    expect(()=>installDesignChecks(store,{nodeBin:"/node",scanner:{pin:{...engine(root),bin:"impeccable"},files:["App.tsx"],browser},plan,axeVersion:"4.14.0"})).toThrow();
  });
  it("runs installed source driver and isolated verifier with a fake engine",async()=>{
    const root=mkdtempSync(join(tmpdir(),"design-runtime-"));roots.push(root);const store=new ChecksStore(join(root,"project"));
    installDesignChecks(store,{nodeBin:process.execPath,scanner:{pin:engine(root),files:["App.tsx"],browser},plan,axeVersion:"4.14.0"});
    const common={bin:process.execPath,cwd:root,env:{PATH:"/usr/bin:/bin"},timeoutMs:5000,maxOutputBytes:1024*1024};
    const driverArgs=[join(store.checksDir,"fixtures/design-runtime/lanes/impeccable-driver.ts"),"source",join(store.checksDir,"fixtures/impeccable.json")];
    const driver=await runSession({...common,args:driverArgs});
    expect(driver.code,driver.stderr).toBe(0);expect(JSON.parse(driver.stdout)).toMatchObject({kind:"impeccable-source",result:{status:"pass"}});
    const observations=join(root,"observations");mkdirSync(join(observations,"scan"),{recursive:true});
    writeFileSync(join(observations,"scan/stdout"),driver.stdout);writeFileSync(join(observations,"scan/code"),"0");
    const nonce=join(root,"nonce");writeFileSync(nonce,"fake-nonce");
    const verified=await runSession({...common,env:{...common.env,JARVIS_OUT:observations,JARVIS_COMPLETION_FILE:nonce},args:[join(store.checksDir,"design-runtime/lanes/impeccable-verify.ts"),"source"]});
    expect(verified.code,verified.stderr).toBe(0);expect(verified.stdout.trim()).toBe("JARVIS-CHECK-COMPLETE fake-nonce");
    writeFileSync(join(observations,"scan/code"),"1");
    const failed=await runSession({...common,env:{...common.env,JARVIS_OUT:observations,JARVIS_COMPLETION_FILE:nonce},args:[join(store.checksDir,"design-runtime/lanes/impeccable-verify.ts"),"source"]});
    expect(failed.code).not.toBe(0);expect(failed.stdout).not.toContain("JARVIS-CHECK-COMPLETE");
    // A swapped fixture copy is an error, never a scan.
    writeFileSync(join(store.checksDir,"fixtures/design-runtime/impeccable/0.1.16/impeccable"),FAKE_ENGINE.replace("[]","[{\"antipattern\":\"x\"}]"),{mode:0o700});
    const swapped=await runSession({...common,args:driverArgs});
    expect(JSON.parse(swapped.stdout)).toMatchObject({kind:"impeccable-source",result:{status:"error",error:expect.stringContaining("sha256")}});
  });
});
