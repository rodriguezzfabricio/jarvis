import { afterEach, expect, it } from "vitest";
import { createReviewService } from "../../packages/cli/src/review/service.ts";
import { removeFixtureRoots, setup } from "./helpers/review-service-fixture.ts";

// Decision 169. The build skill's side of the rule is pinned with the skill's other phrases in skills-build.test.ts.
afterEach(removeFixtureRoots);
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
