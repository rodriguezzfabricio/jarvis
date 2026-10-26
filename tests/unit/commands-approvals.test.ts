import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { Broker, payloadHash } from "../../packages/cli/src/broker/broker.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { register, readApprovals } from "../../packages/cli/src/commands/approvals.ts";
import { register as registerApprove } from "../../packages/cli/src/commands/approve.ts";
import { shortTmp } from "../helpers.ts";

const commanderPath = createRequire(new URL("../../packages/cli/package.json", import.meta.url)).resolve("commander");
const { Command } = await import(pathToFileURL(commanderPath).href) as typeof import("../../packages/cli/node_modules/commander/typings/index.js");
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })); });
async function setup() {
  const root = shortTmp("j-approval-ui-"); roots.push(root);
  const dir = join(root, "projects", "test"); const ledger = Ledger.open(dir);
  const broker = new Broker({ ledger, project: "test", adapters: [], secrets: { get: () => undefined } });
  const p = await broker.handle({ op: "email.send", payload: { to: "test@example.com", subject: "Report", body: "Please review the report." } });
  const output: string[] = [];
  const make = (extra = {}) => {
    const program = new Command().exitOverride();
    const seams = { jarvisHome: root, env: { JARVIS_PROJECT: "test" }, output: (s: string) => output.push(s), isTTY: () => false, ...extra };
    register(program, seams); registerApprove(program, seams); return program;
  };
  return { root, dir, ledger, broker, id: p.approvalId!, hash: p.payloadHash, output, make };
}
it("lists pending summaries as JSON without payloads, writes, or unresolved foreign projects", async () => {
  const s = await setup(); const other = new Broker({ ledger: s.ledger, project: "foreign", adapters: [], secrets: { get: () => undefined } });
  await other.handle({ op: "spend", payload: { description: "foreign" } });
  const answered = await s.broker.handle({ op: "spend", payload: { description: "answered" } });
  s.broker.decide(answered.approvalId!, "reject", "test");
  s.ledger.append({ kind: "approval", actor: "runner", data: { approvalId: s.id, payloadHash: "wrong", op: "email.send", decision: "approve" } });
  const before = readFileSync(join(s.dir, "ledger.jsonl"), "utf8"), files = readdirSync(s.dir);
  await s.make().parseAsync(["approvals", "--json"], { from: "user" });
  const list = JSON.parse(s.output.join("\n"));
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ id: s.id, op: "email.send", payloadHashPrefix: s.hash.slice(0, 12), taskId: null, sessionId: null });
  expect(list[0].requestedAt).toMatch(/^\d{4}-/); expect(list[0].summary).toContain("test@example.com");
  expect(list[0]).not.toHaveProperty("payload");
  expect(readFileSync(join(s.dir, "ledger.jsonl"), "utf8")).toBe(before); expect(readdirSync(s.dir)).toEqual(files);
});
it("reads attribution when recorded, including legacy requests in the selected ledger", async () => {
  const s = await setup();
  s.ledger.append({ kind: "approval_request", actor: "broker", task_id: "T1", attempt_id: "attempt-1", data: { approvalId: "legacy", op: "spend", summary: "Legacy", payloadHash: "a".repeat(64), payload: { description: "legacy" }, sessionId: "session-1" } });
  const list = readApprovals(s.dir, "test");
  expect(list.find((a) => a.id === "legacy")).toMatchObject({ taskId: "T1", attemptId: "attempt-1", sessionId: "session-1" });
});
it("fails closed on tampering and contention and does not create a missing project", async () => {
  const s = await setup(); const missing = join(s.root, "absent");
  expect(readApprovals(missing, "test")).toEqual([]); expect(existsSync(missing)).toBe(false);
  expect(() => readApprovals(s.dir, "test", () => ({ ok: false, contended: true, entries: [], problems: [], repairable: [] }))).toThrow(/contended/);
  writeFileSync(join(s.dir, "ledger.jsonl"), readFileSync(join(s.dir, "ledger.jsonl"), "utf8").replace('"Report"', '"Forged"'));
  const error = await s.make().parseAsync(["approve", s.id, "--yes"], { from: "user" }).then(() => undefined, (e: unknown) => e);
  expect(s.output).toEqual([]); expect(error).toBeInstanceOf(Error); expect((error as Error).message).toMatch(/verification/);
});
it.each(["approve", "reject"])("prints full %s action before recording and never executes it", async (decision) => {
  const s = await setup(); const handle = vi.spyOn(Broker.prototype, "handle");
  const original = Broker.prototype.decide;
  vi.spyOn(Broker.prototype, "decide").mockImplementation(function (this: Broker, ...args) {
    const shown = s.output.join("\n");
    expect(shown).toContain("email.send"); expect(shown).toContain("Please review the report."); expect(shown).toContain(s.hash);
    expect(shown).toContain('  "body":'); return original.apply(this, args);
  });
  await s.make().parseAsync([decision, s.id, "--yes"], { from: "user" });
  expect(s.ledger.entries().at(-1)?.data).toMatchObject({ decision }); expect(handle).not.toHaveBeenCalled();
});
it.each(["approve", "reject"])("requires --yes for non-TTY %s", async (decision) => {
  const s = await setup();
  const error = await s.make({ confirm: async () => "yes" }).parseAsync([decision, s.id], { from: "user" }).then(() => undefined, (e: unknown) => e);
  expect(s.ledger.entries().filter((e) => e.kind === "approval")).toEqual([]);
  expect(s.output.join("\n")).toContain(s.hash); expect(error).toBeInstanceOf(Error); expect((error as Error).message).toMatch(/--yes/);
});
it.each(["", "n", "yes please", "y", "YES"])("TTY confirmation is explicit and defaults to no: %j", async (answer) => {
  const s = await setup(); const confirm = vi.fn(async (prompt: string) => { expect(s.output.join("\n")).toContain(s.hash); expect(prompt).toBe("Approve? [y/N] "); return answer; });
  await s.make({ isTTY: () => true, confirm }).parseAsync(["approve", s.id], { from: "user" });
  expect(confirm).toHaveBeenCalledOnce(); expect(s.ledger.entries().filter((e) => e.kind === "approval")).toHaveLength(/^(y|yes)$/i.test(answer) ? 1 : 0);
});
it("refuses an answer that raced the prompt", async () => {
  const s = await setup();
  await expect(s.make({ isTTY: () => true, confirm: async () => { s.broker.decide(s.id, "reject", "phone"); return "y"; } }).parseAsync(["approve", s.id], { from: "user" })).rejects.toThrow(/already answered/);
  expect(s.ledger.entries().filter((e) => e.kind === "approval")).toHaveLength(1);
});
it("redacts secret-looking values and terminal controls in payloads and summaries", async () => {
  const s = await setup(); const fake = "ghp_" + "x".repeat(36);
  const p = await s.broker.handle({ op: "spend", payload: { description: `token=${fake}\u001b[2J`, target: "https://user:fake-pass@example.invalid" } });
  await s.make().parseAsync(["approve", p.approvalId!, "--yes"], { from: "user" });
  const shown = s.output.join("\n"); expect(shown).not.toContain(fake); expect(shown).not.toContain("fake-pass"); expect(shown).not.toContain("\u001b"); expect(shown).toContain("redacted");
  s.output.length = 0; await s.make().parseAsync(["approvals"], { from: "user" }); expect(s.output.join("\n")).toContain(s.id);
});
it("a display failure cannot approve", async () => {
  const s = await setup();
  await expect(s.make({ output: () => { throw new Error("display fault"); } }).parseAsync(["approve", s.id, "--yes"], { from: "user" })).rejects.toThrow("display fault");
  expect(s.ledger.entries().filter((e) => e.kind === "approval")).toEqual([]);
});
it("redacts nested secret fields and ordinary assignments even for fake-looking values", async () => {
  const s = await setup();
  const payload = { credentials: { user: "fake-user" }, values: [{ apiKey: "fake-key" }], description: "password=fake-password" };
  s.ledger.append({ kind: "approval_request", actor: "broker", data: { approvalId: "nested", project: "test", op: "spend", payloadHash: payloadHash("spend", payload), summary: "password=fake-password", payload } });
  await s.make().parseAsync(["approve", "nested", "--yes"], { from: "user" });
  const shown = s.output.join("\n");
  for (const secret of ["fake-user", "fake-key", "fake-password"]) expect(shown).not.toContain(secret);
  expect(shown).toContain('"values": [');
});
