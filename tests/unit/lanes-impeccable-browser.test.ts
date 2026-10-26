import { describe, expect, it, vi } from "vitest";
import { scanImpeccableBrowser } from "../../packages/cli/src/lanes/impeccable-browser.ts";
import { verifyQaToolchain } from "../../packages/cli/src/lanes/toolchain.ts";
import { verifyImpeccableObservation } from "../../packages/cli/src/lanes/impeccable-verify.ts";
vi.mock("../../packages/cli/src/lanes/toolchain.ts", () => ({ verifyQaToolchain: vi.fn(() => ({chromiumExecutable: "/protected/chromium", playwrightModule: "/protected/playwright.cjs"})) }));
const failure = (promise:Promise<unknown>) => promise.then(() => "", error => String(error));
function setup() {
  const close = vi.fn(async () => {}), pageClose = vi.fn(async () => {});
  let url = "";
  const context=()=>({newCDPSession:async()=>({send:async()=>({targetInfo:{targetId:"runner-target"}}),detach:async()=>{}})});
  const newPage = vi.fn(async (_options?: unknown) => ({goto: vi.fn(async (target: string) => {url = target;}), url: () => url, close: pageClose,context}));
  // Pages opened in each launched browser: srt needs --single-process, and that Chromium dies on a second page.
  const pagesPerBrowser: number[] = [];
  const launch = vi.fn(async (_options: {headless: boolean; executablePath: string; args: string[]}) => { const index = pagesPerBrowser.push(0) - 1; return {newPage: async (options: unknown) => { pagesPerBrowser[index]!++; return newPage(options); }, close}; });
  const scan = vi.fn(async () => ({status: "pass" as const, findings: []}));
  const input = {repo: "/checkout", manifest: "/protected/manifest.json", manifestHash: "a".repeat(64), url: "http://127.0.0.1:3000/", port: 9222};
  const targets=vi.fn(async()=>[{id:"runner-target",type:"page",url:input.url}]);
  return {input, launch, scan, close, pageClose, newPage,context,targets,pagesPerBrowser};
}
describe("runner browser and Impeccable", () => {
  it("uses verified Chromium, CDP loopback binding, three viewports and closes every resource", async () => {
    const f = setup(); const result = await scanImpeccableBrowser(f.input, f.scan, {launch: f.launch,targets:f.targets});
    expect(verifyQaToolchain).toHaveBeenCalledWith(f.input.manifest, f.input.manifestHash, f.input.repo);
    expect(f.launch).toHaveBeenCalledWith({headless: true, executablePath: "/protected/chromium", args: ["--single-process", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9222"]});
    // One Chromium per viewport (decision 125): each launched browser opens exactly one page.
    expect(f.launch).toHaveBeenCalledTimes(3); expect(f.pagesPerBrowser).toEqual([1, 1, 1]);
    expect(f.newPage.mock.calls.map(args => (args as unknown as [{viewport: {width: number}}])[0].viewport.width)).toEqual([375, 768, 1440]);
    expect(f.scan.mock.calls).toHaveLength(3);
    expect(result.pages.map(p => p.width)).toEqual([375, 768, 1440]);
    expect(f.pageClose).toHaveBeenCalledTimes(3); expect(f.close).toHaveBeenCalledTimes(3);
    expect(verifyImpeccableObservation(result, "url")).toEqual({status: "pass", findings: []});
  });
  it("closes the browser on scanner crash and refuses redirects before scanning", async () => {
    const f = setup(); f.scan.mockRejectedValue(new Error("scanner crash"));
    expect(await failure(scanImpeccableBrowser(f.input, f.scan, {launch: f.launch,targets:f.targets}))).toContain("scanner crash");
    expect(f.close).toHaveBeenCalledOnce(); expect(f.pageClose).toHaveBeenCalledOnce();
    f.scan.mockClear(); f.newPage.mockResolvedValue({goto: vi.fn(), url: () => "http://localhost:9999/", close: f.pageClose,context:f.context});
    expect(await failure(scanImpeccableBrowser(f.input, f.scan, {launch: f.launch,targets:f.targets}))).toMatch(/redirect/);
    expect(f.scan).not.toHaveBeenCalled();
  });
  it("refuses unavailable toolchain before launching", async () => {
    const f = setup(); vi.mocked(verifyQaToolchain).mockImplementationOnce(() => {throw new Error("unapproved hash");});
    expect(await failure(scanImpeccableBrowser(f.input, f.scan, {launch: f.launch,targets:f.targets}))).toContain("unapproved hash");
    expect(f.launch).not.toHaveBeenCalled();
  });
  it("refuses a CDP port owned by a different browser",async()=>{
    const f=setup();f.targets.mockResolvedValue([{id:"other-browser",type:"page",url:f.input.url}]);
    expect(await failure(scanImpeccableBrowser(f.input,f.scan,{launch:f.launch,targets:f.targets}))).toMatch(/CDP|browser/);
    expect(f.scan).not.toHaveBeenCalled();expect(f.close).toHaveBeenCalledOnce();
  });
  it("isolated verification refuses missing viewports, error and forged pass statuses", () => {
    const result = (status: string, findings: unknown[] = []) => ({kind: "impeccable-url", pages: [375,768,1440].map(width => ({width, result: {status, findings}}))});
    expect(verifyImpeccableObservation(result("error"), "url").status).toBe("error");
    expect(verifyImpeccableObservation({kind: "impeccable-url", pages: []}, "url").status).toBe("error");
    const duplicate=result("pass");duplicate.pages[0]!.width=768;
    expect(verifyImpeccableObservation(duplicate,"url").status).toBe("error");
    expect(verifyImpeccableObservation(result("pass", [{antipattern:"bad",severity:"warning"}]), "url").status).toBe("error");
    expect(verifyImpeccableObservation(result("fail", [{antipattern:"bad",severity:"warning"}]), "url").status).toBe("fail");
    expect(verifyImpeccableObservation({kind: "impeccable-source", result: {status:"pass",findings:[]}}, "source").status).toBe("pass");
  });
});
