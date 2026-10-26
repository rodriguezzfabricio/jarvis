import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Broker } from "../../packages/cli/src/broker/broker.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { ReplyInbox } from "../../packages/cli/src/notify/replies.ts";
import { shortTmp } from "../helpers.ts";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));
async function setup(sentAt = 1_000_000) {
  const root = shortTmp("j-skew-"); roots.push(root); const ledger = Ledger.open(join(root, "ledger"));
  const broker = new Broker({ ledger, project: "test", adapters: [], secrets: { get: () => undefined } });
  const pending = await broker.handle({ op: "spend", payload: { description: "fake" } });
  const inbox = new ReplyInbox(ledger, { approvalProject: "test" });
  const r = inbox.register(pending.approvalId!, "approval", "test"); inbox.sent(r.requestId, sentAt);
  return { ledger, inbox, text: `approve:${r.requestId}:${r.nonce}` };
}
it.each([1, 119, 120])("accepts a Mac ahead by %s seconds and audits the observed gap", async (seconds) => {
  const s = await setup(); expect(s.inbox.accept({ id: "tap", text: s.text, time: 1000 - seconds }).status).toBe("counted");
  const audit = s.ledger.entries().find((e) => (e.data as { phase?: string }).phase === "clock-skew"); expect(audit).toBeDefined();
  expect(audit!.data).toMatchObject({ skewSeconds: seconds, id: "tap" });
});
it.each([121, 1000])("refuses a gap beyond the skew bound: %s", async (seconds) => {
  const s = await setup(); expect(s.inbox.accept({ id: "tap", text: s.text, time: 1000 - seconds })).toMatchObject({ status: "ignored", reason: "before-send" });
});
it.each([undefined, NaN, -1, 1000, 1000.5])("refuses missing, invalid or same-second times: %s", async (time) => {
  const s = await setup(); expect(s.inbox.accept({ id: "tap", text: s.text, ...(time === undefined ? {} : { time }) }).status).toBe("ignored");
});
it.each([1001, 1121, 99999])("later taps need no skew allowance or upper bound: %s", async (time) => {
  const s = await setup(); expect(s.inbox.accept({ id: "tap", text: s.text, time }).status).toBe("counted");
  expect(s.ledger.entries().some((e) => (e.data as { phase?: string }).phase === "clock-skew")).toBe(false);
});

it("bounds the allowance in milliseconds even when the send has fractional seconds", async () => {
  const s = await setup(1_000_500);
  expect(s.inbox.accept({ id: "too-old", text: s.text, time: 880 }).status).toBe("ignored");
  expect(s.inbox.accept({ id: "inside", text: s.text, time: 881 }).status).toBe("counted");
  const audit = s.ledger.entries().find((e) => (e.data as { phase?: string }).phase === "clock-skew"); expect(audit).toBeDefined();
  expect(audit!.data).toMatchObject({ skewSeconds: 119.5 });
});
