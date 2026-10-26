// Loop reviewer boundary tests, part 2 of 2 (findings, redaction and evidence checks). The tests are split over two files so they run in parallel;
// the shared fixture is tests/unit/helpers/review-service-fixture.ts.

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { createReviewService } from "../../packages/cli/src/review/service.ts";
import { removeFixtureRoots, setup, sha } from "./helpers/review-service-fixture.ts";

afterEach(removeFixtureRoots);

describe("loop reviewer boundary", () => {
  it("holds uncertain high-impact findings and explains investigation in the ledger", async () => {
    const s = setup(); const finding = { severity: "high", confidence: 0.2, impact: "security", file: "app.txt", line: 1, scenario: "Possible private destination fetch", fix: "Verify address validation" };
    s.codex.mockResolvedValue({ reviewer: "codex", model: "gpt-6.1-sol", rawOutput: "uncertain", rawVerdict: JSON.stringify({ findings: [finding] }) });
    const service = createReviewService(s.options); const r = await service.reviewDetailed(s.request);
    expect(r.verdict).toBe("investigate");
    expect(r.entry.data).toMatchObject({ verdict: "investigate", reason: "review_investigation", investigate: [finding] });
    expect((r.entry.data as { summary: string }).summary).toMatch(/investigation/i);
    expect(await service.review(s.request)).toBe("fail");
  });
  it("records Codex infrastructure errors distinctly and maps them to review_error", async () => {
    const s = setup(); s.codex.mockResolvedValue({ reviewer: "codex", model: "gpt-6.1-sol", rawOutput: "connection failed", rawVerdict: "", error: "connection failed" });
    const service = createReviewService(s.options); const r = await service.reviewDetailed(s.request);
    expect(r.verdict).toBe("error");
    expect(r.entry.data).toMatchObject({ status: "error", verdict: "error", reason: "review_error" });
    expect(await service.review(s.request)).toBe("fail");
    expect(s.claude).toHaveBeenCalledTimes(2);
  });
  it.each(["file", "scenario", "fix"])("fingerprints secret-looking tokens in finding %s before ledger storage", async (field) => {
    const s = setup(); const token = "sk-" + "A".repeat(40);
    const finding = { severity: "high", confidence: 0.9, impact: "security", file: "app.txt", line: 1, scenario: "A request leaks a credential", fix: "Remove the credential", [field]: token };
    s.codex.mockResolvedValue({ reviewer: "codex", model: "gpt-6.1-sol", rawOutput: token, rawVerdict: JSON.stringify({ findings: [finding] }) });
    const r = await createReviewService(s.options).reviewDetailed(s.request);
    expect(JSON.stringify(r.entry.data)).not.toContain(token);
    expect(JSON.stringify(r.entry.data)).toContain("[redacted:sha256:" + sha(token) + "]");
  });
  it("fingerprints a synthetic JWT quoted in an investigation scenario", async () => {
    const s = setup(); const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJub3QtcmVhbCJ9.c3ludGhldGljLXNpZ25hdHVyZQ";
    const finding = { severity: "critical", confidence: 0.2, impact: "security", file: "app.txt", line: 1, scenario: token, fix: "Do not quote credentials" };
    s.codex.mockResolvedValue({ reviewer: "codex", model: "gpt-6.1-sol", rawOutput: token, rawVerdict: JSON.stringify({ findings: [finding] }) });
    const r = await createReviewService(s.options).reviewDetailed(s.request);
    expect(JSON.stringify(r.entry.data)).not.toContain(token);
    expect(JSON.stringify(r.entry.data)).toContain("[redacted:sha256:" + sha(token) + "]");
  });
  it("fingerprints opaque auth fields and infrastructure diagnostics before ledger storage", async () => {
    const s = setup(); const diagnostic = '{"access_token":"synthetic-opaque-value"}';
    s.codex.mockResolvedValue({ reviewer: "codex", model: "gpt-6.1-sol", rawOutput: diagnostic, rawVerdict: "", error: diagnostic });
    const r = await createReviewService(s.options).reviewDetailed(s.request);
    expect(JSON.stringify(r.entry.data)).not.toContain("synthetic-opaque-value");
    expect(JSON.stringify(r.entry.data)).toContain("[redacted:sha256:" + sha(diagnostic) + "]");
  });
  it("rejects swapped git objects before exposing a checkout to a reviewer", async () => {
    const { deflateSync } = await import("node:zlib");
    const s = setup();
    const material = await s.options.resolveMaterial();
    const blob = safeGit(material.repoPath, ["rev-parse", "HEAD:app.txt"], { home: s.root }).toString().trim();
    const path = join(material.repoPath, ".git/objects", blob.slice(0, 2), blob.slice(2));
    chmodSync(path, 0o600); writeFileSync(path, deflateSync(Buffer.from("blob 6\u0000evil!\n")));
    expect(await createReviewService(s.options).review(s.request)).toBe("fail");
    expect(s.called).toHaveLength(0);
  });
  it("rejects tampered gate evidence before launching a reviewer", async () => {
    const s = setup(); writeFileSync(join(s.evidenceDir, "stdout"), "fake proof");
    expect(await createReviewService(s.options).review(s.request)).toBe("fail");
    expect(s.called).toHaveLength(0);
  });
  it("rejects evidence for a different attempt", async () => {
    const s = setup(); s.request.attemptId = "A2";
    expect(await createReviewService(s.options).review(s.request)).toBe("fail"); expect(s.called).toHaveLength(0);
  });
  it("rejects evidence for a different revision", async () => {
    const s = setup(); s.request.revision = s.baseRevision;
    expect(await createReviewService(s.options).review(s.request)).toBe("fail"); expect(s.called).toHaveLength(0);
  });
});
