import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Broker } from "../../packages/cli/src/broker/broker.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { MAX_APPROVAL_CLOCK_SKEW_SECONDS, ReplyInbox } from "../../packages/cli/src/notify/replies.ts";
import { shortTmp } from "../helpers.ts";

// Backlog 114, decision 130: a tap counts only after the send, to the second, on one clock. ntfy's own
// time for the publish stands in for the Mac's record, by at most MAX_APPROVAL_CLOCK_SKEW_SECONDS, so a
// Mac running ahead no longer refuses real taps and a tap from before the send still never counts.
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));
async function setup(sentAt = 1_000_000, serverTime?: number) {
  const root = shortTmp("j-skew-"); roots.push(root); const ledger = Ledger.open(join(root, "ledger"));
  const broker = new Broker({ ledger, project: "test", adapters: [], secrets: { get: () => undefined } });
  const pending = await broker.handle({ op: "spend", payload: { description: "fake" } });
  const inbox = new ReplyInbox(ledger, { approvalProject: "test" });
  const r = inbox.register(pending.approvalId!, "approval", "test"); inbox.sent(r.requestId, sentAt, serverTime);
  const tap = (id: string, time?: number) => inbox.accept({ id, text: `approve:${r.requestId}:${r.nonce}`, ...(time === undefined ? {} : { time }) });
  const audits = () => ledger.entries().filter((e) => (e.data as { phase?: string }).phase === "clock-skew").map((e) => e.data);
  return { ledger, tap, audits };
}

it("is two minutes", () => { expect(MAX_APPROVAL_CLOCK_SKEW_SECONDS).toBe(120); });

it("counts a tap after ntfy's publish time while the Mac runs ahead, and audits the measured skew", async () => {
  const s = await setup(1_000_000, 940); // the Mac's clock is 60 s ahead of ntfy's
  expect(s.tap("tap", 941).status).toBe("counted");
  expect(s.audits()).toEqual([expect.objectContaining({ id: "tap", skewSeconds: 60, allowedSeconds: 60 })]);
});

it.each([940, 939, 900])("refuses a tap at or before ntfy's publish time even inside the skew window: %s", async (time) => {
  const s = await setup(1_000_000, 940);
  expect(s.tap("tap", time)).toMatchObject({ status: "ignored", reason: "before-send" });
  expect(s.audits()).toEqual([]);
});

it("bounds how far ntfy's publish time may stand in for the Mac's send", async () => {
  const s = await setup(1_000_000, 0); // a publish time far behind the Mac's: at most 120 s counts
  expect(s.tap("old", 880)).toMatchObject({ status: "ignored", reason: "before-send" });
  expect(s.tap("inside", 881).status).toBe("counted");
  expect(s.audits()).toEqual([expect.objectContaining({ id: "inside", skewSeconds: 1000, allowedSeconds: 120 })]);
});

it("uses ntfy's time when the Mac runs behind: a tap before the publish never counts", async () => {
  const s = await setup(1_000_000, 1010);
  expect(s.tap("early", 1005)).toMatchObject({ status: "ignored", reason: "before-send" });
  expect(s.tap("later", 1011).status).toBe("counted");
  expect(s.audits()).toEqual([]);
});

it.each([999, 1000, 1000.5])("without ntfy's publish time keeps the Mac's clock, to the second: %s", async (time) => {
  const s = await setup(1_000_000);
  expect(s.tap("tap", time)).toMatchObject({ status: "ignored", reason: "before-send" });
});

it("without ntfy's publish time counts a later tap with no audit", async () => {
  const s = await setup(1_000_000);
  expect(s.tap("tap", 1001).status).toBe("counted");
  expect(s.audits()).toEqual([]);
});

it.each([1001, 1121, 99999])("later taps need no allowance and have no upper bound: %s", async (time) => {
  const s = await setup(1_000_000, 1000);
  expect(s.tap("tap", time).status).toBe("counted");
  expect(s.audits()).toEqual([]);
});

it.each([undefined, NaN, -1, 1000.5])("refuses missing or invalid tap times: %s", async (time) => {
  const s = await setup(1_000_000, 940);
  expect(s.tap("tap", time)).toMatchObject({ status: "ignored", reason: "before-send" });
});

it.each([-1, 1.5, NaN])("refuses to record an invalid publish time: %s", async (serverTime) => {
  await expect(setup(1_000_000, serverTime)).rejects.toThrow(/server time/);
});
