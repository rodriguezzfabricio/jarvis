import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { approvedDesign, designMaterialFor } from "../../packages/cli/src/review/design-material.ts";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, {recursive:true,force:true})));
const plan = {designId:"one",flows:[{id:"add",screen:"today",url:"http://127.0.0.1:3000/",steps:[],expectText:"Saved"}]};
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "design-material-"))); roots.push(root);
  const ledger = Ledger.open(join(root,"project")), store = new ChecksStore(ledger.dir);
  mkdirSync(store.checksDir);
  writeFileSync(join(store.checksDir,"design-plan.json"),JSON.stringify(plan));
  writeFileSync(join(store.checksDir,"design-review.json"),JSON.stringify({axeVersion:"4.14.0"}));
  store.approve(ledger,"test runner approval");
  const revision = "a".repeat(40);
  const git = vi.fn((args: readonly string[]) => {
    if(args[0] === "rev-parse") return revision;
    if(args[0] === "ls-tree") return "100644 blob " + "b".repeat(40) + "\tDESIGN.md";
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
  expect(material).toEqual({repoPath:f.root,baseRevision:f.revision,design:snapshot.design,product:"Approved product",principles:"List first.\nCalm and clear.",designSource:"new",plan,axeVersion:"4.14.0",captureFile:"cases/capture/stdout"});
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
it("missing principles, protected plan or axe pin cannot produce material", () => {
  const f=setup(),snapshot=approvedDesign(f.git,"main")!;
  const get=()=>designMaterialFor({repoPath:f.root,snapshot,store:f.store,ledger:f.ledger});
  expect(()=>designMaterialFor({repoPath:f.root,snapshot:{...snapshot,design:"## Overview\nNo principles"},store:f.store,ledger:f.ledger})).toThrow(/principles/i);
  writeFileSync(join(f.store.checksDir,"design-review.json"),"{}"); f.store.approve(f.ledger,"bad pin");
  expect(get).toThrow();
  rmSync(join(f.store.checksDir,"design-plan.json")); f.store.approve(f.ledger,"missing plan");
  expect(get).toThrow();
});
