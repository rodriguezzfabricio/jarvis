import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { Broker } from "../../packages/cli/src/broker/broker.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { shortTmp } from "../helpers.ts";

// The real entry point: `jarvis approvals`, `approve` and `reject` are registered in cli.ts (backlog 115).
const cli = fileURLToPath(new URL("../../packages/cli/src/cli.ts", import.meta.url));
const root = shortTmp("j-cli-approvals-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

async function setup() {
  const home = join(root, `home-${++n}`);
  const ledger = Ledger.open(join(home, ".jarvis", "projects", "p"));
  const broker = new Broker({ ledger, project: "p", adapters: [], secrets: { get: () => undefined } });
  const pending = await broker.handle({ op: "email.send", payload: { to: "test@example.com", subject: "Report", body: "Please review the report." } });
  // A pipe on stdin, never a TTY: the non-interactive path.
  const jarvis = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", input: "y\n", env: { ...process.env, HOME: home, JARVIS_PROJECT: "p" } });
  const approvals = () => ledger.entries().filter((e) => e.kind === "approval");
  return { id: pending.approvalId!, hash: pending.payloadHash, jarvis, approvals };
}

it("lists approvals and approve/reject in jarvis --help", () => {
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  expect(help.status, help.stderr).toBe(0);
  for (const command of ["approvals", "approve", "reject"]) expect(help.stdout).toMatch(new RegExp(`^ {2}${command}\\b`, "m"));
});

it("lists a pending approval from the project named by JARVIS_PROJECT", async () => {
  const s = await setup();
  const r = s.jarvis("approvals", "--json");
  expect(r.status, r.stderr).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject([{ id: s.id, op: "email.send", payloadHashPrefix: s.hash.slice(0, 12) }]);
});

it.each(["approve", "reject"])("%s without a TTY prints the action, refuses without --yes, and records nothing", async (decision) => {
  const s = await setup();
  const r = s.jarvis(decision, s.id);
  expect(r.status).not.toBe(0);
  expect(r.stdout).toContain(s.hash);
  expect(`${r.stdout}${r.stderr}`).toContain("--yes");
  expect(s.approvals()).toEqual([]);
});

it.each(["approve", "reject"] as const)("%s --yes records the answer bound to the printed payload hash", async (decision) => {
  const s = await setup();
  const r = s.jarvis(decision, s.id, "--yes");
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toContain(s.hash);
  expect(s.approvals().map((e) => e.data)).toEqual([expect.objectContaining({ approvalId: s.id, payloadHash: s.hash, decision })]);
});
