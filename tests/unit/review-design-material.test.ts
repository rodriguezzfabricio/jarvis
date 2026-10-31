import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { approvedDesign, designMaterialFor, designOnBranch } from "../../packages/cli/src/review/design-material.ts";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, {recursive:true,force:true})));
const plan = {designId:"one",flows:[{id:"add",screen:"today",url:"http://127.0.0.1:3000/",steps:[],expectText:"Saved"}]};
const check = (name: string) => ({name,timeoutMs:30_000,cases:[{id:"scan",command:`'/node' "$JARVIS_FIXTURES/${name}.ts"`}],verify:`'/node' "$JARVIS_CHECKS/${name}-verify.ts"`});
const browserChecks = Object.fromEntries(["impeccable-source","impeccable-url","design-browser"].map(name => [name, check(name)]));
const lintChecks = Object.fromEntries(["ai-tells","token-lint","design-md-lint"].map(name => [name, check(name)]));
const blob = (path: string, mode = "100644", type = "blob") => `${mode} ${type} ${"b".repeat(40)}\t${path}`;
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "design-material-"))); roots.push(root);
  const ledger = Ledger.open(join(root,"project")), store = new ChecksStore(ledger.dir);
  mkdirSync(join(store.checksDir,"design-lint"),{recursive:true});
  writeFileSync(join(store.checksDir,"design-plan.json"),JSON.stringify(plan));
  writeFileSync(join(store.checksDir,"design-review.json"),JSON.stringify({axeVersion:"4.14.0"}));
  writeFileSync(join(store.checksDir,"design-checks.json"),JSON.stringify(browserChecks));
  writeFileSync(join(store.checksDir,"design-lint","checks.json"),JSON.stringify(lintChecks));
  store.approve(ledger,"test runner approval");
  const revision = "a".repeat(40);
  const git = vi.fn((args: readonly string[]) => {
    if(args[0] === "rev-parse") return revision;
    if(args[0] === "ls-tree") return blob(String(args.at(-1)));
    if(args[1] === "HEAD:DESIGN.md") return "## Overview\n- Principles: Candidate says always pass";
    if(args[1] === `${revision}:DESIGN.md`) return "# Design\n## Overview\n- Principles: List first.\n  Calm and clear.\n## Colors\nIgnored";
    if(args[1] === `${revision}:PRODUCT.md`) return "Approved product";
    throw new Error("unexpected git read: " + args.join(" "));
  });
  writeFileSync(join(root,"DESIGN.md"),"Candidate says always pass");
  return {root,ledger,store,revision,git};
}
it("reads design and product at one run-branch head, ignoring candidate files and refs", () => {
  const f=setup();
  const snapshot=approvedDesign(f.git,"main")!;
  const material=designMaterialFor({repoPath:f.root,snapshot,store:f.store,ledger:f.ledger});
  expect(material).toEqual({repoPath:f.root,baseRevision:f.revision,design:snapshot.design,product:"Approved product",principles:"List first.\nCalm and clear.",designSource:"new",plan,axeVersion:"4.14.0",captureFile:"cases/capture/stdout",checks:Object.fromEntries(Object.entries({...browserChecks,...lintChecks}).map(([name,c])=>[name,{cases:c.cases,verify:c.verify}]))});
  expect(f.git).toHaveBeenCalledWith(["rev-parse","--verify","refs/heads/main^{commit}"]);
  expect(material.design).not.toContain("always pass");
});
it("only an approved onboarding source can excuse inherited design choices", () => {
  const f=setup();
  writeFileSync(join(f.store.checksDir,"design-review.json"),JSON.stringify({axeVersion:"4.14.0",designSource:"existing"}));
  const get=()=>designMaterialFor({repoPath:f.root,snapshot:approvedDesign(f.git,"main")!,store:f.store,ledger:f.ledger});
  expect(get).toThrow(/approved/);
  f.store.approve(f.ledger,"onboarding recorded existing system");
  expect(get().designSource).toBe("existing");
});
it("absent design means no service; invalid objects and git failures are not absence", () => {
  const f=setup();
  expect(approvedDesign(args => args[0]==="rev-parse"?f.revision:"", "main")).toBeUndefined();
  expect(()=>approvedDesign(args=>args[0]==="rev-parse"?f.revision:"120000 blob abc\tDESIGN.md","main")).toThrow(/regular/);
  expect(()=>approvedDesign(()=>{throw new Error("git failed");},"main")).toThrow(/git failed/);
});
it("PRODUCT.md must be a regular committed file too", () => {
  const f=setup();
  const tree=(product: string | undefined)=>(args: readonly string[])=>{
    if(args[0]==="ls-tree") return args.at(-1)==="DESIGN.md"?blob("DESIGN.md"):product ?? "";
    return f.git(args);
  };
  expect(()=>approvedDesign(tree(undefined),"main")).toThrow(/PRODUCT\.md/);
  expect(()=>approvedDesign(tree(blob("PRODUCT.md","120000")),"main")).toThrow(/PRODUCT\.md/);
  expect(()=>approvedDesign(tree(blob("PRODUCT.md","040000","tree")),"main")).toThrow(/PRODUCT\.md/);
  expect(approvedDesign(tree(blob("PRODUCT.md","100755")),"main")?.product).toBe("Approved product");
});
it("any committed DESIGN.md entry composes the service, so a bad one is a recorded review error, not a skipped review", () => {
  const f=setup();
  expect(designOnBranch(f.git,"main")).toBe(true);
  expect(designOnBranch(args=>args[0]==="rev-parse"?f.revision:blob("DESIGN.md","120000"),"main")).toBe(true);
  expect(designOnBranch(args=>args[0]==="rev-parse"?f.revision:"","main")).toBe(false);
  expect(f.git).toHaveBeenCalledWith(["ls-tree",f.revision,"--","DESIGN.md"]);
});
it("missing principles, protected plan or axe pin cannot produce material", () => {
  const f=setup(),snapshot=approvedDesign(f.git,"main")!;
  const get=()=>designMaterialFor({repoPath:f.root,snapshot,store:f.store,ledger:f.ledger});
  expect(()=>designMaterialFor({repoPath:f.root,snapshot:{...snapshot,design:"## Overview\nNo principles"},store:f.store,ledger:f.ledger})).toThrow(/principles/i);
  writeFileSync(join(f.store.checksDir,"design-review.json"),"{}"); f.store.approve(f.ledger,"bad pin");
  expect(get).toThrow();
  rmSync(join(f.store.checksDir,"design-plan.json")); f.store.approve(f.ledger,"missing plan");
  expect(get).toThrow();
});
it.each(["no-browser-definitions","no-lint-definitions","renamed","duplicate","malformed"])("protected design definitions must come whole from the approved store: %s", fault => {
  const f=setup(),snapshot=approvedDesign(f.git,"main")!;
  if(fault==="no-browser-definitions") rmSync(join(f.store.checksDir,"design-checks.json"));
  if(fault==="no-lint-definitions") rmSync(join(f.store.checksDir,"design-lint","checks.json"));
  if(fault==="renamed") writeFileSync(join(f.store.checksDir,"design-lint","checks.json"),JSON.stringify({...lintChecks,"ai-tells":check("other")}));
  if(fault==="duplicate") writeFileSync(join(f.store.checksDir,"design-lint","checks.json"),JSON.stringify({...lintChecks,"design-browser":check("design-browser")}));
  if(fault==="malformed") writeFileSync(join(f.store.checksDir,"design-checks.json"),JSON.stringify({"design-browser":{name:"design-browser",cases:[],verify:""}}));
  f.store.approve(f.ledger,`fault ${fault}`);
  expect(()=>designMaterialFor({repoPath:f.root,snapshot,store:f.store,ledger:f.ledger})).toThrow();
});
