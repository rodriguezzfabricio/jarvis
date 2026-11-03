import { createHash } from "node:crypto";
import { closeSync, ftruncateSync, openSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { readEvalDesignPlan, installEvalDesignChecks, captureDesignBaseline } from "../../packages/cli/src/lanes/eval-design.ts";
import { readDesignBaseline } from "../../packages/cli/src/lanes/design-gate.ts";
import { fakeToolchain } from "../fixtures/qa/toolchain.ts";
const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
const sha=(data:Buffer|string)=>createHash("sha256").update(data).digest("hex");
function setup(){
 const root=mkdtempSync("/private/tmp/j-eval-design-");roots.push(root);
 const source=fakeToolchain(join(root,"source")), taskDir=join(root,"tasks/t1");mkdirSync(taskDir,{recursive:true});
 writeFileSync(join(root,"engine"),"fake engine");
 const plan={version:1,qa:{source:"source/checks/fixtures/toolchain",manifestSha256:sha(readFileSync(join(source.toolchain.root,"manifest.json")))},engine:{file:"engine",version:"0.1.16",sha256:sha("fake engine")},scanner:{files:["app.html"],path:"/jobs"},plan:{designId:"jobs",flows:[{id:"jobs",screen:"jobs",url:"/jobs",steps:[],expectText:"Jobs"}]},app:{build:"build fake",serve:"serve fake",readyPath:"/jobs",timeoutMs:1000}};
 writeFileSync(join(taskDir,"design-checks.json"),JSON.stringify(plan));
 const ledger=Ledger.open(join(root,"project")),store=new ChecksStore(ledger.dir);mkdirSync(store.checksDir);
 return {root,source,plan,taskDir,ledger,store};
}
it("reads a bounded eval-owned plan and installs paths only into this run's approved store",()=>{
 const f=setup(), plan=readEvalDesignPlan(f.root,"t1")!;
 const definitions=installEvalDesignChecks(f.store,plan,"4.10.3");
 expect(Object.keys(definitions)).toEqual(["impeccable-source","impeccable-url","design-browser"]);
 expect(definitions["impeccable-source"].allowLocalBinding).toBe(false);
 for(const name of ["impeccable-url","design-browser"] as const){expect(definitions[name].allowLocalBinding).toBe(true);expect(definitions[name].cases[0]!.command).toContain("served-design.ts");}
 const config=readFileSync(join(f.store.checksDir,"fixtures/impeccable.json"),"utf8");
 expect(config).not.toContain(f.source.toolchain.root);expect(config).toContain("fixtures/qa-toolchain/manifest.json");
 expect(definitions["design-browser"].verify).toContain("lanes/design-gate.ts");
 f.store.approve(f.ledger,"reviewed");expect(f.store.verify(f.ledger).ok).toBe(true);
});
it.each(["pin","escape","url","axe"])("refuses invalid %s before installation",fault=>{
 const f=setup();
 if(fault==="pin")f.plan.qa.manifestSha256="0".repeat(64);
 if(fault==="escape")f.plan.qa.source="../escape";
 if(fault==="url")f.plan.plan.flows[0]!.url="http://outside.invalid/jobs";
 writeFileSync(join(f.taskDir,"design-checks.json"),JSON.stringify(f.plan));
 expect(()=>installEvalDesignChecks(f.store,readEvalDesignPlan(f.root,"t1")!,fault==="axe"?"0.0.0":"4.10.3")).toThrow();
 expect(existsSync(join(f.store.checksDir,"design-browser.check.json"))).toBe(false);
});
it("a failed base gate leaves no baseline, while preserving strict verification",async()=>{
 const f=setup(), definitions=installEvalDesignChecks(f.store,readEvalDesignPlan(f.root,"t1")!,"4.10.3");f.store.approve(f.ledger,"reviewed");
 const gate=vi.fn(async(input:any)=>({status:"fail" as const,entry:f.ledger.append({kind:"gate_result",actor:"runner",data:{revision:input.revision,status:"fail"}}),evidenceDir:f.root}));
 const result=await captureDesignBaseline({store:f.store,ledger:f.ledger,projectDir:f.ledger.dir,jarvisHome:f.root,workRoot:f.root,repoPath:f.root,revision:"a".repeat(40),check:definitions["design-browser"],taskId:"base",attemptId:"base"},"4.10.3",gate);
 expect(result).toBe(false);expect(existsSync(join(f.store.checksDir,"expected/axe-base.json"))).toBe(false);
 expect(gate.mock.calls[0]![0].revision).toBe("a".repeat(40));
 expect(gate.mock.calls[0]![0].check.verify).toContain("a".repeat(40));
});
it.each(["tamper","wrong-revision","missing-evidence"])("refuses %s base evidence instead of approving a baseline",async fault=>{
 const f=setup(), definitions=installEvalDesignChecks(f.store,readEvalDesignPlan(f.root,"t1")!,"4.10.3");f.store.approve(f.ledger,"reviewed");
 const gate=async(input:import("../../packages/cli/src/checks/gate.ts").GateInput)=>{
   const evidenceDir=join(input.projectDir,"evidence/test"),file="cases/capture/stdout";mkdirSync(join(evidenceDir,"cases/capture"),{recursive:true});
   writeFileSync(join(evidenceDir,file),"{}");
   return {status:"pass" as const,evidenceDir,entry:input.ledger.append({kind:"gate_result",actor:"runner",data:{revision:fault==="wrong-revision"?"b".repeat(40):input.revision,evidence:{dir:evidenceDir,files:fault==="missing-evidence"?{}:{[file]:sha(fault==="tamper"?"different":"{}")}}}})};
 };
 await expect(captureDesignBaseline({store:f.store,ledger:f.ledger,projectDir:f.ledger.dir,jarvisHome:f.root,workRoot:f.root,repoPath:f.root,revision:"a".repeat(40),check:definitions["design-browser"],taskId:"base",attemptId:"base"},"4.10.3",gate)).rejects.toThrow(/evidence|capture/);
 expect(existsSync(join(f.store.checksDir,"expected/axe-base.json"))).toBe(false);
 expect(f.ledger.entries().some(e=>e.kind==="gate_result")).toBe(false);
});

it("reads a baseline only from the protected expected area, and bounds its bytes",()=>{
 const f=setup();expect(readDesignBaseline(f.store.checksDir)).toBeUndefined();
 mkdirSync(join(f.store.checksDir,"fixtures/expected"),{recursive:true});writeFileSync(join(f.store.checksDir,"fixtures/expected/axe-base.json"),"{}");
 expect(readDesignBaseline(f.store.checksDir)).toBeUndefined();
 mkdirSync(join(f.store.checksDir,"expected"));writeFileSync(join(f.store.checksDir,"expected/axe-base.json"),JSON.stringify({baseRevision:"a".repeat(40)}));
 expect(readDesignBaseline(f.store.checksDir)).toMatchObject({baseRevision:"a".repeat(40)});
 const fd=openSync(join(f.store.checksDir,"expected/axe-base.json"),"r+");ftruncateSync(fd,32*1024*1024+1);closeSync(fd);
 expect(()=>readDesignBaseline(f.store.checksDir)).toThrow(/bound/);
});

it("approves a passing base capture as one locked record of the observation, with no second copy of its stdout",async()=>{
 const f=setup(), definitions=installEvalDesignChecks(f.store,readEvalDesignPlan(f.root,"t1")!,"4.10.3");f.store.approve(f.ledger,"reviewed");
 const url="http://127.0.0.1:1/jobs", axe={version:"4.10.3",violations:[{id:"color-contrast",impact:"serious",nodes:[{target:[".old"]}]}],incomplete:[]};
 const pages=([375,768,1440] as const).map(width=>({width,url,accessibilityTree:"Jobs",screenshot:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="}));
 const raw={kind:"design-browser",capture:{designId:"jobs",flows:[{id:"jobs",status:"pass"}],pages:pages.map(p=>({...p,flow:"jobs",screen:"jobs",visibleText:"Jobs"}))},web:[{kind:"qa-browser",url,pages:pages.map(p=>({...p,axe,frameCount:1,frameIds:["top"],frames:[{id:"top",url,loaderId:"1",axe}]}))}]};
 const gate=async(input:import("../../packages/cli/src/checks/gate.ts").GateInput)=>{
   const evidenceDir=join(input.projectDir,"evidence/base"),file="cases/capture/stdout",text=JSON.stringify(raw);mkdirSync(join(evidenceDir,"cases/capture"),{recursive:true});writeFileSync(join(evidenceDir,file),text);
   return {status:"pass" as const,evidenceDir,entry:input.ledger.append({kind:"gate_result",actor:"runner",data:{revision:input.revision,evidence:{dir:evidenceDir,files:{[file]:sha(text)}}}})};
 };
 expect(await captureDesignBaseline({store:f.store,ledger:f.ledger,projectDir:f.ledger.dir,jarvisHome:f.root,workRoot:f.root,repoPath:f.root,revision:"a".repeat(40),check:definitions["design-browser"],taskId:"base",attemptId:"base"},"4.10.3",gate)).toBe(true);
 expect(f.store.verify(f.ledger).ok).toBe(true);
 const stored=JSON.parse(readFileSync(join(f.store.checksDir,"expected/axe-base.json"),"utf8"));
 expect(Object.keys(stored).sort()).toEqual(["axeVersion","baseRevision","observation"]);
 expect(stored.observation).toEqual(raw);
});
