import { expect, it, vi } from "vitest";
import { withServedApp } from "../../packages/cli/src/lanes/served-app.ts";
import { runServedDesign } from "../../packages/cli/src/lanes/served-design.ts";
import type { DesignBrowserObservation } from "../../packages/cli/src/review/design-browser.ts";
import { verifyServedDesign, baselineFromObservation } from "../../packages/cli/src/lanes/design-gate.ts";
const app={build:"build fake",serve:"serve fake",readyPath:"/jobs",timeoutMs:1000};
const outcome={code:0,timedOut:false,overflowed:false,stdout:"candidate noise",stderr:"",durationMs:1};
it("builds before serving, gives only a case-selected loopback port, and stops after capture",async()=>{
  const events:string[]=[], stop=vi.fn(async()=>{events.push("stop");});
  const result=await withServedApp(app,"/repo",async origin=>{events.push("capture");expect(origin).toBe("http://127.0.0.1:12345");return "observation";},{
    build:async spec=>{events.push("build");expect(spec.cwd).toBe("/repo");return outcome;},
    port:async()=>12345,start:async(_command,_repo,env)=>{events.push("serve");expect(env).toMatchObject({HOST:"127.0.0.1",PORT:"12345",ORIGIN:"http://127.0.0.1:12345"});return{alive:()=>true,stop};},ready:async()=>{events.push("ready");return true;},
  });
  expect(result).toBe("observation");expect(events).toEqual(["build","serve","ready","capture","stop"]);
});
it.each(["build","ready","capture"])("fails closed and cleans up when %s fails",async fault=>{
  const stop=vi.fn(async()=>{}),capture=vi.fn(async()=>{if(fault==="capture")throw Error("capture failed");return "bad";});
  await expect(withServedApp(app,"/repo",capture,{build:async()=>({...outcome,code:fault==="build"?1:0}),port:async()=>12345,start:async()=>({alive:()=>true,stop}),ready:async()=>{if(fault==="ready")throw Error("readiness failed");return true;}})).rejects.toThrow();
  expect(stop).toHaveBeenCalledTimes(fault==="build"?0:1);expect(capture).toHaveBeenCalledTimes(fault==="capture"?1:0);
});
const url="http://127.0.0.1:1/jobs";
export const plan={designId:"jobs",flows:[{id:"jobs",screen:"jobs",url,steps:[],expectText:"Jobs"}]};
function observation(target=".old", actualUrl=url) {
  const url=actualUrl;
  const axe={version:"4.10.3",violations:[{id:"contrast",impact:"serious",nodes:[{target:[target]}]}],incomplete:[]};
  const screenshot="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
  const pages=[375,768,1440].map(width=>({width,url,accessibilityTree:"Jobs",axe,screenshot,frameCount:1,frameIds:["frame"],frames:[{id:"frame",url,loaderId:"loader",axe}]}));
  return {kind:"design-browser",capture:{designId:"jobs",flows:[{id:"jobs",status:"pass"}],pages:pages.map(({width,url,accessibilityTree,screenshot})=>({width,url,accessibilityTree,screenshot,flow:"jobs",screen:"jobs",visibleText:"Jobs"}))},web:[{kind:"qa-browser",url,pages}]};
}
it("uses a runner baseline for inherited axe findings and still rejects new selectors",()=>{
  const raw=observation(), base=baselineFromObservation(raw,plan,"4.10.3","a".repeat(40));
  expect(()=>verifyServedDesign(raw,plan,"4.10.3",base)).not.toThrow();
  expect(()=>verifyServedDesign(observation(".new"),plan,"4.10.3",base)).toThrow(/new|increased/);
  expect(()=>verifyServedDesign(raw,plan,"4.10.3")).toThrow(/serious/);
});
it("refuses malformed, wrong-target, wrong-version and incomplete bases",()=>{
  const raw=observation();
  expect(()=>baselineFromObservation(raw,plan,"4.10.3","short")).toThrow();
  expect(()=>baselineFromObservation(raw,plan,"0.0.0","a".repeat(40))).toThrow();
  const base=baselineFromObservation(raw,plan,"4.10.3","a".repeat(40));
  expect(()=>verifyServedDesign(raw,plan,"4.10.3",{...base,axeVersion:"0.0.0"})).toThrow(/version/);
  base.observation.web[0]!.url="http://127.0.0.1:1/other";
  expect(()=>verifyServedDesign(raw,plan,"4.10.3",base)).toThrow();
  const incomplete=observation();incomplete.web[0]!.pages[0]!.axe.incomplete.push({id:"contrast",impact:"serious"} as never);
  expect(()=>baselineFromObservation(incomplete,plan,"4.10.3","a".repeat(40))).toThrow();
});
it("does not accept a candidate-supplied baseline",()=>{
 const raw=observation();
 expect(()=>verifyServedDesign({...raw,baseline:baselineFromObservation(raw,plan,"4.10.3","a".repeat(40))},plan,"4.10.3")).toThrow(/serious/);
});
it("refuses a dead app and times out readiness without ever capturing",async()=>{
 for(const dead of [true,false]) {
   const capture=vi.fn(),stop=vi.fn(async()=>{});let clock=0;
   await expect(withServedApp(app,"/repo",capture,{build:async()=>outcome,port:async()=>12345,start:async()=>({alive:()=>!dead,stop}),ready:async()=>false,now:()=>clock,sleep:async ms=>{clock+=ms;}})).rejects.toThrow(dead?/exited/:/timed out/);
   expect(capture).not.toHaveBeenCalled();expect(stop).toHaveBeenCalledOnce();
 }
});
it.each(["/jobs", "//other.invalid/jobs", "/\\escape"])("checks readiness path %s",async path=>{
 const build=vi.fn(async()=>outcome);
 const run=withServedApp({...app,readyPath:path},"/repo",async()=>"ok",{build,port:async()=>12345,start:async()=>({alive:()=>true,stop:async()=>{}}),ready:async()=>true});
 if(path==="/jobs")expect(await run).toBe("ok");else {await expect(run).rejects.toThrow();expect(build).not.toHaveBeenCalled();}
});

it("binds scanner and capture URLs to the served origin, normalizes ephemeral ports, and rejects foreign captures",async()=>{
 const config={app,plan,scanner:{pin:{bin:"/protected/engine",version:"1.0.0",sha256:"a".repeat(64)},files:["app.html"],browser:{manifest:"/protected/manifest.json",manifestHash:"b".repeat(64),url,port:1}}};
 const serve:typeof withServedApp=async(_app,_repo,capture)=>capture("http://127.0.0.1:12345");
 const scan=vi.fn(async()=>({kind:"impeccable-url",pages:[]}));
 await runServedDesign("url",config,"/repo",{serve,scan,port:async()=>12346});
 expect(scan.mock.calls[0]).toEqual(["url",expect.objectContaining({browser:expect.objectContaining({url:"http://127.0.0.1:12345/jobs",port:12346})}),"/repo"]);
 const raw=await runServedDesign("capture",config,"/repo",{serve,observe:async actual=>observation(".old",actual.flows[0]!.url) as DesignBrowserObservation}) as DesignBrowserObservation;
 expect(raw.web[0]!.url).toBe(url);expect(raw.capture.pages[0]!.url).toBe(url);expect(raw.web[0]!.pages[0]!.frames[0]!.url).toBe(url);
 await expect(runServedDesign("capture",config,"/repo",{serve,observe:async()=>observation(".old","http://127.0.0.1:54321/jobs") as DesignBrowserObservation})).rejects.toThrow(/escaped/);
});
