import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { fixtureMaterial } from "../../packages/cli/src/commands/plan.ts";
import { createClaudeReviewer } from "../../packages/cli/src/harness/claude/review.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { createPlanReviewService, lensDiagnostics, PLAN_POLICY_HASH, PLANTED_SCOPES, type PlanReviewResult } from "../../packages/cli/src/review/plan-service.ts";
import { DEFAULT_REVIEW_ROUTING } from "../../packages/cli/src/review/routing.ts";

/**
 * The Goldfish plan review's negative control (decision 170, the decision 56 pattern): the real pinned Claude
 * Code on the strong tier must fail the bad fixture naming every planted scope (T2, T3, D3) and pass the good
 * one. Runs only with JARVIS_LIVE=1 (six strong-tier read-only sessions of plan usage). Until it passes and the
 * pair is saved with `jarvis plan review --save-calibration <bad>:<good>`, plan reviews do not count and
 * `jarvis run` refuses every architect plan.
 *
 * Every run prints each lens's verdict, validity, checks and error. A failed half also prints the invalid lens's
 * session outcome and the start of its reply, and keeps the evidence folder, so the next run can be diagnosed
 * without rerunning six sessions.
 */
const FIXTURES = fileURLToPath(new URL("../fixtures/plan-review/", import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), "plan-control-")));
let keep = false;
afterAll(() => { if (!keep) rmSync(root, { recursive: true, force: true }); });

/** The lens lines always; for each invalid lens, what its session returned (from the evidence the service kept). */
function diagnose(result: PlanReviewResult): void {
  for (const line of lensDiagnostics(result.entries)) console.log(line);
  for (const entry of result.entries) {
    const d = entry.data as { lens: string; valid?: boolean; evidence?: { dir: string } };
    if (d.lens === "overall" || d.valid !== false || !d.evidence) continue;
    try {
      const raw = JSON.parse(readFileSync(join(d.evidence.dir, "raw.json"), "utf8")) as { rawVerdict?: string; error?: string; sessionOutcome?: unknown; rawOutput?: string };
      console.log(`${d.lens} session: ${JSON.stringify(raw.sessionOutcome ?? raw.error ?? null)}`);
      const events = (JSON.parse(raw.rawOutput ?? "{}") as { stdout?: string }).stdout?.split("\n") ?? [];
      const final = events.map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return undefined; } }).filter((e) => e?.type === "result").at(-1);
      if (final) console.log(`${d.lens} result event: ${JSON.stringify({ subtype: final.subtype, is_error: final.is_error, num_turns: final.num_turns, duration_ms: final.duration_ms })}`);
      const text = raw.rawVerdict ?? "";
      console.log(`${d.lens} reply (${text.length} chars): ${text.slice(0, 1500)}${text.length > 1500 ? " …" : ""}`);
    } catch (caught) { console.log(`${d.lens} evidence unreadable: ${String(caught)}`); }
  }
}
function report(fixture: "bad" | "good", result: PlanReviewResult, ok: boolean): void {
  for (const f of result.findings) console.log(`${f.id} [${f.severity}] ${f.scope}: ${f.finding}`);
  console.log(`${fixture} control entry hash: ${result.entries.at(-1)!.hash}; verdict ${result.verdict}; policy ${PLAN_POLICY_HASH}`);
  diagnose(result);
  if (!ok) { keep = true; console.log(`${fixture} control failed: evidence kept under ${root}`); }
}

describe.skipIf(process.env.JARVIS_LIVE !== "1")("live plan review negative control", () => {
  const jarvisHome = join(root, "jarvis"), projectDir = join(jarvisHome, "projects", "plan-control"), workRoot = join(root, "work"), cacheRoot = join(workRoot, "caches");
  for (const d of [jarvisHome, projectDir, workRoot, cacheRoot]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const ledger = Ledger.open(projectDir);
  const service = createPlanReviewService({
    ledger, projectDir, workRoot, routing: DEFAULT_REVIEW_ROUTING, home: root, jarvisHome,
    claude: createClaudeReviewer({ jarvisHome, workRoot, cacheRoot, preflight: async () => ({ ok: true }) }),
  });
  it("fails the planted bad plan, naming T2 (duplicate util), T3 (storage left to the builder) and D3 (no alternative)", async () => {
    const result = await service.review(fixtureMaterial("bad", join(FIXTURES, "bad"), join(workRoot, "bad"), root), { fixture: "bad" });
    const planted = (result.entries.at(-1)!.data as { planted: string[] }).planted;
    report("bad", result, result.error === undefined && result.verdict === "fail" && PLANTED_SCOPES.every((scope) => planted.includes(scope)));
    expect(result.error).toBeUndefined();
    expect(result.verdict).toBe("fail");
    expect(planted).toEqual([...PLANTED_SCOPES]);
  }, 3_600_000);
  it("passes the good plan", async () => {
    const result = await service.review(fixtureMaterial("good", join(FIXTURES, "good"), join(workRoot, "good"), root), { fixture: "good" });
    report("good", result, result.error === undefined && result.verdict === "pass");
    expect(result.error).toBeUndefined();
    expect(result.verdict).toBe("pass");
  }, 3_600_000);
});
