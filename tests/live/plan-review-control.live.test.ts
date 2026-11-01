import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { fixtureMaterial } from "../../packages/cli/src/commands/plan.ts";
import { createClaudeReviewer } from "../../packages/cli/src/harness/claude/review.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { createPlanReviewService, PLAN_POLICY_HASH, PLANTED_SCOPES } from "../../packages/cli/src/review/plan-service.ts";
import { DEFAULT_REVIEW_ROUTING } from "../../packages/cli/src/review/routing.ts";

/**
 * The Goldfish plan review's negative control (decision 170, the decision 56 pattern): the real pinned Claude
 * Code on the strong tier must fail the bad fixture naming every planted scope (T2, T3, D3) and pass the good
 * one. Runs only with JARVIS_LIVE=1 (six strong-tier read-only sessions of plan usage). Until it passes and the
 * pair is saved with `jarvis plan review --save-calibration <bad>:<good>`, plan reviews do not count and
 * `jarvis run` refuses every architect plan.
 */
const FIXTURES = fileURLToPath(new URL("../fixtures/plan-review/", import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), "plan-control-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

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
    for (const f of result.findings) console.log(`${f.id} [${f.severity}] ${f.scope}: ${f.finding}`);
    console.log(`bad control entry hash: ${result.entries.at(-1)!.hash}`);
    expect(result.error).toBeUndefined();
    expect(result.verdict).toBe("fail");
    expect((result.entries.at(-1)!.data as { planted: string[] }).planted).toEqual([...PLANTED_SCOPES]);
  }, 3_600_000);
  it("passes the good plan", async () => {
    const result = await service.review(fixtureMaterial("good", join(FIXTURES, "good"), join(workRoot, "good"), root), { fixture: "good" });
    for (const f of result.findings) console.log(`${f.id} [${f.severity}] ${f.scope}: ${f.finding}`);
    console.log(`good control entry hash: ${result.entries.at(-1)!.hash}; policy ${PLAN_POLICY_HASH}`);
    expect(result.error).toBeUndefined();
    expect(result.verdict).toBe("pass");
  }, 3_600_000);
});
