import { createRequire } from "node:module";
import { localTarget } from "./browser.ts";
import type { ImpeccableResult, ImpeccableTarget } from "./impeccable.ts";
import { verifyQaToolchain } from "./toolchain.ts";

export interface ImpeccableBrowserInput { repo: string; manifest: string; manifestHash: string; url: string; port: number }
interface ScanPage { goto(url: string, options: {waitUntil: "networkidle"; timeout: number}): Promise<unknown>; url(): string; close(): Promise<void>; context(): {newCDPSession(page:ScanPage):Promise<{send(method:string):Promise<unknown>;detach():Promise<void>}>} }
interface ScanBrowser { newPage(options: {viewport: {width: number; height: number}; reducedMotion: "reduce"}): Promise<ScanPage>; close(): Promise<void> }
export interface ImpeccableBrowserRuntime { launch(options: {headless: boolean; executablePath: string; args: string[]}): Promise<ScanBrowser>; targets?(port:number):Promise<unknown> }
export interface ImpeccableUrlObservation { kind: "impeccable-url"; pages: {width: number; result: ImpeccableResult}[] }

async function cdpTargets(port:number):Promise<unknown> {
  const response=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(5000),redirect:"error"});
  if(!response.ok || !response.body) throw new Error("runner CDP endpoint unavailable");
  const reader=response.body.getReader(),chunks:Buffer[]=[];let size=0;
  try {
    for(;;) {const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>64*1024)throw new Error("CDP response exceeds bounds");chunks.push(Buffer.from(chunk.value));}
  } finally {await reader.cancel();}
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function ownCdpPage(page:ScanPage,port:number,targets:(port:number)=>Promise<unknown>):Promise<void> {
  const session=await page.context().newCDPSession(page);
  try {
    const info=await session.send("Target.getTargetInfo") as {targetInfo?:{targetId?:string}};
    const raw=await targets(port);
    const pages=Array.isArray(raw)?raw.filter((p: {type?:unknown})=>p?.type==="page"):[];
    if(!info.targetInfo?.targetId || pages.length!==1 || pages[0].id!==info.targetInfo.targetId || pages[0].url!==page.url()) throw new Error("CDP port does not belong to the runner browser page");
  } finally {await session.detach();}
}

/** Case-side driver only: the caller runs this entire process in the gate sandbox. */
export async function scanImpeccableBrowser(input: ImpeccableBrowserInput, scan: (target: ImpeccableTarget) => Promise<ImpeccableResult>, runtime?: ImpeccableBrowserRuntime): Promise<ImpeccableUrlObservation> {
  const url = localTarget(input.url);
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error("invalid runner CDP port");
  const tools = verifyQaToolchain(input.manifest, input.manifestHash, input.repo);
  const chromium = runtime ?? (createRequire(input.manifest)(tools.playwrightModule) as {chromium: ImpeccableBrowserRuntime}).chromium;
  const browser = await chromium.launch({headless: true, executablePath: tools.chromiumExecutable, args: ["--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${input.port}`]});
  const pages: ImpeccableUrlObservation["pages"] = [];
  try {
    for (const width of [375, 768, 1440]) {
      const page = await browser.newPage({viewport: {width, height: 900}, reducedMotion: "reduce"});
      try {
        await page.goto(url, {waitUntil: "networkidle", timeout: 30_000});
        if (page.url() !== url) throw new Error("Impeccable target redirected");
        await ownCdpPage(page,input.port,runtime?.targets??cdpTargets);
        pages.push({width, result: await scan({kind: "url", port: input.port, url})});
      } finally { await page.close(); }
    }
    return {kind: "impeccable-url", pages};
  } finally { await browser.close(); }
}
