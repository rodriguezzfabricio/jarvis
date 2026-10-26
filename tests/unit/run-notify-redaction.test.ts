import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runNotifications } from "../../packages/cli/src/commands/run-notify.ts";
import { shortTmp } from "../helpers.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

it.each(["crossing", "overlapping"])("redacts complete %s topics before truncating errors", async (kind) => {
  const root = shortTmp("j-redact-"); roots.push(root);
  const configPath = join(root, "notify.json");
  const topic = "fake-topic", replyTopic = "fake-topic-private-reply";
  writeFileSync(configPath, JSON.stringify({ baseUrl: "https://example.invalid", topic, replyTopic }));
  const warnings: string[] = [];
  const prefix = kind === "crossing" ? "x".repeat(235) : "";
  const notifications = runNotifications({ configPath, project: "test", warn: (s) => warnings.push(s),
    createNotifier: () => ({ poll: async () => [], send: async () => { throw new Error(`${prefix}${replyTopic} ${topic}`); } }),
  });
  await notifications.finished({ status: "error" });
  expect(warnings[0]).not.toContain("fake-");
  expect(warnings[0]).not.toContain("private-reply");
  expect(warnings[0]).toContain("<top");
});

it("redacts the union of topic occurrences that overlap without containing one another", async () => {
  const root = shortTmp("j-redact-"); roots.push(root);
  const configPath = join(root, "notify.json");
  writeFileSync(configPath, JSON.stringify({ baseUrl: "https://example.invalid", topic: "fake-abc", replyTopic: "abc-private" }));
  const warnings: string[] = [];
  const n = runNotifications({ configPath, project: "test", warn: (s) => warnings.push(s),
    createNotifier: () => ({ poll: async () => [], send: async () => { throw new Error("fake-abc-private"); } }),
  });
  await n.finished({ status: "error" });
  expect(warnings[0]!.split(": ").at(-1)).toBe("<topic>");
});
