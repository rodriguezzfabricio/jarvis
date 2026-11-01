import { afterEach, describe, expect, it, vi } from "vitest";
import { readRenderMarker, waitForRender } from "../../packages/cli/src/release/render-readiness.ts";
const url = "https://habits.onrender.com", hash = "a".repeat(64);
afterEach(() => vi.useRealTimers());
describe("bounded Render readiness", () => {
  it("bounds valid but oversized JSON, redirect bodies and invalid origins", async () => {
    const body = JSON.stringify({ manifestHash: hash, padding: "x".repeat(4096) });
    expect(await readRenderMarker(url, async () => new Response(body))).toBeUndefined();
    expect(await readRenderMarker(url, async () => new Response(JSON.stringify({ manifestHash: hash }), { status: 302 }))).toBeUndefined();
    const fetch = vi.fn(); await expect(readRenderMarker("https://evil.example.com", fetch)).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["headers", "body"])("bounds stalled %s even when the transport ignores abort", async mode => {
    vi.useFakeTimers(); let settled = false, result: string | undefined = hash;
    const fetch: typeof globalThis.fetch = async () => mode === "headers" ? new Promise(() => {}) : new Response(new ReadableStream({ start() {} }));
    void readRenderMarker(url, fetch, 10).then(value => { settled = true; result = value; });
    await vi.advanceTimersByTimeAsync(11); expect(settled).toBe(true); expect(result).toBeUndefined();
  });
  it("stops polling at the total deadline and checks identity, with no secret in HTTPS requests", async () => {
    vi.useFakeTimers(); const fetch = vi.fn(async (_url, init) => {
      expect(init).toEqual({ redirect: "manual", signal: expect.any(AbortSignal), cache: "no-store" });
      return new Response(JSON.stringify({ manifestHash: "b".repeat(64) }));
    });
    let result: boolean | undefined;
    void waitForRender(url, hash, { fetch, timeoutMs: 25, intervalMs: 10 }).then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(26); expect(result).toBe(false); expect(fetch).toHaveBeenCalledTimes(3);
  });
});
