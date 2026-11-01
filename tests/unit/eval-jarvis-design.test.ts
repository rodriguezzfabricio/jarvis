import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runJarvis, type JarvisEvalOptions, type RunLoopOptions } from "../../packages/cli/src/eval/jarvis.ts";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { createDesignReviewService, DESIGN_POLICY_HASH, saveDesignCalibration, type DesignReviewServiceOptions } from "../../packages/cli/src/review/design-service.ts";
import { addTask, BUG_PROMPT, createEvalFixture, markerGate, type EvalFixture } from "./eval-jarvis-fixture.ts";

const fixtures: EvalFixture[] = [];
afterEach(() => fixtures.splice(0).forEach(f => f.cleanup()));
function setup(design = true, product = true) {
  const f = createEvalFixture(); fixtures.push(f);
  const put = (file: string, text: string) => { const path = join(f.sourceRepo, file); mkdirSync(dirname(path), {recursive:true}); writeFileSync(path, text); };
  if (design) put("DESIGN.md", readFileSync(new URL("../fixtures/qa/DESIGN.md", import.meta.url), "utf8").replace("## Overview", "## Overview\nPrinciples: Familiar controls, clear state."));
  if (product) put("PRODUCT.md", "A familiar job board.");
  put("app.html", "<main>Jobs</main>"); put("design-system/dist/tokens-light.css", ":root { --ink: #123456; }");
  const git = (args: string[]) => safeGit(f.sourceRepo, args, { home: f.home }).toString().trim();
  git(["add", "-A"]); git(["commit", "-qm", "design reference"]);
  const task = addTask(f, "05-citizenship", BUG_PROMPT, {rev:git(["rev-parse", "HEAD"])});
  writeFileSync(join(f.evalsRepo, "tasks", task.id, "design-lint.json"), JSON.stringify({axeVersion:"4.14.0",designSource:"existing",files:["app.html", "design-system/dist/tokens-light.css"],tokenFiles:["design-system/dist/tokens-light.css"]}));
  const gate = join(f.evalsRepo, "hidden", task.id, "gate");
  writeFileSync(join(gate, "design-plan.json"), JSON.stringify({designId:"jobs",flows:[{id:"jobs",screen:"jobs",url:"http://127.0.0.1:3000/jobs",steps:[],expectText:"Jobs"}]}));
  const browser = {name:"design-browser",cases:[{id:"capture",command:"capture-approved"}],verify:"verify-approved",timeoutMs:1000};
  writeFileSync(join(gate, "design-checks.json"), JSON.stringify({"design-browser":browser}));
  const options: JarvisEvalOptions = {preflight:async()=>({ok:true}),evalsRepo:f.evalsRepo,jarvisHome:f.jarvisHome,workRoot:f.workRoot,home:f.home,gate:markerGate().gate,harness:{runTask:async()=>{throw Error("unexpected session");}},runLoop:async()=>({status:"complete",done:[],blocked:[]})};
  return {f,task,options};
}
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
    const planned = Ledger.open(loop.projectDir).entries().find(e => e.kind === "task_created")!.data as {requiredReviews:string[];requiredChecks:string[]};
    expect(planned.requiredReviews).toContain("design");
    expect(planned.requiredChecks).toEqual(expect.arrayContaining(["impeccable-source","impeccable-url","design-browser","ai-tells","token-lint","design-md-lint"]));
    expect(Object.keys(loop.checks)).toEqual(expect.arrayContaining(["unit","ai-tells","token-lint","design-md-lint"]));
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
  const s=setup(false), createDesignReview=vi.fn((options: DesignReviewServiceOptions) => createDesignReviewService(options));
  let called=false;
  const result=await runJarvis(s.task,{...s.options,createDesignReview,runLoop:async loop=>{
    called=true; writeFileSync(join(loop.repoPath,"DESIGN.md"),"dirty file");
    expect(createDesignReview).not.toHaveBeenCalled();
    expect(await loop.review({taskId:"T1",attemptId:"a1",revision:"a".repeat(40),reviewer:"design"})).toEqual({status:"error",recorded:true});
    return {status:"blocked",done:[],blocked:["T1"]};
  }});
  expect(called).toBe(true); expect(result.outcome).toBe("blocked");
});
it.each(["missing-product","missing-calibration"])("records a design infrastructure error for %s with no counted verdict", async fault=>{
  const s=setup(true,fault!=="missing-product"); let called=false;
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
it("rejects invalid runner lint scope rather than approving a partial install", async()=>{
  const s=setup();
  writeFileSync(join(s.f.evalsRepo,"tasks",s.task.id,"design-lint.json"),JSON.stringify({axeVersion:"4.14.0",designSource:"existing",files:["../escape"],tokenFiles:[]}));
  const runLoop=vi.fn(s.options.runLoop);
  await expect(runJarvis(s.task,{...s.options,runLoop})).rejects.toThrow(/scope|path|input|Invalid/);
  expect(runLoop).not.toHaveBeenCalled();
});
