import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Broker } from "../../packages/cli/src/broker/broker.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { runApprovals } from "../../packages/cli/src/commands/run-approvals.ts";
import type { Action, Notifier, ReplyMessage } from "../../packages/cli/src/notify/notifier.ts";
import { shortTmp } from "../helpers.ts";

// The run's poller records ntfy's publish time with the send, so a Mac clock running ahead doesn't
// refuse the person's tap (backlog 114, decision 130).
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })); });

async function setup(publishTime: unknown) {
  const root = shortTmp("j-run-skew-"); roots.push(root);
  const ledger = Ledger.open(join(root, "project"));
  const configPath = join(root, "notify.json");
  writeFileSync(configPath, JSON.stringify({ baseUrl: "https://notify.example.invalid", topic: "fake-send", replyTopic: "fake-reply" }));
  const broker = new Broker({ ledger, project: "test", adapters: [], secrets: { get: () => undefined } });
  await broker.handle({ op: "spend", payload: { description: "fake" } });
  let replies: ReplyMessage[] = [];
  const buttons: Action[] = [];
  const run = runApprovals({ ledger, broker, project: "test", configPath, taskAllowlists: [[]], now: () => 1_000_000, warn: () => {},
    createNotifier: (): Notifier => ({
      send: async (_message, actions) => { buttons.push(...actions); return { time: publishTime } as { time?: number }; },
      poll: async () => { const batch = replies; replies = []; return batch; },
    }) });
  // A ledger refusal here would stop phone approvals for the run: it must not happen.
  const firstTick = await run.tick().then(() => undefined, (error: unknown) => error);
  expect(buttons).toHaveLength(2);
  const a = buttons[0]!;
  const sent = ledger.entries().find((e) => (e.data as { phase?: string }).phase === "sent")?.data;
  const tap = async (id: string, time: number) => { replies.push({ id, text: `approve:${a.requestId}:${a.nonce}`, time }); await run.tick(); };
  const approvals = () => ledger.entries().filter((e) => e.kind === "approval");
  return { run, firstTick, sent, tap, approvals };
}

it("records ntfy's publish time with the send and counts a tap after it", async () => {
  const s = await setup(940);
  expect(s.sent).toMatchObject({ sentAt: 1_000_000, serverTime: 940 });
  await s.tap("before", 939);
  expect(s.approvals()).toEqual([]);
  await s.tap("after", 941);
  expect(s.approvals()).toHaveLength(1);
  await s.run.close();
});

it.each([undefined, -1, 1.5, "940"])("ignores an unusable publish time (%s) and keeps the Mac's clock", async (publishTime) => {
  const s = await setup(publishTime);
  expect(s.firstTick).toBeUndefined();
  expect(s.sent).toEqual(expect.objectContaining({ sentAt: 1_000_000 }));
  expect(s.sent).not.toHaveProperty("serverTime");
  await s.tap("early", 999);
  expect(s.approvals()).toEqual([]);
  await s.tap("later", 1001);
  expect(s.approvals()).toHaveLength(1);
  await s.run.close();
});
