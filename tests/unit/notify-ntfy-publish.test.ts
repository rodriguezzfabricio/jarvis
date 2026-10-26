import { afterEach, expect, it, vi } from "vitest";
import { NtfyNotifier } from "../../packages/cli/src/notify/ntfy.ts";

// The publish response's `time` is ntfy's own clock for the send (backlog 114, decision 130). Anything
// else in the body (it echoes the topic, a capability) never reaches a caller or an error.
afterEach(() => { vi.unstubAllGlobals(); });
const notifier = () => new NtfyNotifier({ baseUrl: "https://ntfy.example.invalid", topic: "fake-out", replyTopic: "fake-in" });
function respond(body: string, status = 200) {
  vi.stubGlobal("fetch", async () => new Response(body, { status }));
}

it("returns ntfy's publish time in seconds", async () => {
  respond(JSON.stringify({ id: "abc", time: 1_700_000_000, event: "message", topic: "fake-out", message: "x" }));
  expect(await notifier().send({ kind: "finished", text: "done" }, [])).toEqual({ time: 1_700_000_000 });
});

it.each([
  ["no body", ""],
  ["no time", "{}"],
  ["malformed JSON", "{not json"],
  ["a fractional time", JSON.stringify({ time: 1.5 })],
  ["a negative time", JSON.stringify({ time: -1 })],
  ["a string time", JSON.stringify({ time: "1700000000" })],
  ["an oversized body", JSON.stringify({ time: 1, pad: "x".repeat(70_000) })],
])("a successful publish with %s returns no time", async (_label, body) => {
  respond(body);
  expect(await notifier().send({ kind: "finished", text: "done" }, [])).toEqual({});
});

it("a failed publish quotes neither the body nor the topic", async () => {
  respond(JSON.stringify({ error: "fake-out fake-in secret body" }), 500);
  const error = await notifier().send({ kind: "finished", text: "done" }, []).then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("ntfy publish HTTP 500");
});
