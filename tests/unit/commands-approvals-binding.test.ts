import { rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { Broker, payloadHash, type Adapter } from "../../packages/cli/src/broker/broker.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { register as registerApprove } from "../../packages/cli/src/commands/approve.ts";
import { shortTmp } from "../helpers.ts";

// What `jarvis approve` shows is exactly what the broker will execute (decisions 12, 41; backlog 115):
// the shown payload hashes to the hash the answer binds, and the answer binds to the shown request.
const commanderPath = createRequire(new URL("../../packages/cli/package.json", import.meta.url)).resolve("commander");
const { Command } = await import(pathToFileURL(commanderPath).href) as typeof import("../../packages/cli/node_modules/commander/typings/index.js");
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })); });

function setup() {
  const root = shortTmp("j-approve-bind-"); roots.push(root);
  const ledger = Ledger.open(join(root, "projects", "test"));
  const executed: unknown[] = [];
  const adapter: Adapter = { op: "spend", execute: async (payload) => { executed.push(payload); return { outcome: "succeeded", detail: {} }; } };
  const broker = new Broker({ ledger, project: "test", adapters: [adapter], secrets: { get: () => undefined } });
  const output: string[] = [];
  const approve = (args: string[], extra = {}) => {
    const program = new Command().exitOverride();
    registerApprove(program, { jarvisHome: root, env: { JARVIS_PROJECT: "test" }, output: (s: string) => output.push(s), isTTY: () => false, ...extra });
    return program.parseAsync(args, { from: "user" });
  };
  const approvals = () => ledger.entries().filter((e) => e.kind === "approval");
  return { ledger, broker, executed, output, approve, approvals };
}

it("refuses a request whose shown payload is not the payload its hash binds", async () => {
  const s = setup();
  const shown = { description: "fake: buy one sticker", amount_usd: 1 };
  const unseen = { description: "fake: buy the domain", amount_usd: 5000 };
  s.ledger.append({ kind: "approval_request", actor: "broker", data: { approvalId: "mismatch", project: "test", op: "spend", payloadHash: payloadHash("spend", unseen), summary: "spend fake", payload: shown } });
  await expect(s.approve(["approve", "mismatch", "--yes"])).rejects.toThrow(/does not match its payload hash/);
  expect(s.output.join("\n")).not.toContain("buy one sticker");
  expect(s.approvals()).toEqual([]);
  // The unseen payload is still only pending: nothing was approved for it.
  expect((await s.broker.handle({ op: "spend", payload: unseen })).status).toBe("pending");
  expect(s.executed).toEqual([]);
});

it("refuses a request with no stored payload", async () => {
  const s = setup();
  s.ledger.append({ kind: "approval_request", actor: "broker", data: { approvalId: "bare", project: "test", op: "spend", payloadHash: payloadHash("spend", { description: "fake: unseen" }), summary: "spend" } });
  await expect(s.approve(["approve", "bare", "--yes"])).rejects.toThrow(/does not match its payload hash/);
  expect(s.approvals()).toEqual([]);
});

it("binds the recorded answer to the hash and operation it printed", async () => {
  const s = setup();
  const pending = await s.broker.handle({ op: "spend", payload: { description: "fake: one sticker" } });
  const decide = vi.spyOn(Broker.prototype, "decide");
  await s.approve(["approve", pending.approvalId!, "--yes"]);
  expect(decide).toHaveBeenCalledWith(pending.approvalId, "approve", expect.any(String), { payloadHash: pending.payloadHash, op: "spend" });
  expect(s.output.join("\n")).toContain(pending.payloadHash);
});

it("the broker refuses an answer for a request other than the one shown", async () => {
  const s = setup();
  const pending = await s.broker.handle({ op: "spend", payload: { description: "fake: one sticker" } });
  expect(() => s.broker.decide(pending.approvalId!, "approve", "test", { payloadHash: payloadHash("spend", { description: "fake: other" }), op: "spend" })).toThrow(/does not match/);
  expect(() => s.broker.decide(pending.approvalId!, "approve", "test", { payloadHash: pending.payloadHash, op: "data.delete" })).toThrow(/does not match/);
  expect(s.approvals()).toEqual([]);
  expect(s.broker.decide(pending.approvalId!, "approve", "test", { payloadHash: pending.payloadHash, op: "spend" })).toBe(true);
  expect(s.broker.decide(pending.approvalId!, "approve", "test")).toBe(false);
  expect(s.approvals()).toHaveLength(1);
});

it("says so when the same answer was recorded elsewhere while it waited", async () => {
  const s = setup();
  const pending = await s.broker.handle({ op: "spend", payload: { description: "fake: one sticker" } });
  await s.approve(["approve", pending.approvalId!], { isTTY: () => true, confirm: async () => { s.broker.decide(pending.approvalId!, "approve", "phone"); return "y"; } });
  const shown = s.output.join("\n");
  expect(shown).toMatch(/already approved/i);
  expect(shown).not.toContain(`Approved ${pending.approvalId}.`);
  expect(s.approvals().map((e) => (e.data as { by: string }).by)).toEqual(["phone"]);
});
