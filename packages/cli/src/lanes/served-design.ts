import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { observeDesign, type DesignBrowserObservation, type DesignBrowserPlan } from "../review/design-browser.ts";
import { impeccableDriver, type ImpeccableDriverConfig } from "./impeccable-driver.ts";
import { loadBrowserRuntime } from "./toolchain.ts";
import { casePort, withServedApp, type ServedAppPlan } from "./served-app.ts";

export const DESIGN_ORIGIN = "http://127.0.0.1:1";
export interface ServedDesignConfig { scanner: ImpeccableDriverConfig; plan: DesignBrowserPlan; app: ServedAppPlan }
export interface ServedDesignDeps {
  serve?: typeof withServedApp;
  observe?: (plan: DesignBrowserPlan) => Promise<DesignBrowserObservation>;
  scan?: typeof impeccableDriver;
  port?: () => Promise<number>;
}
const atOrigin = (url: string, from: string, to: string) => {
  const parsed = new URL(url);
  if(parsed.origin!==from) throw new Error("design URL escaped the case-owned app");
  return `${to}${parsed.pathname}${parsed.search}${parsed.hash}`;
};

/** Dynamic ports are normalized only in URL fields, after the driver has checked the actual navigation. */
function logicalObservation(raw: DesignBrowserObservation, origin: string): DesignBrowserObservation {
  return {...raw,capture:{...raw.capture,pages:raw.capture.pages.map(page=>({...page,url:atOrigin(page.url,origin,DESIGN_ORIGIN)}))},web:raw.web.map(web=>({
    ...web,url:atOrigin(web.url,origin,DESIGN_ORIGIN),pages:web.pages.map(page=>({...page,url:atOrigin(page.url,origin,DESIGN_ORIGIN),frames:page.frames.map(frame=>({...frame,url:frame.url.startsWith(`${origin}/`)?atOrigin(frame.url,origin,DESIGN_ORIGIN):frame.url}))})),
  }))};
}

/** This whole driver runs under the gate's case sandbox, including build, server, scanner and browser. */
export async function runServedDesign(mode:"url"|"capture", config:ServedDesignConfig, repo:string, deps:ServedDesignDeps={}):Promise<unknown> {
  const browser=config.scanner.browser;
  if(!browser) throw new Error("missing approved browser configuration");
  return (deps.serve??withServedApp)(config.app,repo,async origin=>{
    if(mode==="url") return (deps.scan??impeccableDriver)("url",{...config.scanner,browser:{...browser,url:atOrigin(browser.url,DESIGN_ORIGIN,origin),port:await (deps.port??casePort)()}},repo);
    const plan={...config.plan,flows:config.plan.flows.map(flow=>({...flow,url:atOrigin(flow.url,DESIGN_ORIGIN,origin),...(flow.finalUrl?{finalUrl:atOrigin(flow.finalUrl,DESIGN_ORIGIN,origin)}:{})}))};
    const observation=await (deps.observe??(input=>observeDesign(input,loadBrowserRuntime(browser.manifest,browser.manifestHash,repo))))(plan);
    return logicalObservation(observation,origin);
  });
}
async function main():Promise<void> {
  const [mode,file]=process.argv.slice(2);
  if((mode!=="url"&&mode!=="capture")||!file)throw new Error("usage: served-design.ts url|capture <protected config>");
  console.log(JSON.stringify(await runServedDesign(mode,JSON.parse(readFileSync(file,"utf8")) as ServedDesignConfig,process.cwd())));
}
if(process.argv[1]&&pathToFileURL(realpathSync(process.argv[1])).href===import.meta.url) {
  void main().catch(error=>{console.error(String(error));process.exitCode=1;});
}
