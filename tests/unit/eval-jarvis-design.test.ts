import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { plannerPrompt, runJarvis, type JarvisEvalOptions, type RunLoopOptions } from "../../packages/cli/src/eval/jarvis.ts";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { createDesignReviewService, DESIGN_POLICY_HASH, saveDesignCalibration, type DesignReviewServiceOptions } from "../../packages/cli/src/review/design-service.ts";
import { addTask, BUG_PROMPT, createEvalFixture, markerGate, type EvalFixture } from "./eval-jarvis-fixture.ts";

const fixtures: EvalFixture[] = [];
afterEach(() => fixtures.splice(0).forEach(f => f.cleanup()));
/**
 * design: the snapshot commits DESIGN.md; declared: the evals repo gives the task a design-lint.json (a design task,
 * decision 162); installed: the hidden gate carries the protected Impeccable and browser definitions.
 */
function setup({ design = true, product = true, declared = true, installed = true } = {}) {
  const f = createEvalFixture(); fixtures.push(f);
  const put = (file: string, text: string) => { const path = join(f.sourceRepo, file); mkdirSync(dirname(path), {recursive:true}); writeFileSync(path, text); };
  if (design) put("DESIGN.md", readFileSync(new URL("../fixtures/qa/DESIGN.md", import.meta.url), "utf8").replace("## Overview", "## Overview\nPrinciples: Familiar controls, clear state."));
  if (product) put("PRODUCT.md", "A familiar job board.");
  put("app.html", "<main>Jobs</main>"); put("design-system/dist/tokens-light.css", ":root { --ink: #123456; }");
  const git = (args: string[]) => safeGit(f.sourceRepo, args, { home: f.home }).toString().trim();
  git(["add", "-A"]); git(["commit", "-qm", "design reference"]);
  const task = addTask(f, "05-citizenship", BUG_PROMPT, {rev:git(["rev-parse", "HEAD"])});
  if (declared) writeFileSync(join(f.evalsRepo, "tasks", task.id, "design-lint.json"), JSON.stringify({axeVersion:"4.14.0",designSource:"existing",files:["app.html", "design-system/dist/tokens-light.css"],tokenFiles:["design-system/dist/tokens-light.css"]}));
  const gate = join(f.evalsRepo, "hidden", task.id, "gate");
  writeFileSync(join(gate, "design-plan.json"), JSON.stringify({designId:"jobs",flows:[{id:"jobs",screen:"jobs",url:"http://127.0.0.1:3000/jobs",steps:[],expectText:"Jobs"}]}));
  const definitions = Object.fromEntries(["impeccable-source", "impeccable-url", "design-browser"].map(name => [name, {name,cases:[{id:"scan",command:`approved ${name} case`}],verify:`approved ${name} verify`,timeoutMs:1000}]));
  writeFileSync(join(gate, "design-checks.json"), JSON.stringify(definitions));
  if (installed) for (const [name, definition] of Object.entries(definitions)) writeFileSync(join(gate, `${name}.check.json`), JSON.stringify(definition));
  const options: JarvisEvalOptions = {preflight:async()=>({ok:true}),evalsRepo:f.evalsRepo,jarvisHome:f.jarvisHome,workRoot:f.workRoot,home:f.home,gate:markerGate().gate,harness:{runTask:async()=>{throw Error("unexpected session");}},runLoop:async()=>({status:"complete",done:[],blocked:[]})};
  return {f,task,options};
}
const planned = (loop: RunLoopOptions) => Ledger.open(loop.projectDir).entries().find(e => e.kind === "task_created")!.data as {requiredReviews:string[];requiredChecks:string[]};
const DESIGN_CHECKS = ["impeccable-source","impeccable-url","design-browser","ai-tells","token-lint","design-md-lint"];

