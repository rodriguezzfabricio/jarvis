import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isolatedFrames } from "./browser-frames.ts";
import { loadBrowserRuntime } from "./toolchain.ts";

export function localTarget(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) throw new Error("QA needs a local web target without credentials");
  return url.href;
}

export interface CdpSession { send(method: string, params?: Record<string, unknown>): Promise<unknown>; detach(): Promise<void> }
export interface Frame {
  url(): string;
  parentFrame(): Frame | null;
  frameElement(): Promise<{ getAttribute(name: string): Promise<string | null> }>;
}
export interface Page {
  frames(): Frame[];
  goto(url: string, options: { waitUntil: "networkidle"; timeout: number }): Promise<unknown>;
  locator(selector: string): { ariaSnapshot(): Promise<string> };
  url(): string;
  context(): { newCDPSession(target: Page | Frame): Promise<CdpSession> };
  screenshot(options: { fullPage: boolean }): Promise<Buffer>;
  close(): Promise<void>;
}
interface Browser { newPage(options: { viewport: { width: number; height: number }; reducedMotion: "reduce" }): Promise<Page>; close(): Promise<void> }
export interface BrowserRuntime { launch(): Promise<Browser>; axeSource: string }
export interface WebObservation {
  kind: "qa-browser";
  url: string;
  pages: ({ width: number; url: string; accessibilityTree: string; axe: unknown; screenshot: string } & FrameCoverage)[];
}

/** Raw browser observations only; assertions run outside the candidate sandbox (decision 76). */
export async function observeWeb(target: string, runtime: BrowserRuntime): Promise<WebObservation> {
  const url = localTarget(target);
  const pages: WebObservation["pages"] = [];
  for (const width of [375, 768, 1440]) {
    // One Chromium per viewport: loadBrowserRuntime launches with --single-process, and a single-process
    // browser dies (SIGTRAP) when asked for a second page, even after the first was closed.
    const browser = await runtime.launch();
    try {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
        const accessibilityTree = await page.locator("body").ariaSnapshot();
        const axe = await isolatedFrames(page, runtime.axeSource);
        const screenshot = (await page.screenshot({ fullPage: true })).toString("base64");
        const finalUrl = page.url();
        pages.push({ width, url: finalUrl, accessibilityTree, axe: axe.frames[0]!.axe, screenshot, ...axe });
      } finally { await page.close(); }
    } finally { await browser.close(); }
  }
  return { kind: "qa-browser", url, pages };
}

async function main(): Promise<void> {
  const [manifest, hash, url, repo] = process.argv.slice(2);
  if (!manifest || !hash || !url || !repo) throw new Error("usage: browser.ts <approved manifest> <locked manifest hash> <local URL> <checkout>");
  const observation = await observeWeb(url, loadBrowserRuntime(manifest, hash, repo));
  console.log(JSON.stringify(observation));
}

export interface FrameCoverage {
  frameCount: number;
  frameIds: string[];
  frames: { id: string; url: string; loaderId: string; axe: unknown }[];
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main().catch(error => { console.error(String(error)); process.exitCode = 1; });
}
