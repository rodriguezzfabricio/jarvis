import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { createDesignReviewService, DESIGN_POLICY_HASH } from "../../packages/cli/src/review/design-service.ts";
import type { ReviewGit } from "../../packages/cli/src/review/workspace.ts";
const roots: string[]=[];
afterEach(()=>{ for(const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
const sha=(raw:string)=>createHash("sha256").update(raw).digest("hex");
const good={verdict:"pass",scores:{quality:4,originality:4,craft:4,functionality:4},findings:[]};
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
  for(const check of ["impeccable-source","impeccable-url","ai-tells","token-lint","design-md-lint","design-browser"]) ledger.append({kind:"gate_result",actor:"runner",task_id:"t",attempt_id:"a",data:{check,revision:request.revision,status:"pass",evidence:{dir:evidenceDir,files:{stdout:sha(raw)}}}});
  const reviewer=vi.fn(async ()=>({reviewer:"codex" as const,model:"gpt-6-astra",rawOutput:"fake trace",rawVerdict:JSON.stringify(good)}));
  const git:ReviewGit=(_cwd,args)=>{
    if(args.includes("clone")) {mkdirSync(String(args.at(-1)));writeFileSync(join(String(args.at(-1)),"app.tsx"),"fake app");}
    return Buffer.from(args.includes("rev-parse")?request.revision:"");
  };
  const options={ledger,projectDir,workRoot,home:root,git,reviewer,resolveMaterial:async()=>({repoPath:join(root,"repo"),baseRevision:"b".repeat(40),principles:"List first",design:"tokens",product:"habits",plan,axeVersion:"4.14.0",captureFile:"stdout"})};
  const calibration=(label:"generic"|"good")=>ledger.append({kind:"review_result",actor:"runner",data:{reviewer:"design",model:"gpt-6-astra",purpose:"calibration",fixture:label,policyHash:DESIGN_POLICY_HASH,verdict:label==="generic"?"fail":"pass",designVerdict:label==="generic"?"fail":"pass",findings:label==="generic"?["launch-tour","multiple-primary","apologetic-error"].map(principle=>({principle})):[]}}).hash;
  return {options,request,reviewer,file,ledger,root,calibration,service:createDesignReviewService(options)};
}
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
    const generic=f.ledger.append({kind:"review_result",actor:"runner",data:{reviewer:"design",model:"gpt-6-astra",purpose:"calibration",fixture:"generic",policyHash:DESIGN_POLICY_HASH,designVerdict:"fail",verdict:"fail",findings:[]}}).hash;
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
    f.ledger.append({kind:"gate_result",actor:"runner",task_id:"t",attempt_id:"a",data:{check:"design-browser",revision:f.request.revision,status:"fail",evidence:{dir,files:{stdout:sha(text)}}}});
    const result=await f.service.reviewDetailed(f.request,{fixture:"good"});
    expect(result.verdict,result.error).toBe("fail");expect(result.designVerdict).toBe("pass");
  });
});
