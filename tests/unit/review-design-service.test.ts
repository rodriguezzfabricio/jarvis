import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { createDesignReviewService, DESIGN_POLICY_HASH, saveDesignCalibration } from "../../packages/cli/src/review/design-service.ts";
import type { ReviewGit } from "../../packages/cli/src/review/workspace.ts";
const roots: string[]=[];
afterEach(()=>{ for(const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
const sha=(raw:string)=>createHash("sha256").update(raw).digest("hex");
const good={verdict:"pass",scores:{quality:4,originality:4,craft:4,functionality:4},findings:[]};
const CHECKS=["impeccable-source","impeccable-url","ai-tells","token-lint","design-md-lint","design-browser"] as const;
function fixture() {
  const root=mkdtempSync(join(tmpdir(),"design-service-"));roots.push(root);
  const projectDir=join(root,"project"),workRoot=join(root,"work");mkdirSync(workRoot);
  const ledger=Ledger.open(projectDir);
  const request={taskId:"t",attemptId:"a",revision:"a".repeat(40)};
  const plan={designId:"one",flows:[{id:"add",screen:"today",url:"http://127.0.0.1:3000/",steps:[],expectText:"Saved"}]};
  const pages=([375,768,1440] as const).map(width=>({flow:"add",screen:"today",width,url:plan.flows[0]!.url,visibleText:"Saved",accessibilityTree:"button Add",screenshot:Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64").toString("base64")}));
  const axe={version:"4.14.0",violations:[],incomplete:[]};
  const capture={kind:"design-browser",capture:{designId:"one",pages,flows:[{id:"add",status:"pass"}]},web:[{kind:"qa-browser",url:plan.flows[0]!.url,pages:pages.map(p=>({...p,axe,frameCount:1,frameIds:["top"],frames:[{id:"top",url:p.url,loaderId:"1",axe}]}))}]};
  const evidenceDir=join(projectDir,"evidence","capture");mkdirSync(evidenceDir,{recursive:true});
  const file=join(evidenceDir,"stdout");const raw=JSON.stringify(capture);writeFileSync(file,raw);
  // The runner's protected definitions; a gate_result counts as design evidence only when it ran exactly these.
  const defs=Object.fromEntries(CHECKS.map(check=>[check,{cases:[{id:"scan",command:`'/node' "$JARVIS_FIXTURES/protected/${check}.ts"`}],verify:`'/node' "$JARVIS_CHECKS/protected/${check}-verify.ts"`}]));
  for(const check of CHECKS) ledger.append({kind:"gate_result",actor:"runner",task_id:"t",attempt_id:"a",data:{check,revision:request.revision,...defs[check],status:"pass",evidence:{dir:evidenceDir,files:{stdout:sha(raw)}}}});
  const reviewer=vi.fn(async ()=>({reviewer:"codex" as const,model:"gpt-6-astra",rawOutput:"fake trace",rawVerdict:JSON.stringify(good)}));
  const git:ReviewGit=(_cwd,args)=>{
    if(args.includes("clone")) {mkdirSync(String(args.at(-1)));writeFileSync(join(String(args.at(-1)),"app.tsx"),"fake app");}
    return Buffer.from(args.includes("rev-parse")?request.revision:"");
  };
  const options={ledger,projectDir,workRoot,home:root,git,reviewer,resolveMaterial:async()=>({repoPath:join(root,"repo"),baseRevision:"b".repeat(40),principles:"List first",designSource:"new" as const,design:"tokens",product:"habits",plan,axeVersion:"4.14.0",captureFile:"stdout",checks:defs})};
  const calibration=(label:"generic"|"good")=>ledger.append({kind:"review_result",actor:"runner",data:{reviewer:"design",model:"gpt-6-astra",purpose:"calibration",fixture:label,policyHash:DESIGN_POLICY_HASH,verdict:label==="generic"?"fail":"pass",designVerdict:label==="generic"?"fail":"pass",findings:label==="generic"?["launch-tour","multiple-primary","apologetic-error"].map(principle=>({principle})):[],friction:label==="generic"?["launch-tour","multiple-primary","apologetic-error"]:[]}}).hash;
  // A control that did not hold: the generic review missed a friction rule, or the good fixture failed.
  const failedCalibration=(label:"generic"|"good")=>ledger.append({kind:"review_result",actor:"runner",data:{reviewer:"design",model:"gpt-6-astra",purpose:"calibration",fixture:label,policyHash:DESIGN_POLICY_HASH,verdict:"fail",designVerdict:"fail",findings:[],friction:label==="generic"?["launch-tour"]:[]}}).hash;
  return {options,request,reviewer,file,ledger,root,calibration,failedCalibration,defs,evidenceDir,raw,service:createDesignReviewService(options)};
}
const JWT="eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
const TOKEN="sk_live_4eC39HqLyjWDarjtT1zdp7dcAbCdEfGh12";
describe("runner material",()=>{
  it("refuses material that doesn't say where DESIGN.md came from, before any reviewer runs",async()=>{
    const f=fixture();
    const material=await f.options.resolveMaterial();
    const service=createDesignReviewService({...f.options,resolveMaterial:async()=>({...material,designSource:undefined as never})});
    const result=await service.reviewDetailed(f.request,{fixture:"good"});
    expect(result.verdict).toBe("error");expect(result.error).toMatch(/design source/);
    expect(f.reviewer).not.toHaveBeenCalled();
  });
});
describe("reviewer text reaching the ledger (decision 110: findings stay redacted)",()=>{
  it("redacts every reviewer-written finding field before the ledger and the caller see it",async()=>{
    const f=fixture();
    const finding={screen:`today ${TOKEN}`,element:`button ${JWT}`,principle:"launch-tour",severity:"high",explanation:`auth.json says ${JWT}`,fix:`remove ${TOKEN}`};
    f.reviewer.mockResolvedValue({reviewer:"codex",model:"gpt-6-astra",rawOutput:"trace",rawVerdict:JSON.stringify({...good,verdict:"fail",findings:[finding]})});
    const result=await f.service.reviewDetailed(f.request,{fixture:"generic"});
    const recorded=JSON.stringify(f.ledger.entries().at(-1)!.data);
    expect(recorded).not.toContain(JWT);expect(recorded).not.toContain(TOKEN);
    expect(recorded).toContain("[redacted:sha256:");
    expect(JSON.stringify(result.findings)).not.toContain(JWT);expect(JSON.stringify(result.findings)).not.toContain(TOKEN);
    expect(result.findings[0]!.principle).toBe("launch-tour");
  });
  it("records the friction rules a finding named from the unredacted principle, and calibrates from that record",async()=>{
    const f=fixture();
    const long=(rule:string)=>({screen:"today",element:"main",principle:`ux-checklist/${rule}-applies-on-every-first-run-screen`,severity:"high",explanation:"x",fix:"y"});
    f.reviewer.mockResolvedValue({reviewer:"codex",model:"gpt-6-astra",rawOutput:"trace",rawVerdict:JSON.stringify({...good,verdict:"fail",findings:["launch-tour","multiple-primary","apologetic-error"].map(long)})});
    const generic=await f.service.reviewDetailed(f.request,{fixture:"generic"});
    const data=generic.entry.data as {friction:string[];findings:{principle:string}[]};
    expect(data.friction).toEqual(["launch-tour","multiple-primary","apologetic-error"]);
    expect(data.findings.every(x=>x.principle.includes("[redacted:sha256:"))).toBe(true);
    const service=createDesignReviewService({...f.options,calibration:{generic:generic.entry.hash,good:f.calibration("good")}});
    f.reviewer.mockResolvedValue({reviewer:"codex",model:"gpt-6-astra",rawOutput:"trace",rawVerdict:JSON.stringify(good)});
    expect((await service.reviewDetailed(f.request)).verdict).toBe("pass");
  });
  it("does not calibrate from principles alone without the runner's friction record",async()=>{
    const f=fixture();
    const generic=f.ledger.append({kind:"review_result",actor:"runner",data:{reviewer:"design",model:"gpt-6-astra",purpose:"calibration",fixture:"generic",policyHash:DESIGN_POLICY_HASH,designVerdict:"fail",verdict:"fail",findings:["launch-tour","multiple-primary","apologetic-error"].map(principle=>({principle}))}}).hash;
    const service=createDesignReviewService({...f.options,calibration:{generic,good:f.calibration("good")}});
    expect((await service.reviewDetailed(f.request)).verdict).toBe("error");expect(f.reviewer).not.toHaveBeenCalled();
  });
});
describe("revision-bound design review",()=>{
  it("calibrates one design per fresh call and never counts calibration as a gate",async()=>{
    const f=fixture();const result=await f.service.reviewDetailed(f.request,{fixture:"good"});
    expect(result.verdict, result.error).toBe("pass");expect(result.counts).toBe(false);
    expect(f.reviewer).toHaveBeenCalledOnce();
    const input=f.reviewer.mock.calls[0] as unknown as [{images:string[];prompt:string}];
    expect(input[0].images).toHaveLength(3);expect(input[0].prompt).toContain("List first");
    expect(f.ledger.entries().at(-1)!.data).toMatchObject({reviewer:"design",revision:f.request.revision,purpose:"calibration",fixture:"good"});
  });
  it("requires current calibration before a verdict can count, then records a pass",async()=>{
    const f=fixture();expect((await f.service.reviewDetailed(f.request)).verdict).toBe("error");expect(f.reviewer).not.toHaveBeenCalled();
    const service=createDesignReviewService({...f.options,calibration:{generic:f.calibration("generic"),good:f.calibration("good")}});
    const result=await service.reviewDetailed(f.request);expect(result.verdict, result.error).toBe("pass");expect(result.counts).toBe(true);
  });
  it.each(["tamper","wrong-revision","missing-check","error-output","invalid-output","throw"])("refuses %s without turning infrastructure into a design failure",async fault=>{
    const f=fixture();
    if(fault==="tamper")writeFileSync(f.file,readFileSync(f.file,"utf8")+" ");
    if(fault==="wrong-revision")f.request.revision="c".repeat(40);
    if(fault==="missing-check")f.options.ledger.append({kind:"gate_result",actor:"runner",task_id:"t",attempt_id:"a",data:{revision:f.request.revision,check:"ai-tells",status:"error"}});
    if(fault==="error-output")f.reviewer.mockResolvedValue({...await f.reviewer(),error:"usage limit"} as never);
    if(fault==="invalid-output")f.reviewer.mockResolvedValue({...await f.reviewer(),rawVerdict:"{}"});
    if(fault==="throw")f.reviewer.mockRejectedValue(new Error("spawn failed"));
    const result=await f.service.reviewDetailed(f.request,{fixture:"good"});
    expect(result.verdict).toBe("error");expect(result.counts).toBe(false);expect(result.error).toBeTruthy();
  });
  it("does not calibrate from a good-model verdict when its code checks failed",async()=>{
    const f=fixture();
    const generic=f.calibration("generic");
    const goodEntry=f.ledger.append({kind:"review_result",actor:"runner",data:{reviewer:"design",model:"gpt-6-astra",purpose:"calibration",fixture:"good",policyHash:DESIGN_POLICY_HASH,designVerdict:"pass",verdict:"fail",findings:[]}});
    const service=createDesignReviewService({...f.options,calibration:{generic,good:goodEntry.hash}});
    expect((await service.reviewDetailed(f.request)).verdict).toBe("error");
    expect(f.reviewer).not.toHaveBeenCalled();
  });
  it("requires all three friction findings in generic calibration",async()=>{
    const f=fixture();
    // The runner's friction record names only two of the three planted choices.
    const generic=f.ledger.append({kind:"review_result",actor:"runner",data:{reviewer:"design",model:"gpt-6-astra",purpose:"calibration",fixture:"generic",policyHash:DESIGN_POLICY_HASH,designVerdict:"fail",verdict:"fail",findings:[],friction:["launch-tour","multiple-primary"]}}).hash;
    const service=createDesignReviewService({...f.options,calibration:{generic,good:f.calibration("good")}});
    expect((await service.reviewDetailed(f.request)).verdict).toBe("error");expect(f.reviewer).not.toHaveBeenCalled();
  });
  it("a model pass cannot override a completed failing code check",async()=>{
    const f=fixture();const old=f.ledger.entries().find(e=>(e.data as {check?:string}).check==="ai-tells")!;
    f.ledger.append({kind:"gate_result",actor:"runner",task_id:"t",attempt_id:"a",data:{...(old.data as Record<string,unknown>),status:"fail"}});
    const result=await f.service.reviewDetailed(f.request,{fixture:"good"});
    expect(result.designVerdict).toBe("pass");expect(result.verdict).toBe("fail");expect(result.counts).toBe(false);
  });
  it("a recorded accessibility failure stays a design failure, not an infrastructure error",async()=>{
    const f=fixture();const raw=JSON.parse(readFileSync(f.file,"utf8"));
    raw.web[0].pages[0].axe.violations=[{id:"contrast",impact:"serious"}];
    const dir=join(f.options.projectDir,"evidence","failed-browser");mkdirSync(dir);
    const text=JSON.stringify(raw);writeFileSync(join(dir,"stdout"),text);
    f.ledger.append({kind:"gate_result",actor:"runner",task_id:"t",attempt_id:"a",data:{check:"design-browser",revision:f.request.revision,...f.defs["design-browser"],status:"fail",evidence:{dir,files:{stdout:sha(text)}}}});
    const result=await f.service.reviewDetailed(f.request,{fixture:"good"});
    expect(result.verdict,result.error).toBe("fail");expect(result.designVerdict).toBe("pass");
  });
});


describe("shared runner calibration", () => {
  function shared() {
    const f=fixture(), jarvisHome=join(f.root,"runner"); mkdirSync(jarvisHome);
    const control=Ledger.open(join(jarvisHome,"controls","design"));
    const hashes={generic:f.calibration("generic"),good:f.calibration("good")};
    const entries=f.ledger.entries().filter(e=>Object.values(hashes).includes(e.hash));
    const copied=entries.map(e=>control.append({kind:e.kind,actor:e.actor,data:e.data}).hash);
    const calibration={generic:copied[0]!,good:copied[1]!};
    return {f,jarvisHome,control,calibration};
  }
  it("persists a verified control for a different project's counted review", async () => {
    const {f,jarvisHome,control,calibration}=shared();
    saveDesignCalibration({jarvisHome,ledger:control,calibration});
    const target=fixture();
    const result=await createDesignReviewService({...target.options,jarvisHome}).reviewDetailed(target.request);
    expect(result.verdict,result.error).toBe("pass"); expect(result.counts).toBe(true);
    expect(JSON.parse(readFileSync(join(jarvisHome,"design-calibration.json"),"utf8"))).toMatchObject({ledgerFile:join(realpathSync(control.dir),"ledger.jsonl"),...calibration,model:"gpt-6-astra",policyHash:DESIGN_POLICY_HASH});
    expect(f.reviewer).not.toHaveBeenCalled();
  });
  it.each(["tampered-ledger","wrong-hash","wrong-policy","wrong-model","outside-root","symlink","malformed","missing"])("ignores an unverifiable record: %s", async fault => {
    const {jarvisHome,control,calibration}=shared();
    saveDesignCalibration({jarvisHome,ledger:control,calibration});
    const file=join(jarvisHome,"design-calibration.json"), record=JSON.parse(readFileSync(file,"utf8"));
    if(fault==="tampered-ledger") writeFileSync(join(control.dir,"ledger.jsonl"),readFileSync(join(control.dir,"ledger.jsonl"),"utf8").replace('"fail"','"pass"'));
    if(fault==="wrong-hash") record.generic="f".repeat(64);
    if(fault==="wrong-policy") record.policyHash="f".repeat(64);
    if(fault==="wrong-model") record.model="other-model";
    if(fault==="outside-root") {
      const outside=join(jarvisHome,"..","outside"); mkdirSync(outside,{mode:0o700});
      for(const name of ["ledger.jsonl","head.hash"]) copyFileSync(join(control.dir,name),join(outside,name));
      record.ledgerFile=join(realpathSync(outside),"ledger.jsonl");
    }
    writeFileSync(file,JSON.stringify(record));
    if(fault==="symlink") { const saved=file+".saved"; writeFileSync(saved,JSON.stringify(record)); rmSync(file); symlinkSync(saved,file); }
    if(fault==="malformed") writeFileSync(file,"not json");
    if(fault==="missing") rmSync(file);
    const target=fixture();
    const result=await createDesignReviewService({...target.options,jarvisHome}).reviewDetailed(target.request);
    expect(result.verdict).toBe("error"); expect(result.counts).toBe(false); expect(target.reviewer).not.toHaveBeenCalled();
  });
  it("refuses to publish a control missing friction or whose good checks failed", () => {
    const {jarvisHome,control,calibration}=shared();
    const bad=control.append({kind:"review_result",actor:"runner",data:{reviewer:"design",model:"gpt-6-astra",purpose:"calibration",fixture:"good",policyHash:DESIGN_POLICY_HASH,designVerdict:"pass",verdict:"fail"}}).hash;
    expect(()=>saveDesignCalibration({jarvisHome,ledger:control,calibration:{...calibration,good:bad}})).toThrow(/calibration/);
    expect(()=>saveDesignCalibration({jarvisHome,ledger:control,calibration:{...calibration,generic:bad}})).toThrow(/calibration/);
  });
  it("discovers the project's own verified controls without a global record", async () => {
    const f=fixture(); f.calibration("generic"); f.calibration("good");
    expect((await f.service.reviewDetailed(f.request)).counts).toBe(true);
  });
  it.each(["impeccable-source","impeccable-url","ai-tells","token-lint","design-md-lint","design-browser"])("reports the absent %s check and never counts it", async missing => {
    const f=fixture();
    const entries=f.ledger.entries().filter(e=>(e.data as {check:string}).check!==missing);
    const ledger=Ledger.open(join(f.root,"missing-browser"));
    for(const e of entries) ledger.append({kind:e.kind,actor:e.actor,task_id:e.task_id,attempt_id:e.attempt_id,data:e.data});
    const result=await createDesignReviewService({...f.options,ledger}).reviewDetailed(f.request,{fixture:"good"});
    expect(result.verdict).toBe("error"); expect(result.counts).toBe(false); expect(result.error).toContain(missing); expect(f.reviewer).not.toHaveBeenCalled();
  });
});

describe("design evidence comes only from the protected design definitions", () => {
  // An architect-authored check may carry a protected check's name, and its case may run candidate code
  // that prints a capture of anything. Only the runner's protected definition makes design evidence.
  it.each(CHECKS)("refuses a same-name %s result that ran another definition, before any reviewer runs", async check => {
    const f=fixture();
    f.ledger.append({kind:"gate_result",actor:"runner",task_id:"t",attempt_id:"a",data:{check,revision:f.request.revision,cases:[{id:"capture",command:"node scripts/design-capture.mjs"}],verify:f.defs[check]!.verify,status:"pass",evidence:{dir:f.evidenceDir,files:{stdout:sha(f.raw)}}}});
    const result=await f.service.reviewDetailed(f.request,{fixture:"good"});
    expect(result.verdict).toBe("error"); expect(result.counts).toBe(false);
    expect(result.error).toContain(check); expect(result.error).toMatch(/protected/);
    expect(f.reviewer).not.toHaveBeenCalled();
  });
  it("refuses a changed verify phase as well as changed cases", async () => {
    const f=fixture();
    f.ledger.append({kind:"gate_result",actor:"runner",task_id:"t",attempt_id:"a",data:{check:"ai-tells",revision:f.request.revision,cases:f.defs["ai-tells"]!.cases,verify:"echo JARVIS-CHECK-COMPLETE",status:"pass",evidence:{dir:f.evidenceDir,files:{stdout:sha(f.raw)}}}});
    const result=await f.service.reviewDetailed(f.request,{fixture:"good"});
    expect(result.verdict).toBe("error"); expect(result.error).toContain("ai-tells"); expect(f.reviewer).not.toHaveBeenCalled();
  });
  it("refuses material that has no protected definition for a required check", async () => {
    const f=fixture();
    const material=await f.options.resolveMaterial();
    const {["design-browser"]:_browser,...rest}=material.checks;
    const result=await createDesignReviewService({...f.options,resolveMaterial:async()=>({...material,checks:rest})}).reviewDetailed(f.request,{fixture:"good"});
    expect(result.verdict).toBe("error"); expect(result.error).toContain("design-browser"); expect(f.reviewer).not.toHaveBeenCalled();
    // A caller written before decision 156 (the control's harness) gets a plain refusal.
    const none=await createDesignReviewService({...f.options,resolveMaterial:async()=>({...material,checks:undefined as never})}).reviewDetailed(f.request,{fixture:"good"});
    expect(none.verdict).toBe("error"); expect(none.error).toMatch(/no protected design definitions/); expect(f.reviewer).not.toHaveBeenCalled();
  });
});

describe("the latest control for this model and policy decides", () => {
  it.each(["generic","good"] as const)("a later failing %s control withdraws the project's calibration", async fixtureName => {
    const f=fixture(); f.calibration("generic"); f.calibration("good"); f.failedCalibration(fixtureName);
    const result=await f.service.reviewDetailed(f.request);
    expect(result.verdict).toBe("error"); expect(result.counts).toBe(false); expect(f.reviewer).not.toHaveBeenCalled();
  });
  it("a passing control after a failed one calibrates", async () => {
    const f=fixture(); f.failedCalibration("generic"); f.failedCalibration("good"); f.calibration("generic"); f.calibration("good");
    const result=await f.service.reviewDetailed(f.request);
    expect(result.verdict,result.error).toBe("pass"); expect(result.counts).toBe(true);
  });
  it("named hashes stop counting once a later control for the same fixture fails", async () => {
    const f=fixture(); const calibration={generic:f.calibration("generic"),good:f.calibration("good")};
    f.failedCalibration("good");
    const result=await createDesignReviewService({...f.options,calibration}).reviewDetailed(f.request);
    expect(result.verdict).toBe("error"); expect(f.reviewer).not.toHaveBeenCalled();
  });
  it("a shared record stops counting once its control ledger records a later failing control", async () => {
    const f=fixture(), jarvisHome=join(f.root,"runner"); mkdirSync(jarvisHome);
    const control=Ledger.open(join(jarvisHome,"controls","design"));
    const copy=(hash:string)=>{ const e=f.ledger.entries().find(x=>x.hash===hash)!; return control.append({kind:e.kind,actor:e.actor,data:e.data}).hash; };
    const calibration={generic:copy(f.calibration("generic")),good:copy(f.calibration("good"))};
    saveDesignCalibration({jarvisHome,ledger:control,calibration});
    const target=fixture();
    expect((await createDesignReviewService({...target.options,jarvisHome}).reviewDetailed(target.request)).counts).toBe(true);
    copy(f.failedCalibration("generic"));
    const again=fixture();
    const result=await createDesignReviewService({...again.options,jarvisHome}).reviewDetailed(again.request);
    expect(result.verdict).toBe("error"); expect(again.reviewer).not.toHaveBeenCalled();
  });
});
