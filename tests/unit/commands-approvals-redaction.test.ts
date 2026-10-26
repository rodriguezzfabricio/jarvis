import { rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { Broker, type BrokerRequest } from "../../packages/cli/src/broker/broker.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { register as registerApprove } from "../../packages/cli/src/commands/approve.ts";
import { register as registerApprovals } from "../../packages/cli/src/commands/approvals.ts";
import { shortTmp } from "../helpers.ts";

// Redaction hides secret-looking values, never where an action goes (backlog 115): a person can't
// approve a recipient, ref or target they can't see, and what is printed is what the broker gets.
const commanderPath = createRequire(new URL("../../packages/cli/package.json", import.meta.url)).resolve("commander");
const { Command } = await import(pathToFileURL(commanderPath).href) as typeof import("../../packages/cli/node_modules/commander/typings/index.js");
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })); });

async function shown(request: BrokerRequest, command = "approve") {
  const root = shortTmp("j-approve-redact-"); roots.push(root);
  const ledger = Ledger.open(join(root, "projects", "test"));
  const pending = await new Broker({ ledger, project: "test", adapters: [], secrets: { get: () => undefined } }).handle(request);
  expect(pending.status).toBe("pending");
  const output: string[] = [];
  const program = new Command().exitOverride();
  const seams = { jarvisHome: root, env: { JARVIS_PROJECT: "test" }, output: (s: string) => output.push(s), isTTY: () => true, confirm: async () => "n" };
  registerApprove(program, seams); registerApprovals(program, seams);
  await program.parseAsync(command === "approve" ? ["approve", pending.approvalId!] : ["approvals"], { from: "user" });
  const text = output.join("\n");
  const block = /\nPayload:\n([\s\S]*)\nPayload hash: /.exec(text)?.[1];
  return { text, payload: block === undefined ? undefined : JSON.parse(block) as unknown };
}

const sha = "0123456789abcdef0123456789abcdef01234567";
it.each<[string, BrokerRequest, string]>([
  ["a commit SHA ref", { op: "deploy.promote", payload: { ref: sha } }, sha],
  ["a repository path target", { op: "git.create_remote", payload: { description: "Create the portfolio repo", target: "github.com/rodriguezzfabricio/jarvis-portfolio-site" } }, "github.com/rodriguezzfabricio/jarvis-portfolio-site"],
  ["a recipient whose name looks like a key", { op: "email.send", payload: { to: "AKIAIOSFODNN7EXAMPLE@evil.example", subject: "Report", body: "Fake report." } }, "AKIAIOSFODNN7EXAMPLE@evil.example"],
  ["a long bucket name in a description", { op: "data.delete", payload: { description: "Delete bucket company-prod-backups-2026-10-26-full-set" } }, "company-prod-backups-2026-10-26-full-set"],
])("shows %s verbatim", async (_label, request, target) => {
  const s = await shown(request);
  expect(s.text).toContain(target);
  expect(s.payload).toEqual(request.payload);
});

it("hides URL credentials in a target but keeps its host", async () => {
  const s = await shown({ op: "spend", payload: { description: "Pay the invoice", target: "https://user:fake-pass@billing.example.invalid/pay" } });
  expect(s.text).not.toContain("fake-pass");
  expect(s.text).toContain("@billing.example.invalid/pay");
});

it("hides a secret-looking value in free text and keeps the words around it", async () => {
  const fake = "ghp_" + "x".repeat(36);
  const s = await shown({ op: "email.send", payload: { to: "test@example.com", subject: "Keys", body: `Here is the token ${fake} for the deploy at deploy.example.invalid` } });
  expect(s.text).not.toContain(fake);
  expect(s.text).toContain("deploy.example.invalid");
  expect(s.text).toContain("Here is the token");
});

it("hides a JWT-shaped value in free text", async () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.ZmFrZS1zaWduYXR1cmU";
  const s = await shown({ op: "spend", payload: { description: `Use session ${jwt} to pay`, target: "billing.example.invalid" } });
  expect(s.text).not.toContain(jwt);
  expect(s.text).toContain("Use session [redacted] to pay");
});

it("hides a password written as an assignment inside a sentence", async () => {
  const s = await shown({ op: "spend", payload: { description: "Log in with password = fake-password-value then pay", target: "billing.example.invalid" } });
  expect(s.text).not.toContain("fake-password-value");
  expect(s.text).toContain("Log in with password = [redacted] then pay");
});

it("hides the whole text when a secret spans several words, never the recipient", async () => {
  const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAfakefakefake\n-----END RSA PRIVATE KEY-----";
  const s = await shown({ op: "email.send", payload: { to: "fabricio@example.com", subject: "Key", body: `Here it is:\n${key}` } });
  expect(s.text).not.toContain("MIIEowIBAAKCAQEAfakefakefake");
  expect(s.text).toMatch(/\[redacted: \d+ characters with a secret-looking value\]/);
  expect(s.text).toContain("fabricio@example.com");
});

it.each([
  ["a zero-width space", "pay\u200bpal.example", "\\u200b"],
  ["a right-to-left override", "evil\u202eelpmaxe.com", "\\u202e"],
  ["a line separator", "a\u2028b", "\\u2028"],
  ["a no-break space", "a\u00a0b", "\\u00a0"],
])("prints %s as an escape, so the printed payload is the approved one", async (_label, target, escape) => {
  const request: BrokerRequest = { op: "spend", payload: { description: "Fake", target } };
  const s = await shown(request);
  expect(s.text).toContain(escape);
  expect(s.text).not.toContain(target);
  expect(s.payload).toEqual(request.payload);
});

it("lists targets in jarvis approvals without hiding them", async () => {
  const s = await shown({ op: "deploy.promote", payload: { ref: sha } }, "approvals");
  expect(s.text).toContain(sha);
});
