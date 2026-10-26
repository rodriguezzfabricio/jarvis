import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { localTarget, type BrowserRuntime, type Page, type WebObservation } from "../lanes/browser.ts";
import { isolatedFrames } from "../lanes/browser-frames.ts";
import { loadBrowserRuntime } from "../lanes/toolchain.ts";
import { verifyWebObservation } from "../lanes/verify.ts";
import { designEvidence, type DesignCapture } from "./design-evidence.ts";

const text = z.string().trim().min(1).max(4096);
const Step = z.discriminatedUnion("action", [
  z.object({action:z.literal("click"),selector:text}).strict(),
  z.object({action:z.literal("fill"),selector:text,value:z.string().max(4096)}).strict(),
  z.object({action:z.literal("press"),selector:text,value:text}).strict(),
]);
export const DesignBrowserPlanSchema = z.object({designId:text,flows:z.array(z.object({id:text,screen:text,url:text,finalUrl:text.optional(),steps:z.array(Step).max(30),expectText:text}).strict()).min(1).max(4)}).strict();
export type DesignBrowserPlan = z.infer<typeof DesignBrowserPlanSchema>;
interface DesignLocator { click(options: {timeout: number}): Promise<void>; fill(value:string,options:{timeout:number}):Promise<void>; press(value:string,options:{timeout:number}):Promise<void>; ariaSnapshot():Promise<string>; innerText():Promise<string> }
interface DesignPage extends Page { locator(selector:string): DesignLocator }
export interface DesignBrowserObservation { kind:"design-browser"; capture:DesignCapture; web:WebObservation[] }

function planOf(raw: DesignBrowserPlan): DesignBrowserPlan {
  const plan=DesignBrowserPlanSchema.parse(raw);
  if(new Set(plan.flows.map(f=>f.id)).size!==plan.flows.length) throw new Error("duplicate flow");
  for(const flow of plan.flows) { localTarget(flow.url); if(flow.finalUrl) localTarget(flow.finalUrl); }
  return plan;
}

/** Run only as a protected gate case, inside its sandbox. Actions are runner-approved data, never page instructions. */
export async function observeDesign(raw: DesignBrowserPlan, runtime: BrowserRuntime): Promise<DesignBrowserObservation> {
  const plan=planOf(raw);
  const capture:DesignCapture={designId:plan.designId,pages:[],flows:[]}, web:WebObservation[]=[];
  for(const flow of plan.flows) {
    const observation:WebObservation={kind:"qa-browser",url:localTarget(flow.finalUrl??flow.url),pages:[]};
    for(const width of [375,768,1440] as const) {
      // One Chromium per page: the gate's Chromium runs --single-process (srt has no Mach rendezvous), and a
      // single-process browser dies when asked for a second page (decision 125).
      const browser=await runtime.launch();
      try {
        const page=await browser.newPage({viewport:{width,height:900},reducedMotion:"reduce"}) as DesignPage;
        try {
          await page.goto(localTarget(flow.url),{waitUntil:"networkidle",timeout:30_000});
          if(page.url()!==localTarget(flow.url)) throw new Error("design start page redirected");
          for(const step of flow.steps) {
            const locator=page.locator(step.selector);
            if(step.action==="click") await locator.click({timeout:10_000});
            else if(step.action==="fill") await locator.fill(step.value,{timeout:10_000});
            else await locator.press(step.value,{timeout:10_000});
            localTarget(page.url());
          }
          if(page.url()!==observation.url) throw new Error("unexpected design flow destination");
          const visibleText=await page.locator("body").innerText();
          if(!visibleText.includes(flow.expectText)) throw new Error(`flow expectation failed: ${flow.id}`);
          const accessibilityTree=await page.locator("body").ariaSnapshot();
          const screenshot=(await page.screenshot({fullPage:false})).toString("base64");
          const frames=await isolatedFrames(page,runtime.axeSource);
          capture.pages.push({screen:flow.screen,flow:flow.id,width,url:page.url(),visibleText,accessibilityTree,screenshot});
          observation.pages.push({width,url:page.url(),accessibilityTree,screenshot,axe:frames.frames[0]!.axe,...frames});
        } finally { await page.close(); }
      } finally { await browser.close(); }
    }
    capture.flows.push({id:flow.id,status:"pass"}); web.push(observation);
  }
  return {kind:"design-browser",capture,web};
}

/** Runner/isolated-verifier side: bind the observation to the protected plan and reuse the QA assertions. */
export function verifyDesignObservation(raw: unknown, input:DesignBrowserPlan, axeVersion:string, options:{calibration?:boolean}={}):DesignCapture {
  const plan=planOf(input), value=raw as DesignBrowserObservation;
  if(!value || value.kind!=="design-browser" || value.capture?.designId!==plan.designId || !Array.isArray(value.web) || value.web.length!==plan.flows.length) throw new Error("wrong or incomplete design observation");
  designEvidence(value.capture,plan.flows.map(f=>f.id));
  for(const [i,flow] of plan.flows.entries()) {
    const observation=value.web[i]!;
    const verified=verifyWebObservation(observation,{url:flow.finalUrl??flow.url,axeVersion});
    const problems=options.calibration ? verified.problems.filter(p=>! /\((?:serious|critical|null), requires resolution\)$/.test(p)) : verified.problems;
    if(problems.length) throw new Error(`design browser checks failed: ${problems.join("; ")}`);
    const pages=value.capture.pages.filter(p=>p.flow===flow.id);
    if(pages.length!==3) throw new Error("unexpected flow screen coverage");
    for(const page of pages) {
      const observed=observation.pages.find(p=>p.width===page.width);
      if(page.screen!==flow.screen || page.url!==localTarget(flow.finalUrl??flow.url) || !page.visibleText.includes(flow.expectText) || !observed || page.screenshot!==observed.screenshot || page.accessibilityTree!==observed.accessibilityTree) throw new Error("design evidence does not match the named flow");
    }
  }
  return value.capture;
}

async function main():Promise<void> {
  const [manifest,hash,planPath,repo]=process.argv.slice(2);
  if(!manifest||!hash||!planPath||!repo) throw new Error("usage: design-browser.ts <manifest> <hash> <protected plan> <checkout>");
  const plan=JSON.parse(readFileSync(planPath,"utf8")) as DesignBrowserPlan;
  console.log(JSON.stringify(await observeDesign(plan,loadBrowserRuntime(manifest,hash,repo))));
}
if(process.argv[1]&&pathToFileURL(realpathSync(process.argv[1])).href===import.meta.url) {
  void main().catch(error=>{console.error(String(error));process.exitCode=1;});
}
