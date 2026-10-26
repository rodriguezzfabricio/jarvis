import { describe, expect, it, vi } from "vitest";
import { observeDesign, verifyDesignObservation } from "../../packages/cli/src/review/design-browser.ts";
import { isolatedFrames } from "../../packages/cli/src/lanes/browser-frames.ts";
vi.mock("../../packages/cli/src/lanes/browser-frames.ts", () => ({isolatedFrames: vi.fn(async () => ({frameCount:1,frameIds:["top"],frames:[{id:"top",url:"http://127.0.0.1:3000/",loaderId:"1",axe:{version:"4.14.0",violations:[],incomplete:[]}}]}))}));
const failure = (promise:Promise<unknown>) => promise.then(() => "", error => String(error));
function fixture() {
  let url = "";
  const click = vi.fn(async () => {}), fill = vi.fn(async () => {}), press = vi.fn(async () => {}), pageClose = vi.fn(async () => {});
  const page = {goto: async (target: string) => {url=target;}, url: () => url, close: pageClose,
    locator: () => ({click,fill,press,ariaSnapshot:async()=>"button Add habit",innerText:async()=>"Saved habit",isVisible:async()=>true}),
    screenshot: async () => Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64"), frames: () => [], context: () => ({newCDPSession: vi.fn()})};
  const close = vi.fn(async () => {}), newPage = vi.fn(async () => page);
  const runtime = {launch: async () => ({newPage,close}), axeSource:"fake axe"};
  const plan = {designId:"one",flows:[{id:"add",screen:"today",url:"http://127.0.0.1:3000/",steps:[{action:"fill" as const,selector:"input",value:"Read"},{action:"click" as const,selector:"button"}],expectText:"Saved habit"}]};
  return {plan,runtime,click,fill,press,pageClose,close,newPage,page};
}
describe("runner design flows", () => {
  it("drives each named flow at 375/768/1440, captures real page data and verifies accessibility", async () => {
    const f=fixture(); const raw=await observeDesign(f.plan,f.runtime);
    expect(f.fill).toHaveBeenCalledTimes(3); expect(f.click).toHaveBeenCalledTimes(3);
    expect(raw.capture.pages.map(p=>p.width)).toEqual([375,768,1440]);
    expect(raw.capture.pages[0]!.visibleText).toBe("Saved habit");
    expect(f.close).toHaveBeenCalledOnce(); expect(f.pageClose).toHaveBeenCalledTimes(3);
    expect(verifyDesignObservation(raw,f.plan,"4.14.0").designId).toBe("one");
  });
  it("fails failed flow expectations and closes resources", async () => {
    const f=fixture(); f.plan.flows[0]!.expectText="Not here";
    expect(await failure(observeDesign(f.plan,f.runtime))).toMatch(/expectation/);
    expect(f.close).toHaveBeenCalledOnce(); expect(f.pageClose).toHaveBeenCalledOnce();
  });
  it("refuses arbitrary script actions and remote targets before launch", async () => {
    const f=fixture(); const launch=vi.spyOn(f.runtime,"launch");
    expect(await failure(observeDesign({...f.plan,flows:[{...f.plan.flows[0]!,steps:[{action:"evaluate",value:"steal()"}]}]} as never,f.runtime))).not.toBe("");
    expect(await failure(observeDesign({...f.plan,flows:[{...f.plan.flows[0]!,url:"https://example.com"}]},f.runtime))).not.toBe("");
    expect(launch).not.toHaveBeenCalled();
  });
  it("isolated verification rejects wrong design, failed axe, wrong target or missing flow evidence", async () => {
    const f=fixture(); const raw=await observeDesign(f.plan,f.runtime);
    expect(()=>verifyDesignObservation({...raw,capture:{...raw.capture,designId:"other"}},f.plan,"4.14.0")).toThrow();
    expect(()=>verifyDesignObservation({...raw,web:[]},f.plan,"4.14.0")).toThrow();
    raw.web[0]!.pages[0]!.url="http://127.0.0.1:9999/";
    expect(()=>verifyDesignObservation(raw,f.plan,"4.14.0")).toThrow();
    vi.mocked(isolatedFrames).mockResolvedValueOnce({frameCount:1,frameIds:["top"],frames:[{id:"top",url:"http://127.0.0.1:3000/",loaderId:"1",axe:{version:"4.14.0",violations:[{id:"contrast",impact:"serious"}],incomplete:[]}}]});
    const bad=await observeDesign(f.plan,f.runtime);
    expect(()=>verifyDesignObservation(bad,f.plan,"4.14.0")).toThrow();
    expect(verifyDesignObservation(bad,f.plan,"4.14.0",{calibration:true}).designId).toBe("one");
  });
});
