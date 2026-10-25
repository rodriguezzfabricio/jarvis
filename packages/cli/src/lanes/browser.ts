import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadBrowserRuntime } from "./toolchain.ts";

export function localTarget(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) throw new Error("QA needs a local web target without credentials");
  return url.href;
}

interface CdpSession { send(method: string, params?: Record<string, unknown>): Promise<unknown>; detach(): Promise<void> }
export interface Page {
  goto(url: string, options: { waitUntil: "networkidle"; timeout: number }): Promise<unknown>;
  locator(selector: string): { ariaSnapshot(): Promise<string> };
  url(): string;
  context(): { newCDPSession(page: Page): Promise<CdpSession> };
  screenshot(options: { fullPage: boolean }): Promise<Buffer>;
  close(): Promise<void>;
}
interface Browser { newPage(options: { viewport: { width: number; height: number }; reducedMotion: "reduce" }): Promise<Page>; close(): Promise<void> }
export interface BrowserRuntime { launch(): Promise<Browser>; axeSource: string }
export interface WebObservation {
  kind: "qa-browser";
  url: string;
  pages: { width: number; url: string; accessibilityTree: string; axe: unknown; screenshot: string }[];
}

/** Raw browser observations only; assertions run outside the candidate sandbox (decision 76). */
export async function observeWeb(target: string, runtime: BrowserRuntime): Promise<WebObservation> {
  const url = localTarget(target);
  const browser = await runtime.launch();
  const pages: WebObservation["pages"] = [];
  try {
    for (const width of [375, 768, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
        const accessibilityTree = await page.locator("body").ariaSnapshot();
        const axe = await isolatedAxe(page, runtime.axeSource);
        const screenshot = (await page.screenshot({ fullPage: true })).toString("base64");
        const finalUrl = page.url();
        pages.push({ width, url: finalUrl, accessibilityTree, axe, screenshot });
      } finally { await page.close(); }
    }
    return { kind: "qa-browser", url, pages };
  } finally { await browser.close(); }
}

async function main(): Promise<void> {
  const [manifest, hash, url, repo] = process.argv.slice(2);
  if (!manifest || !hash || !url || !repo) throw new Error("usage: browser.ts <approved manifest> <locked manifest hash> <local URL> <checkout>");
  const observation = await observeWeb(url, loadBrowserRuntime(manifest, hash, repo));
  console.log(JSON.stringify(observation));
}

/** Chromium's isolated world has its own globals/prototypes, so page scripts cannot replace axe.run. */
async function isolatedAxe(page: Page, source: string): Promise<unknown> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Page.enable");
    const tree = await cdp.send("Page.getFrameTree") as { frameTree: { frame: { id: string } } };
    const world = await cdp.send("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: "jarvis-axe" }) as { executionContextId: number };
    const expression = `${source}\n;(async () => { const result = await globalThis.axe.run({runOnly: {type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]}}); return {...result, version: globalThis.axe.version}; })()`;
    const result = await cdp.send("Runtime.evaluate", { expression, contextId: world.executionContextId, awaitPromise: true, returnByValue: true }) as { result?: { value?: unknown }; exceptionDetails?: unknown };
    if (result.exceptionDetails || result.result?.value === undefined) throw new Error("isolated axe evaluation did not complete");
    return result.result.value;
  } finally { await cdp.detach(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main().catch(error => { console.error(String(error)); process.exitCode = 1; });
}
