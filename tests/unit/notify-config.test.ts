import { describe, expect, it } from "vitest";
import { notifyConfigSchema, parseNotifyConfig } from "../../packages/cli/src/notify/config.ts";

// One notifier config format for setup, intake and jarvis run. jarvis setup writes the canonical form;
// the file stage 0 wrote by hand on Oct 23 ({ backend: "ntfy", server, topic, reply_topic }) reads as the
// same config, so the topics Fabricio's phone already subscribes to keep working without a rewrite.
const TOPIC = "fake-private-capability-0c55";
const CANONICAL = { baseUrl: "https://ntfy.sh", topic: TOPIC, replyTopic: `${TOPIC}-reply` };
const STAGE0 = { backend: "ntfy", server: "https://ntfy.sh", topic: TOPIC, reply_topic: `${TOPIC}-reply` };

describe("the notifier config", () => {
  it("reads the canonical form jarvis setup writes, with its optional fields", () => {
    expect(parseNotifyConfig(CANONICAL)).toEqual(CANONICAL);
    expect(parseNotifyConfig({ ...CANONICAL, since: "abc", timeoutMs: 5000 })).toEqual({ ...CANONICAL, since: "abc", timeoutMs: 5000 });
    expect(notifyConfigSchema.parse(CANONICAL)).toEqual(CANONICAL);
  });

  it("reads the stage 0 file as the same config: server is the base URL, reply_topic the reply topic", () => {
    expect(parseNotifyConfig(STAGE0)).toEqual(CANONICAL);
  });

  for (const [label, value] of [
    ["another backend", { ...STAGE0, backend: "email" }],
    ["a stage 0 file with an extra key", { ...STAGE0, token: "x" }],
    ["a stage 0 file without its reply topic", { backend: "ntfy", server: "https://ntfy.sh", topic: TOPIC }],
    ["a stage 0 server that isn't a URL", { ...STAGE0, server: "ntfy.sh" }],
    ["the two forms mixed", { baseUrl: "https://ntfy.sh", topic: TOPIC, reply_topic: TOPIC }],
    ["a canonical file with an extra key", { ...CANONICAL, backend: "ntfy" }],
    ["an empty object", {}],
    ["not an object", TOPIC],
    ["null", null],
  ] as const) {
    it(`refuses ${label}, and its error never quotes the file`, () => {
      let message = "";
      try { parseNotifyConfig(value); } catch (e) { message = (e as Error).message; }
      expect(message).toMatch(/not a notifier configuration/);
      expect(message).not.toContain(TOPIC);
    });
  }
});
