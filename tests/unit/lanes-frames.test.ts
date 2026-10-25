import { describe, expect, it, vi } from "vitest";
import { observeWeb } from "../../packages/cli/src/lanes/browser.ts";
import { verifyWebObservation } from "../../packages/cli/src/lanes/verify.ts";

const axe = { version: "4.10.3", violations: [], incomplete: [] };
const url = "http://localhost:3000/";
function setup(failing = "", changing = false) {
  let trees = 0;
  const send = vi.fn(async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (method === "Page.getFrameTree") {
      trees++;
      return { frameTree: { frame: { id: "main", url, loaderId: "main-loader" }, childFrames: [{ frame: { id: changing && trees > 1 ? "replaced" : "child", url: url + "child", loaderId: "child-loader" }, childFrames: [{ frame: { id: "nested", url: url + "nested", loaderId: "nested-loader" } }] }] } };
    }
    if (method === "Target.getTargets") return { targetInfos: [] };
    if (method === "Page.createIsolatedWorld") {
      if (params?.frameId === failing) throw Error("detached or inaccessible frame");
      return { executionContextId: params?.frameId === "main" ? 1 : params?.frameId === "child" ? 2 : 3 };
    }
    if (method === "Runtime.evaluate") return { result: { value: axe } };
    return {};
  });
  const detach = vi.fn(async () => {}); const close = vi.fn(async () => {});
  const mainFrame = { url: () => url, parentFrame: () => null, frameElement: async () => ({ getAttribute: async () => null }) };
  const childFrame = { url: () => url + "child", parentFrame: () => mainFrame, frameElement: async () => ({ getAttribute: async () => "child" }) };
  const nestedFrame = { url: () => url + "nested", parentFrame: () => childFrame, frameElement: async () => ({ getAttribute: async () => "nested" }) };
  const page = { frames: () => [mainFrame, childFrame, nestedFrame], goto: async () => {}, url: () => url, locator: () => ({ ariaSnapshot: async () => "tree" }), context: () => ({ newCDPSession: async (target: unknown) => { if (target !== page) throw Error("in-process frame"); return { send, detach }; } }), screenshot: async () => Buffer.from("image"), close };
  return { send, detach, close, runtime: { axeSource: "/* trusted axe */", launch: async () => ({ newPage: async () => page, close }) } };
}
function observation() {
  return { kind: "qa-browser", url, pages: [375, 768, 1440].map(width => ({ width, url, accessibilityTree: "tree", screenshot: "aW1hZ2U=", axe, frameCount: 2, frameIds: ["main", "child"], frames: [{ id: "main", axe }, { id: "child", axe }] })) };
}

describe("per-frame protected accessibility checks", () => {
  it("walks nested frames, isolates each run, and disables axe frame messaging", async () => {
    const { send, runtime } = setup();
    const pending = observeWeb(url, runtime); await expect(pending).resolves.toHaveProperty("pages");
    const raw = await pending;
    expect(raw.pages[0]).toMatchObject({ frameCount: 3, frameIds: ["main", "child", "nested"], frames: [{ id: "main", axe }, { id: "child", axe }, { id: "nested", axe }] });
    expect(send.mock.calls.filter(([method]) => method === "Runtime.evaluate")).toHaveLength(9);
    for (const [, params] of send.mock.calls.filter(([method]) => method === "Runtime.evaluate")) {
      expect(params).toMatchObject({ awaitPromise: true, returnByValue: true });
      expect(params?.expression).toContain("iframes: false");
    }
  });
  it("fails an inaccessible frame and closes CDP and the browser", async () => {
    const { runtime, detach, close } = setup("child");
    await expect(observeWeb(url, runtime)).rejects.toThrow(/frame/);
    expect(detach).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledTimes(2);
  });
  it("fails missing isolated context IDs and exception results instead of falling back", async () => {
    for (const mode of ["context", "exception", "missing"]) {
      const fake = setup(); const send = fake.send.getMockImplementation()!;
      fake.send.mockImplementation(async (method, params) => {
        if (mode === "context" && method === "Page.createIsolatedWorld") return {};
        if (mode === "exception" && method === "Runtime.evaluate") return { exceptionDetails: {} };
        if (mode === "missing" && method === "Runtime.evaluate") return { result: {} };
        return send(method, params);
      });
      await expect(observeWeb(url, fake.runtime)).rejects.toThrow(/frame/);
    }
  });
  it("fails if the frame tree changes during the observation", async () => {
    await expect(observeWeb(url, setup("", true).runtime)).rejects.toThrow(/frame/);
  });
  it("verifies every frame and rejects missing, duplicate, malformed and unexpected coverage", () => {
    expect(verifyWebObservation(observation(), { url, axeVersion: axe.version }).ok).toBe(true);
    const bad = [
      { frameCount: 0 }, { frameCount: 3 }, { frameIds: ["main", "main"] }, { frameIds: ["main", "other"] },
      { frames: [{ id: "main", axe }] }, { frames: [{ id: "main", axe }, { id: "main", axe }] },
      { frames: [{ id: "main", axe }, { id: "child", axe: {} }] },
      { frames: [{ id: "main", axe }, { id: "child", axe: { ...axe, version: "0.0.0" } }] },
      { frames: [{ id: "main", axe }, { id: "child", axe: { ...axe, incomplete: [{ id: "iframe-contrast", impact: "serious" }] } }] },
      { frameCount: undefined, frameIds: undefined, frames: undefined },
    ];
    for (const change of bad) {
      const raw = observation();
      Object.assign(raw.pages[0]!, change);
      expect(verifyWebObservation(raw, { url, axeVersion: axe.version }).ok, JSON.stringify(change)).toBe(false);
    }
  });
});
