import { afterEach, expect, it, vi } from "vitest";
import { MAX_POLL_BYTES, NtfyNotifier } from "../../packages/cli/src/notify/ntfy.ts";

// Backlog 99 review: a poll's body is bounded, and a malformed one is refused with a fixed message.
// ntfy's events carry the reply topic ("topic":"…"), and JSON.parse quotes part of what it can't
// parse, so an echoed fragment could reach the runner's log past whole-topic redaction.

afterEach(() => { vi.unstubAllGlobals(); });
function serve(body: () => BodyInit) {
  const seen = { pulled: 0 };
  vi.stubGlobal("fetch", async () => new Response(body(), { status: 200 }));
  return seen;
}
const notifier = () => new NtfyNotifier({ baseUrl: "https://ntfy.example.invalid", topic: "fake-out", replyTopic: "fake-in", since: "saved" });

it("refuses a poll body over the cap, without reading the rest or moving the cursor", async () => {
  let pulled = 0;
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  serve(() => new ReadableStream<Uint8Array>({ pull(controller) { pulled++; controller.enqueue(chunk); } }));
  const n = notifier();
  await expect(n.poll()).rejects.toThrow(`ntfy poll response exceeds ${MAX_POLL_BYTES} bytes`);
  expect(pulled).toBeLessThanOrEqual(MAX_POLL_BYTES / chunk.byteLength + 2);
  expect(n.lastId).toBe("saved");
});

it("accepts a body up to the cap", async () => {
  const line = `${JSON.stringify({ id: "one", event: "message", message: "x" })}\n`;
  serve(() => line + " ".repeat(MAX_POLL_BYTES - Buffer.byteLength(line)));
  expect(await notifier().poll()).toEqual([{ id: "one", text: "x" }]);
});

it.each([
  ["truncated JSON", '{"id":"abc","topic":"fake-in-private-capability","event":"message","message":"approve:r:n'],
  ["a bad message event", '{"id":"abc","topic":"fake-in-private-capability","event":"message","message":42}'],
  ["an event id outside ntfy's alphabet", '{"id":"abc\\u0007fake-in-private-capability","event":"message","message":"x"}'],
])("refuses %s with a fixed message that echoes nothing", async (_what, body) => {
  serve(() => `${body}\n`);
  const n = notifier();
  const error = await n.poll().then(() => undefined, (e: unknown) => e as Error);
  expect(error?.message).toMatch(/^ntfy poll returned (malformed JSON|a malformed message event)$/);
  expect(error?.message).not.toContain("private-capability");
  expect(n.lastId).toBe("saved");
});
