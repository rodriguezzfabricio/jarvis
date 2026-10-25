import type { CdpSession, FrameCoverage, Page } from "./browser.ts";
interface DocumentFrame { id: string; url: string; loaderId: string; parentId?: string }
interface Tree { frame: DocumentFrame; childFrames?: Tree[] }
interface Snapshot { frames: Map<string, DocumentFrame & { cdp: CdpSession }>; roots: string[] }

async function snapshot(sessions: CdpSession[]): Promise<Snapshot> {
  const frames: Snapshot["frames"] = new Map(); const roots: string[] = [];
  for (const cdp of sessions) {
    const { frameTree } = await cdp.send("Page.getFrameTree") as { frameTree: Tree };
    roots.push(frameTree.frame.id);
    const seen = new Set<string>();
    const walk = (node: Tree, parentId?: string) => {
      const frame = node?.frame;
      if (!frame?.id || typeof frame.url !== "string" || typeof frame.loaderId !== "string" || seen.has(frame.id)) throw new Error("invalid or duplicate frame document");
      seen.add(frame.id);
      frames.set(frame.id, { ...frame, ...(parentId ? { parentId } : {}), cdp });
      for (const child of node.childFrames ?? []) walk(child, frame.id);
    };
    walk(frameTree);
  }
  return { frames, roots };
}
const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

async function checkFrameSets(page: Page, main: CdpSession, state: Snapshot): Promise<void> {
  const playwright = [];
  for (const frame of page.frames()) {
    const parent = frame.parentFrame();
    if (parent && frame.url() === "about:blank" && await (await frame.frameElement()).getAttribute("src") !== null) throw new Error("src frame is still about:blank");
    playwright.push(JSON.stringify([frame.url(), parent?.url() ?? null]));
  }
  const cdp = [...state.frames.values()].map(frame => JSON.stringify([frame.url, frame.parentId ? state.frames.get(frame.parentId)?.url : null]));
  if (!same(playwright, cdp)) throw new Error("Playwright and CDP frame sets differ");
  const targets = await main.send("Target.getTargets") as { targetInfos: { type: string; targetId: string }[] };
  if (!Array.isArray(targets.targetInfos)) throw new Error("iframe target enumeration unavailable");
  const iframeTargets = targets.targetInfos.filter(t => t.type === "iframe").map(t => t.targetId);
  const attached = [...new Set(state.roots.filter(id => id !== state.roots[0]))];
  if (!same(iframeTargets, attached)) throw new Error("iframe target and attached frame sets differ");
}

async function runAxe(cdp: CdpSession, frameId: string, source: string): Promise<unknown> {
  const world = await cdp.send("Page.createIsolatedWorld", { frameId, worldName: "jarvis-axe" }) as { executionContextId: number };
  if (!Number.isSafeInteger(world.executionContextId) || world.executionContextId <= 0) throw new Error(`isolated world unavailable for frame ${frameId}`);
  const expression = `${source}\n;(async () => { const result = await globalThis.axe.run(document, {iframes: false, runOnly: {type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]}}); return {...result, version: globalThis.axe.version}; })()`;
  const result = await cdp.send("Runtime.evaluate", { expression, contextId: world.executionContextId, awaitPromise: true, returnByValue: true }) as { result?: { value?: unknown }; exceptionDetails?: unknown };
  if (result.exceptionDetails || result.result?.value === undefined) throw new Error(`isolated axe evaluation did not complete for frame ${frameId}`);
  return result.result.value;
}

/** Independently reconcile Playwright frames, renderer trees and OOP iframe targets. */
export async function isolatedFrames(page: Page, source: string): Promise<FrameCoverage> {
  const main = await page.context().newCDPSession(page); const sessions = [main];
  try {
    await main.send("Page.enable");
    for (const frame of page.frames().filter(frame => frame.parentFrame() !== null)) {
      try { sessions.push(await page.context().newCDPSession(frame)); }
      catch { /* In-process frames use the main session; set checks and axe must still cover them. */ }
    }
    for (const cdp of sessions.slice(1)) await cdp.send("Page.enable");
    const before = await snapshot(sessions);
    await checkFrameSets(page, main, before);
    const frames: FrameCoverage["frames"] = [];
    for (const frame of before.frames.values()) frames.push({ id: frame.id, url: frame.url, loaderId: frame.loaderId, axe: await runAxe(frame.cdp, frame.id, source) });
    const after = await snapshot(sessions);
    await checkFrameSets(page, main, after);
    if (!same([...before.frames.keys()], [...after.frames.keys()])) throw new Error("frame tree changed during accessibility checks");
    for (const frame of before.frames.values()) {
      const current = after.frames.get(frame.id)!;
      if (frame.url !== current.url || frame.loaderId !== current.loaderId || frame.parentId !== current.parentId) throw new Error("frame document changed during accessibility checks");
    }
    return { frameCount: frames.length, frameIds: frames.map(frame => frame.id), frames };
  } finally { await Promise.all(sessions.map(cdp => cdp.detach())); }
}
