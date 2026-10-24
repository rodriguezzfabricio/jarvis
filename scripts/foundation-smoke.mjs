#!/usr/bin/env node
// A local integration example, not the stage's independent safety proof.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Broker } from "../packages/cli/src/broker/broker.ts";
import { outboxAdapters } from "../packages/cli/src/broker/outbox.ts";
import { startBrokerServer } from "../packages/cli/src/broker/server.ts";
import { Ledger } from "../packages/cli/src/ledger/ledger.ts";

const root = mkdtempSync(join(realpathSync("/tmp"), "j-smoke-"));
const project = join(root, "project");
const outbox = join(project, "outbox");
const socket = join(root, "broker.sock");
const cli = fileURLToPath(new URL("../packages/cli/src/cli.ts", import.meta.url));
const payload = { to: "nobody@example.invalid", subject: "Local foundation example", body: "Synthetic smoke-test message." };
let server;
let passed = false;

// Async child execution leaves the socket server free to answer the real CLI.
function act(body, expectedStatus, expectedExit) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cli, "act", "email.send", "--socket", socket, "--json", JSON.stringify(body)], {
      cwd: root,
      env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      try {
        assert.equal(error?.signal ?? null, null, `CLI was killed: ${stderr}`);
        assert.equal(error?.code ?? 0, expectedExit, `CLI exit for ${expectedStatus}: ${stderr}`);
        const result = JSON.parse(stdout);
        assert.equal(result.status, expectedStatus);
        resolve(result);
      } catch (failure) { reject(failure); }
    });
  });
}

try {
  const ledger = Ledger.open(project);
  const broker = new Broker({ ledger, project: "foundation-smoke", adapters: outboxAdapters(outbox), secrets: { get: () => undefined } });
  server = await startBrokerServer(broker, socket);
  const pending = await act(payload, "pending", 2);
  assert.equal(readdirSync(outbox).length, 0);
  assert.equal(typeof pending.approvalId, "string");
  console.log("1/5 PASS: unapproved CLI request stays pending; outbox is empty.");

  // Simulates the person's approval in this disposable, local-only example.
  broker.decide(pending.approvalId, "approve", "local smoke example");
  const changedPayload = { ...payload, body: "Changed after approval." };
  const changed = await act(changedPayload, "pending", 2);
  assert.equal(typeof changed.approvalId, "string");
  assert.notEqual(changed.approvalId, pending.approvalId);
  assert.notEqual(changed.payloadHash, pending.payloadHash);
  assert.equal(readdirSync(outbox).length, 0);
  console.log("2/5 PASS: changing the payload requires a separate approval.");

  const succeeded = await act(payload, "succeeded", 0);
  assert.equal(succeeded.payloadHash, pending.payloadHash);
  assert.equal(succeeded.receipt.payloadHash, pending.payloadHash);
  const files = readdirSync(outbox);
  assert.equal(files.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(outbox, files[0]), "utf8")), { op: "email.send", payload });
  assert.equal(ledger.entries().filter((entry) => entry.kind === "broker_receipt" && entry.data.status === "succeeded").length, 1);
  console.log("3/5 PASS: the approved payload creates one local outbox file and receipt.");

  await act(payload, "duplicate", 6);
  assert.equal(readdirSync(outbox).length, 1);
  assert.equal(ledger.verify().ok, true);
  console.log("4/5 PASS: retry exits 6 (duplicate); ledger verifies and delivery stays single.");

  // This payload is approved but has never executed: it would write a second file
  // if ledger tampering did not block the broker.
  broker.decide(changed.approvalId, "approve", "local smoke example");
  assert.equal(ledger.verify().ok, true);
  // Corrupt only the disposable ledger, retaining valid JSON to test the hash chain.
  const ledgerFile = join(project, "ledger.jsonl");
  const lines = readFileSync(ledgerFile, "utf8").trimEnd().split("\n");
  const first = JSON.parse(lines[0]);
  first.data.summary += " (tampered)";
  lines[0] = JSON.stringify(first);
  writeFileSync(ledgerFile, `${lines.join("\n")}\n`);
  const verification = ledger.verify();
  assert.equal(verification.ok, false);
  assert.ok(verification.problems.some((problem) => /hash mismatch/.test(problem)));
  const blocked = await act(changedPayload, "error", 8);
  assert.match(blocked.message, /ledger failed verification/);
  assert.equal(readdirSync(outbox).length, 1);
  console.log("5/5 PASS: ledger tampering makes the CLI fail closed with exit 8.");
  passed = true;
} finally {
  await server?.close();
  if (passed) rmSync(root, { recursive: true, force: true });
  else console.error(`Smoke failed; disposable evidence retained at ${root}`);
}
