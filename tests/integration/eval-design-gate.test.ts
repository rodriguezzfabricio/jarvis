import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runJarvis } from "../../packages/cli/src/eval/jarvis.ts";
import { runLoop } from "../../packages/cli/src/runner/loop.ts";
import { runGate, type GateInput } from "../../packages/cli/src/checks/gate.ts";
import { runSession } from "../../packages/cli/src/proc/session.ts";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { createDesignReviewService, DESIGN_POLICY_HASH, saveDesignCalibration } from "../../packages/cli/src/review/design-service.ts";
import { runServedDesign, type ServedDesignConfig } from "../../packages/cli/src/lanes/served-design.ts";
import { withServedApp } from "../../packages/cli/src/lanes/served-app.ts";
import type { DesignBrowserObservation, DesignBrowserPlan } from "../../packages/cli/src/review/design-browser.ts";
import { addTask, BUG_PROMPT, createEvalFixture, FIXED, markerGate, type EvalFixture } from "../unit/eval-jarvis-fixture.ts";
import { fakeToolchain } from "../fixtures/qa/toolchain.ts";
import { writeFakeClaudeShim } from "./e2e-helpers.ts";
const fixtures:EvalFixture[]=[];
afterEach(()=>fixtures.splice(0).forEach(f=>f.cleanup()));
const sha=(s:string|Buffer)=>createHash("sha256").update(s).digest("hex");
const outcome={code:0,timedOut:false,overflowed:false,stdout:"",stderr:"",durationMs:1};
function observation(plan:DesignBrowserPlan):DesignBrowserObservation {
 // The base revision's own serious finding, kept by the candidate: the gate and the review accept it only through the
 // runner's baseline (decision 125); with strict axe the design review would be an error.
 const flow=plan.flows[0]!, axe={version:"4.10.3",violations:[{id:"color-contrast",impact:"serious",nodes:[{target:[".inherited"]}]}],incomplete:[]};
 const pages=([375,768,1440] as const).map(width=>({width,url:flow.url,flow:flow.id,screen:flow.screen,visibleText:"Jobs",accessibilityTree:"heading Jobs",screenshot:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="}));
 return {kind:"design-browser",capture:{designId:plan.designId,pages,flows:[{id:flow.id,status:"pass"}]},web:[{kind:"qa-browser",url:flow.url,pages:pages.map(p=>({...p,axe,frameCount:1,frameIds:["top"],frames:[{id:"top",url:flow.url,loaderId:"1",axe}]}))}]};
}
it("installs all six checks per eval, captures the base before the fake build, serves fake apps and reports a calibrated design verdict",async()=>{
 const f=createEvalFixture();fixtures.push(f);
 writeFileSync(join(f.sourceRepo,"DESIGN.md"),readFileSync(new URL("../fixtures/qa/DESIGN.md",import.meta.url),"utf8").replace("## Overview","## Overview\nPrinciples: Familiar controls, clear state."));
 writeFileSync(join(f.sourceRepo,"PRODUCT.md"),"A familiar job board.");writeFileSync(join(f.sourceRepo,"app.html"),"<main>Jobs</main>");
 const git=(args:string[])=>safeGit(f.sourceRepo,args,{home:f.home}).toString().trim();git(["add","-A"]);git(["commit","-qm","design references"]);
 const task=addTask(f,"05-citizenship",BUG_PROMPT,{rev:git(["rev-parse","HEAD"])}),dir=join(f.evalsRepo,"tasks",task.id);
 const qa=fakeToolchain(join(f.evalsRepo,"qa-source"));writeFileSync(join(f.evalsRepo,"engine"),"fake engine");
 // Both arms may use identical pinned browser tools; grader assertions remain disjoint.
 cpSync(qa.toolchain.root,join(f.evalsRepo,"hidden",task.id,"checks/fixtures/browser-tools"),{recursive:true});
 writeFileSync(join(dir,"design-lint.json"),JSON.stringify({axeVersion:"4.10.3",designSource:"existing",files:["app.html"],tokenFiles:[]}));
 writeFileSync(join(dir,"design-checks.json"),JSON.stringify({version:1,qa:{source:"qa-source/checks/fixtures/toolchain",manifestSha256:sha(readFileSync(join(qa.toolchain.root,"manifest.json")))},engine:{file:"engine",version:"0.1.16",sha256:sha("fake engine")},scanner:{files:["app.html"],path:"/jobs"},plan:{designId:"jobs",flows:[{id:"jobs",screen:"jobs",url:"/jobs",steps:[],expectText:"Jobs"}]},app:{build:"fake build",serve:"fake serve",readyPath:"/jobs",timeoutMs:1000}}));
 const control=Ledger.open(join(f.jarvisHome,"controls/design"));
 const entry=(fixture:"generic"|"good")=>control.append({kind:"review_result",actor:"runner",data:{reviewer:"design",model:"gpt-6-astra",policyHash:DESIGN_POLICY_HASH,purpose:"calibration",fixture,verdict:fixture==="good"?"pass":"fail",designVerdict:fixture==="good"?"pass":"fail",friction:fixture==="generic"?["launch-tour","multiple-primary","apologetic-error"]:[]}}).hash;
 saveDesignCalibration({jarvisHome:f.jarvisHome,ledger:control,calibration:{generic:entry("generic"),good:entry("good")}});
 const scenario=join(f.root,"scenario.json");writeFileSync(scenario,JSON.stringify({sessions:[{name:"fix",task:"T1",steps:[{write:"src/citizen.mjs",content:FIXED},{result:{subtype:"success",text:"Fixed."}}]}]}));
 const shim=join(f.root,"bin/claude");writeFakeClaudeShim(shim,scenario);
 const events:string[]=[],capturedRepos:string[]=[];
 const gate=(g:GateInput)=>runGate({...g,sandbox:async phase=>{
   if(phase.env.JARVIS_CHECKS) {
     expect(phase.policy.allowLocalBinding).not.toBe(true);
     // Real installed verifiers, on fake observations only; no real browser or service starts.
     return runSession({bin:"/bin/sh",args:["-c",phase.command],cwd:phase.cwd,env:phase.env,timeoutMs:5000,stdoutPath:phase.stdoutPath!,stderrPath:phase.stderrPath!});
   }
   let raw:unknown;
   if(g.check.name==="design-base"||g.check.name==="design-browser"||g.check.name==="impeccable-url") {
     expect(phase.policy.allowLocalBinding).toBe(true);capturedRepos.push(phase.cwd);
     const config=JSON.parse(readFileSync(join(phase.env.JARVIS_FIXTURES!,"design-runtime/served.json"),"utf8")) as ServedDesignConfig;
     raw=await runServedDesign(g.check.name==="impeccable-url"?"url":"capture",config,phase.cwd,{
       serve:(app,repo,capture)=>withServedApp(app,repo,capture,{build:async()=>{events.push(`${g.check.name}:build`);return outcome;},port:async()=>12345,start:async()=>({alive:()=>true,stop:async()=>{events.push(`${g.check.name}:stop`);}}),ready:async()=>true}),
       observe:async plan=>observation(plan),port:async()=>12346,
       scan:async()=>({kind:"impeccable-url",pages:[375,768,1440].map(width=>({width,result:{status:"pass",findings:[]}}))}),
     });
   } else if(g.check.name==="impeccable-source") {expect(phase.policy.allowLocalBinding).toBe(false);raw={kind:"impeccable-source",result:{status:"pass",findings:[]}};}
   else if(g.check.name!=="unit")raw={check:g.check.name,complete:true,findings:[]};
   else raw={unit:"passed"};
   writeFileSync(phase.stdoutPath!,JSON.stringify(raw));writeFileSync(phase.stderrPath!,"");return outcome;
 }});
 const grade=markerGate();
 const result=await runJarvis(task,{evalsRepo:f.evalsRepo,jarvisHome:f.jarvisHome,home:f.home,workRoot:f.workRoot,runId:"design",preflight:async()=>({ok:true}),gate:grade.gate,designGate:gate,
   harnessSeams:{binaryRealpath:()=>"/usr/bin/true",session:async spec=>{events.push("session");return runSession({...spec,bin:shim});}},
   createDesignReview:options=>createDesignReviewService({...options,reviewer:async()=>({reviewer:"codex",model:"gpt-6-astra",rawOutput:"fake model",rawVerdict:JSON.stringify({verdict:"pass",scores:{quality:4,originality:4,craft:4,functionality:4},findings:[]})})}),
   runLoop:async options=>{
     expect(Object.keys(options.checks)).toEqual(expect.arrayContaining(["impeccable-source","impeccable-url","design-browser","ai-tells","token-lint","design-md-lint"]));
     expect(existsSync(join(options.projectDir,"checks/expected/axe-base.json"))).toBe(true);
     return runLoop({...options,gate,footprint:false,review:input=>input.reviewer==="code"?Promise.resolve("pass"):options.review(input)});
   },
 }).catch(error=>{expect.fail(String(error));});
 expect(result.outcome,result.error).toBe("complete");expect(result.grade?.pass).toBe(true);
 expect(events.indexOf("design-base:stop")).toBeLessThan(events.indexOf("session"));
 expect(new Set(capturedRepos).size).toBe(capturedRepos.length);
 expect(result.designReviews).toEqual([expect.objectContaining({status:"pass",counts:true})]);
 expect(JSON.parse(readFileSync(join(result.resultsDir,"summary.json"),"utf8")).designReviews).toEqual(result.designReviews);
 expect(grade.calls.map(g=>g.check.name)).toEqual(["unit"]);
},60_000);