it("composes design from the committed run branch, installs existing-system lint without generated tokens, and dispatches its recorded verdict", async () => {
  const s = setup(); let designOptions: DesignReviewServiceOptions | undefined;
  const detailed = vi.fn(async () => ({verdict:"fail" as const, designVerdict:"fail" as const, counts:true, findings:[],
    entry: designOptions!.ledger.append({kind:"review_result",actor:"runner",data:{reviewer:"design",status:"fail"}})}));
  const createDesignReview = vi.fn((options: DesignReviewServiceOptions) => { designOptions = options; return {reviewDetailed:detailed}; });
  let called = false;
  const runLoop = async (loop: RunLoopOptions) => {
    called = true;
    expect(createDesignReview).toHaveBeenCalledOnce();
    expect(designOptions).toMatchObject({home:s.f.home,jarvisHome:s.f.jarvisHome,projectDir:loop.projectDir});
    expect(planned(loop).requiredReviews).toContain("design");
    expect(planned(loop).requiredChecks).toEqual(expect.arrayContaining(DESIGN_CHECKS));
    expect(Object.keys(loop.checks)).toEqual(expect.arrayContaining(["unit", ...DESIGN_CHECKS]));
    const store = new ChecksStore(loop.projectDir), ledger = Ledger.open(loop.projectDir);
    expect(store.verify(ledger).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(store.checksDir,"fixtures/design-lint/config.json"),"utf8")).files).toEqual(["app.html"]);
    // A dirty builder copy cannot supply material.
    writeFileSync(join(loop.repoPath,"DESIGN.md"),"CANDIDATE INSTRUCTIONS");
    const request = {taskId:"T1",attemptId:"a1",revision:"a".repeat(40),reviewer:"design"};
    const material = await designOptions!.resolveMaterial(request);
    expect(material).toMatchObject({designSource:"existing",product:"A familiar job board.",axeVersion:"4.14.0"});
    expect(material.design).not.toContain("CANDIDATE INSTRUCTIONS");
    expect(Object.keys(material.checks)).toContain("token-lint");
    expect(await loop.review(request)).toEqual({status:"fail",recorded:true});
    expect(detailed).toHaveBeenCalledOnce();
    expect(await loop.review({...request,reviewer:"unknown"})).toEqual({status:"error",recorded:true});
    expect(detailed).toHaveBeenCalledOnce();
    writeFileSync(join(store.checksDir,"design-review.json"), '{"designSource":"new"}');
    await expect(designOptions!.resolveMaterial(request)).rejects.toThrow(/approved/);
    return {status:"blocked" as const,done:[],blocked:["T1"]};
  };
  const result = await runJarvis(s.task,{...s.options,runLoop,createDesignReview});
  expect(called).toBe(true); expect(result.error).toBeUndefined(); expect(result.outcome).toBe("blocked");
});
it("does not compose design from an uncommitted DESIGN.md or from configuration alone", async () => {
  const s=setup({design:false,declared:false}), createDesignReview=vi.fn((options: DesignReviewServiceOptions) => createDesignReviewService(options));
  let called=false;
  const result=await runJarvis(s.task,{...s.options,createDesignReview,runLoop:async loop=>{
    called=true; writeFileSync(join(loop.repoPath,"DESIGN.md"),"dirty file");
    expect(createDesignReview).not.toHaveBeenCalled();
    expect(await loop.review({taskId:"T1",attemptId:"a1",revision:"a".repeat(40),reviewer:"design"})).toEqual({status:"error",recorded:true});
    return {status:"blocked",done:[],blocked:["T1"]};
  }});
  expect(called).toBe(true); expect(result.outcome).toBe("blocked");
});
// A design task can never finish on code review alone: without its committed reference or its protected checks
// it is refused before any session, so it neither spends usage nor reads as done (decision 162).
it.each([
  ["no committed DESIGN.md", {design:false}, /design task .* needs a committed DESIGN\.md/],
  ["no protected Impeccable or browser checks", {installed:false}, /design task needs the protected design checks installed; missing impeccable-source, impeccable-url, design-browser/],
])("refuses a declared design task with %s before any session", async (_label, knobs, message) => {
  const s=setup(knobs), runLoop=vi.fn(s.options.runLoop), runTask=vi.fn(s.options.harness!.runTask);
  await expect(runJarvis(s.task,{...s.options,runLoop,harness:{runTask}})).rejects.toThrow(message);
  expect(runLoop).not.toHaveBeenCalled(); expect(runTask).not.toHaveBeenCalled();
});
it("leaves an undeclared task's plan alone when its branch has DESIGN.md", async () => {
  const s=setup({declared:false,installed:false}), createDesignReview=vi.fn((options: DesignReviewServiceOptions) => createDesignReviewService(options));
  let called=false;
  await runJarvis(s.task,{...s.options,createDesignReview,runLoop:async loop=>{
    called=true;
    expect(planned(loop).requiredReviews).toEqual(["code"]);
    expect(planned(loop).requiredChecks).toEqual(["unit"]);
    expect(Object.keys(loop.checks)).not.toContain("ai-tells");
    return {status:"complete",done:["T1"],blocked:[]};
  }});
  expect(called).toBe(true);
  // Composed as `jarvis run` composes it (decision 156), so a plan that asks for a design review gets the real service.
  expect(createDesignReview).toHaveBeenCalledOnce();
});
it("tells the planner about the design gates only on a design task", () => {
  const checks = {dir:"/checks",checks:{unit:{name:"unit",cases:[{id:"u",command:"node --test"}],verify:"v",timeoutMs:1}},criteria:{unit:[]}};
  const input = {request:"r",specPath:"docs/spec/v1.md",checks,maxTurns:5};
  expect(plannerPrompt({...input,design:true})).toMatch(/six protected design checks and a design review/);
  expect(plannerPrompt(input)).not.toMatch(/design/);
});
it.each(["missing-product","missing-calibration"])("records a design infrastructure error for %s with no counted verdict", async fault=>{
  const s=setup({product:fault!=="missing-product"}); let called=false;
  if (fault === "missing-product") {
    const ledger = Ledger.open(join(s.f.jarvisHome,"controls","design"));
    const entry = (fixture: "generic" | "good") => ledger.append({kind:"review_result",actor:"runner",data:{reviewer:"design",model:"gpt-6-astra",policyHash:DESIGN_POLICY_HASH,purpose:"calibration",fixture,verdict:fixture==="generic"?"fail":"pass",designVerdict:fixture==="generic"?"fail":"pass",friction:fixture==="generic"?["launch-tour","multiple-primary","apologetic-error"]:[]}}).hash;
    saveDesignCalibration({jarvisHome:s.f.jarvisHome,ledger,calibration:{generic:entry("generic"),good:entry("good")}});
  }
  const result=await runJarvis(s.task,{...s.options,runLoop:async loop=>{
    called=true;
    const result=await loop.review({taskId:"T1",attemptId:"a1",revision:"a".repeat(40),reviewer:"design"});
    expect(result).toEqual({status:"error",recorded:true});
    const entries=Ledger.open(loop.projectDir).entries().filter(e=>e.kind==="review_result");
    expect(entries).toHaveLength(1); expect(entries[0]!.data).toMatchObject({reviewer:"design",status:"error",counts:false});
    expect(JSON.stringify(entries)).toContain(fault === "missing-product" ? "PRODUCT.md" : "negative control");
    return {status:"blocked",done:[],blocked:["T1"]};
  }});
  expect(called).toBe(true); expect(result.error).toBeUndefined(); expect(result.outcome).toBe("blocked");
});
it("rejects invalid runner lint scope before the preflight rather than approving a partial install", async()=>{
  const s=setup();
  writeFileSync(join(s.f.evalsRepo,"tasks",s.task.id,"design-lint.json"),JSON.stringify({axeVersion:"4.14.0",designSource:"existing",files:["../escape"],tokenFiles:[]}));
  const runLoop=vi.fn(s.options.runLoop), preflight=vi.fn(s.options.preflight);
  await expect(runJarvis(s.task,{...s.options,runLoop,preflight})).rejects.toThrow(/scope|path|input|Invalid/);
  expect(runLoop).not.toHaveBeenCalled(); expect(preflight).not.toHaveBeenCalled();
});
