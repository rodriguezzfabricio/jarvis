import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { createReviewService } from "../../packages/cli/src/review/service.ts";
import { removeFixtureRoots, setup } from "./helpers/review-service-fixture.ts";

afterEach(removeFixtureRoots);
it("build instructions prohibit weakening security to make a task work", () => {
  const skill = readFileSync(new URL("../../skills/build/SKILL.md", import.meta.url), "utf8");
  expect(skill).toContain("Never make something work by disabling or weakening a security control");
  for (const control of ["sandbox", "TLS or certificate verification", "auth or permission check", "input validation", "isolation boundary"]) expect(skill).toContain(control);
  expect(skill).toContain("Fix the cause, or stop and report when the fix needs a decision");
});
it("every code reviewer must flag a weakened control as high unless the spec explicitly asks for it, and quote the line", async () => {
  const f = setup();
  await createReviewService(f.options).reviewDetailed(f.request);
  expect(f.called).toHaveLength(2);
  for (const { input } of f.called) {
    expect(input.prompt).toContain("A change that disables or weakens a security control is a high finding unless the spec explicitly asks for it");
    expect(input.prompt).toContain("Quote the changed line");
    for (const control of ["sandbox", "TLS or certificate verification", "auth or permission check", "input validation", "isolation boundary"]) expect(input.prompt).toContain(control);
  }
});
