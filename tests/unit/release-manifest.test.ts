import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { verifyEvidence } from "../../packages/cli/src/checks/gate.ts";
import { manifestHash, parseManifest, releaseRef } from "../../packages/cli/src/release/manifest.ts";
import { recordPlan, recordObservation, reachState } from "../../packages/cli/src/release/states.ts";
import { runRehearsal } from "../../packages/cli/src/release/rehearsal.ts";

const root = mkdtempSync(join(tmpdir(), "release-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
export const manifest = () => parseManifest({ version: 1, project: "p", revision: "a".repeat(40), provider: "vercel",
  artifactDir: "/trusted/artifacts", artifactHash: "c".repeat(64), siteId: "site-1", productionUrl: "https://app.example.com", smokePaths: ["/health"],
  rollback: { deploymentId: "old-deploy", url: "https://old.vercel.app", steps: ["Restore old deployment; verify /health."] },
  data: { kind: "none" } });

describe("release manifest", () => {
  it("hashes canonical content and binds the action to it", () => {
    const m = manifest();
    expect(manifestHash({ ...m })).toBe(manifestHash(m));
    expect(releaseRef(m, "preview")).toBe(`release:${manifestHash(m)}:preview`);
    expect(manifestHash({ ...m, smokePaths: ["/other"] })).not.toBe(manifestHash(m));
  });
  for (const path of ["https://evil.test", "//evil.test", "/../admin", "/%2e%2e/admin", "/health?token=x", "/a\\b"]) validatesPaths(path);
});
function validatesPaths(path: string) {
  it(`rejects unsafe smoke path ${path}`, () => expect(() => parseManifest({ ...manifest(), smokePaths: [path] })).toThrow());
}

function setup() {
  const ledger = Ledger.open(join(root, `p${++n}`));
  const m = manifest();
  const obs = (check: string, status: "pass" | "fail" = "pass", extra = {}) => recordObservation(ledger, m, check, status, extra);
  const receipt = (action: "preview" | "promote") => ledger.append({ kind: "broker_receipt", actor: "broker", data: {
    status: "succeeded", op: action === "preview" ? "deploy.preview" : "deploy.promote",
    payloadHash: "unused", detail: { manifestHash: manifestHash(m), action, url: action === "preview" ? "https://new.vercel.app" : m.productionUrl },
  } });
  const preview = receipt("preview");
  const production = receipt("promote");
  const plan = recordPlan(ledger, m);
  const lockHash = "d".repeat(64);
  ledger.append({ kind: "checks_approved", actor: "runner", data: { lockHash } });
  const observed = obs("test");
  const check = ledger.append({ kind: "gate_result", actor: "runner", data: { ...observed.data as object, check: "test", checksLock: lockHash } });
  const evidence = { checks: [check.seq], previewDeploy: preview.seq, previewSmoke: obs("preview", "pass", { deploymentSeq: preview.seq }).seq,
    manifest: plan.manifest.seq, rollback: plan.rollback.seq, rehearsal: obs("rehearsal").seq, restore: obs("restore").seq,
    production: production.seq, smoke: obs("smoke", "pass", { deploymentSeq: production.seq }).seq, failureSignal: obs("failure-signal").seq };
  return { ledger, m, obs, evidence };
}

describe("runner release states", () => {
  it.each(["preview-ready", "release-ready"] as const)("records %s only after checking its evidence", state => {
    const { ledger, m, evidence } = setup();
    const r = reachState({ ledger, manifest: m, state, evidence });
    expect(r.missing).toEqual([]);
    expect(r.entry).toMatchObject({ actor: "runner", kind: "state_reached", data: { state, manifestHash: manifestHash(m) } });
  });
  it("refuses deployed until a concrete failure_signal check exists even with all generic evidence", () => {
    const { ledger, m, evidence } = setup();
    const r = reachState({ ledger, manifest: m, state: "deployed", evidence });
    expect(r.missing).toEqual(["failureSignal"]); expect(r.entry).toBeUndefined();
  });
  it("lists every missing item and appends no state", () => {
    const { ledger, m } = setup();
    const r = reachState({ ledger, manifest: m, state: "deployed", evidence: {} });
    expect(r.missing).toEqual(expect.arrayContaining(["checks", "previewDeploy", "previewSmoke", "manifest", "rollback", "rehearsal", "restore", "production", "smoke", "failureSignal"]));
    expect(ledger.entries().filter(e => e.kind === "state_reached")).toHaveLength(0);
  });
  it.each(["tampered", "fail", "revision", "hash", "empty", "broker", "wrong-smoke", "stale-check"])("refuses %s evidence", mode => {
    const { ledger, m, evidence } = setup();
    const seq = evidence.checks[0]!;
    const original = ledger.entries().find(e => e.seq === seq)!;
    if (mode === "tampered") {
      const d = original.data as { evidence: { dir: string } };
      writeFileSync(join(d.evidence.dir, "observation.json"), "edited");
    } else if (mode === "broker") evidence.production = evidence.checks[0]!;
    else if (mode === "wrong-smoke") evidence.smoke = evidence.previewSmoke;
    else {
      const data = original.data as Record<string, unknown>;
      evidence.checks = [ledger.append({ kind: "gate_result", actor: "runner", data: { ...data,
        ...(mode === "fail" ? { status: "fail" } : {}), ...(mode === "revision" ? { revision: "b".repeat(40) } : {}),
        ...(mode === "hash" ? { manifestHash: "wrong" } : {}), ...(mode === "empty" ? { evidence: { dir: root, files: {} } } : {}),
      } }).seq];
      if (mode === "stale-check") ledger.append({ kind: "gate_result", actor: "runner", data: { ...data, status: "fail" } });
    }
    expect(reachState({ ledger, manifest: m, state: "deployed", evidence }).missing).toContain(mode === "broker" ? "production" : mode === "wrong-smoke" ? "smoke" : "checks");
  });
  it("captures manifest and rollback files with hashes", () => {
    const { ledger, m } = setup();
    const plan = recordPlan(ledger, m);
    expect(verifyEvidence(plan.manifest).ok).toBe(true);
    expect(verifyEvidence(plan.rollback).ok).toBe(true);
  });
  it("rejects a broker-authored gate and later rollback when claiming deployed", () => {
    const { ledger, m, evidence } = setup();
    const check = ledger.entries().find(e => e.seq === evidence.checks[0])!;
    evidence.checks = [ledger.append({ actor: "broker", kind: "gate_result", data: check.data }).seq];
    expect(reachState({ ledger, manifest: m, state: "deployed", evidence }).missing).toContain("checks");
    evidence.checks = [check.seq];
    ledger.append({ kind: "broker_receipt", actor: "broker", data: { status: "succeeded", op: "deploy.promote", detail: { manifestHash: manifestHash(m), action: "rollback", url: m.rollback.url } } });
    expect(reachState({ ledger, manifest: m, state: "deployed", evidence }).missing).toContain("production");
  });
  it.each(["release-observation", "unapproved-lock", "missing-hash", "omitted-failure"])("rejects %s used as readiness proof", mode => {
    const { ledger, m, evidence, obs } = setup();
    if (mode === "release-observation") evidence.checks = [obs("manifest").seq];
    if (mode === "unapproved-lock") ledger.append({ kind: "checks_approved", actor: "runner", data: { lockHash: "changed" } });
    if (mode === "omitted-failure") {
      const original = ledger.entries().find(e => e.seq === evidence.checks[0])!;
      ledger.append({ kind: "gate_result", actor: "runner", data: { ...original.data as object, check: "other-required-check", status: "fail" } });
    }
    if (mode === "missing-hash") {
      const original = ledger.entries().find(e => e.seq === evidence.manifest)!;
      const { manifestHash: _hash, ...rest } = original.data as Record<string, unknown>;
      evidence.manifest = ledger.append({ kind: "gate_result", actor: "runner", data: rest }).seq;
    }
    expect(reachState({ ledger, manifest: m, state: "deployed", evidence }).missing).toContain(mode === "missing-hash" ? "manifest" : "checks");
  });
});

describe("migration rehearsal on a copy", () => {
  it("copies SQLite, migrates, backs up, restores and verifies in order without altering the source", async () => {
    const ledger = Ledger.open(join(root, `db${++n}`));
    const source = join(root, `source${n}.sqlite`);
    writeFileSync(source, "original");
    const m = parseManifest({ ...manifest(), data: { kind: "sqlite", source, commands: { migrate: "migrate", backup: "backup", restore: "restore", verify: "verify" } } });
    const seen: string[] = [];
    const result = await runRehearsal({ ledger, manifest: m, snapshotRoot: root, workRoot: root, execute: async spec => {
      seen.push(spec.command);
      expect(spec.cwd).not.toBe(root);
      expect(spec.env.JARVIS_DATA_COPY).not.toBe(source);
      expect(spec.env).not.toHaveProperty("DATABASE_URL");
      if (spec.command === "migrate") writeFileSync(spec.env.JARVIS_DATA_COPY!, "migrated");
      if (spec.command === "backup") writeFileSync(spec.env.JARVIS_BACKUP!, readFileSync(spec.env.JARVIS_DATA_COPY!));
      if (spec.command === "restore") writeFileSync(spec.env.JARVIS_DATA_COPY!, readFileSync(spec.env.JARVIS_BACKUP!));
      return { code: 0, timedOut: false, overflowed: false, durationMs: 1, stdout: "ok", stderr: "" };
    } });
    expect(seen).toEqual(["migrate", "verify", "backup", "restore", "verify"]);
    expect(readFileSync(source, "utf8")).toBe("original");
    expect(result.rehearsal.data).toMatchObject({ status: "pass" });
    expect(result.restore.data).toMatchObject({ status: "pass" });
    expect(verifyEvidence(result.restore).ok).toBe(true);
  });
  it.each(["migrate", "backup", "restore", "verify"])("fails closed when %s fails", async command => {
    const ledger = Ledger.open(join(root, `fail${++n}`));
    const source = join(root, `dump${n}`); writeFileSync(source, "copy");
    const m = parseManifest({ ...manifest(), data: { kind: "postgres", source, commands: { migrate: "migrate", backup: "backup", restore: "restore", verify: "verify" } } });
    const result = await runRehearsal({ ledger, manifest: m, snapshotRoot: root, workRoot: root, execute: async spec => {
      if (spec.command === "backup") writeFileSync(spec.env.JARVIS_BACKUP!, "backup");
      if (spec.command === "restore") writeFileSync(spec.env.JARVIS_DATA_COPY!, "restored");
      return { code: spec.command === command ? 1 : 0, timedOut: false, overflowed: false, durationMs: 1, stdout: "", stderr: "" };
    } });
    expect(result.restore.data).toMatchObject({ status: "fail" });
    expect(result.rehearsal.data).toMatchObject({ status: command === "migrate" || command === "verify" ? "fail" : "pass" });
  });
});
