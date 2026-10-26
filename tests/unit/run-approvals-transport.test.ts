import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Broker } from "../../packages/cli/src/broker/broker.ts";
import { runApprovals } from "../../packages/cli/src/commands/run-approvals.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import type { Action, Message, Notifier, ReplyMessage } from "../../packages/cli/src/notify/notifier.ts";
import type { NtfyOptions } from "../../packages/cli/src/notify/ntfy.ts";
import { shortTmp } from "../helpers.ts";

// The phone approvals' transport (backlog 99, decision 117): a timeout pauses phone approvals only until
// the stuck call settles, polls read from the runner's durable cursor (never an adapter's in-memory one,
// which a discarded late batch would have advanced), and an outage is reported once, not every poll.

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })); });

/** An ntfy-like reply topic: messages kept in order, polled `since` an id, each adapter keeping its own cursor. */
function setup() {
  const root = shortTmp("j-approve-t-"); roots.push(root);
  const ledger = Ledger.open(join(root, "project"));
  const configPath = join(root, "notify.json");
  writeFileSync(configPath, JSON.stringify({ baseUrl: "https://notify.example.invalid", topic: "fake-topic", replyTopic: "fake-reply" }));
  const broker = new Broker({ ledger, project: "test", adapters: [], secrets: { get: () => undefined } });
  const topic: ReplyMessage[] = [];
  const sent: { message: Message; actions: readonly Action[] }[] = [];
  const hooks: { poll?: (batch: ReplyMessage[]) => Promise<ReplyMessage[]> } = {};
  let polls = 0;
  const createNotifier = (options: NtfyOptions): Notifier => {
    let cursor = options.since ?? "all";
    return {
      send: async (message, actions) => { sent.push({ message, actions }); },
      poll: async () => {
        polls++;
        const at = cursor === "all" ? 0 : topic.findIndex((m) => m.id === cursor) + 1;
        const batch = topic.slice(at);
        if (batch.length) cursor = batch.at(-1)!.id; // as NtfyNotifier does: advanced when the response arrives
        return hooks.poll ? hooks.poll(batch) : batch;
      },
    };
  };
  const warnings: string[] = [];
  const make = () => runApprovals({ configPath, project: "test", ledger, broker, taskAllowlists: [[]], createNotifier, now: () => 100_500,
    warn: (text) => warnings.push(text), timeoutMs: 20, pollMs: 60_000 });
  const tap = (id: string) => { const a = sent.find((s) => s.actions.length)!.actions[0]!; topic.push({ id, text: `approve:${a.requestId}:${a.nonce}`, time: 102 }); };
  const approvals = () => ledger.entries().filter((e) => e.kind === "approval");
  const errors = () => ledger.entries().filter((e) => e.kind === "notify" && (e.data as { phase?: string }).phase === "approval-error");
  return { ledger, broker, sent, hooks, warnings, make, tap, approvals, errors, polls: () => polls };
}

it("a timed-out poll pauses phone approvals until that call settles, then resumes without losing its replies", async () => {
  const s = setup(); await s.broker.handle({ op: "spend", payload: { description: "fake" } });
  const run = s.make();
  await run.tick(); // sends the request; nothing to read yet
  s.tap("tap-1");
  let release: () => void = () => {};
  s.hooks.poll = (batch) => new Promise((resolve) => { release = () => resolve(batch); });
  await run.tick(); // the poll hangs past the deadline
  expect(s.warnings.join("\n")).toMatch(/timed out/);
  const polls = s.polls();
  await run.tick(); // still stuck: no second call stacks on it
  expect(s.polls()).toBe(polls);
  delete s.hooks.poll; release(); await new Promise((r) => setTimeout(r, 0));
  expect(s.approvals()).toHaveLength(0); // the late batch is never processed after its deadline...
  await run.tick(); // ...and is read again from the runner's cursor
  expect(s.polls()).toBe(polls + 1);
  expect(s.approvals()).toHaveLength(1);
  expect((s.approvals()[0]!.data as { by: string }).by).toBe("ntfy");
  await run.close();
});

it("reports an outage once, says when the notifier is back, and records one error per outage", async () => {
  const s = setup(); const run = s.make();
  s.hooks.poll = async () => { throw new Error("fake-reply is down"); };
  for (let i = 0; i < 5; i++) await run.tick();
  expect(s.warnings.filter((w) => /Phone approval poll failed/.test(w))).toHaveLength(1);
  expect(s.errors()).toHaveLength(1);
  expect(s.warnings.join("\n")).not.toContain("fake-reply");
  delete s.hooks.poll; await run.tick();
  expect(s.warnings.at(-1)).toMatch(/Phone approvals are reachable again/);
  s.hooks.poll = async () => { throw new Error("down again"); };
  await run.tick(); await run.tick();
  expect(s.warnings.filter((w) => /Phone approval poll failed/.test(w))).toHaveLength(2);
  expect(s.errors()).toHaveLength(2);
  await run.close();
});

it("checkpoints the reply cursor once per processed batch", async () => {
  const s = setup(); await s.broker.handle({ op: "spend", payload: { description: "fake" } });
  const run = s.make(); await run.tick();
  for (let i = 0; i < 5; i++) s.tap(`tap-${i}`);
  await run.tick();
  const cursors = s.ledger.entries().filter((e) => e.kind === "notify" && (e.data as { phase?: string }).phase === "approval-cursor");
  expect(cursors.map((e) => (e.data as { id: string }).id)).toEqual(["tap-4"]);
  expect(s.approvals()).toHaveLength(1);
  await run.close();
});

it("a poll after a restart starts from the last processed reply", async () => {
  const s = setup(); await s.broker.handle({ op: "spend", payload: { description: "fake" } });
  const first = s.make(); await first.tick(); s.tap("tap-1"); await first.tick(); await first.close();
  const seen: string[][] = [];
  s.hooks.poll = async (batch) => { seen.push(batch.map((m) => m.id)); return batch; };
  s.tap("tap-2");
  const second = s.make(); await second.tick(); await second.close();
  expect(seen[0]).toEqual(["tap-2"]);
});

it("a ledger that can't be written stops phone approvals for the run (it is not a transport error)", async () => {
  const s = setup(); await s.broker.handle({ op: "spend", payload: { description: "fake" } });
  const run = s.make(); await run.tick(); s.tap("tap-1");
  const append = s.ledger.transact.bind(s.ledger);
  const spy = vi.spyOn(s.ledger, "transact").mockImplementation(() => { throw new Error("fake ledger fault"); });
  await expect(run.tick()).rejects.toThrow("fake ledger fault");
  spy.mockImplementation(append as never);
  const polls = s.polls(); await run.tick();
  expect(s.polls()).toBe(polls);
  expect(s.approvals()).toHaveLength(0);
  await run.close();
});
