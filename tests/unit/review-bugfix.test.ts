// Decision 114: a bug fix is reviewed against the report, not against the builder's own test. When the
// review material says the task is a bug, the reviewer prompt carries the bug brief before the data block.

import { afterEach, describe, expect, it } from "vitest";
import { createReviewService, type ReviewMaterial } from "../../packages/cli/src/review/service.ts";
import { removeFixtureRoots, setup } from "./helpers/review-service-fixture.ts";

afterEach(removeFixtureRoots);

const BRIEF = [
  "fixes a reported bug",
  "every caller of the changed code and the data it really passes",
  "every configuration, service, entrypoint or platform",
  "at least two inputs or configurations that the candidate's own tests don't contain",
  "still shows the reported symptom",
  "the layer the report points at",
  "no case in the runner's evidence exercises the reported symptom",
];

async function promptFor(kind: "bug" | undefined): Promise<string> {
  const s = setup(1);
  const material: ReviewMaterial = await s.options.resolveMaterial();
  await createReviewService({ ...s.options, resolveMaterial: async () => ({ ...material, ...(kind ? { kind } : {}) }) }).review(s.request);
  return s.called[0]!.input.prompt;
}

describe("the bug-fix review brief", () => {
  it("tells the reviewer to check every path of the reported symptom, with new inputs, and the layer", async () => {
    const prompt = await promptFor("bug");
    for (const line of BRIEF) expect(prompt).toContain(line);
    // A path that still shows the symptom fails the review: high, with a concrete scenario.
    expect(prompt).toMatch(/still shows the reported symptom[^.]*high/);
    // The brief is instructions, ahead of the JSON data block (the last paragraph).
    const paragraphs = prompt.split("\n\n");
    expect(paragraphs.at(-1)!.startsWith("{")).toBe(true);
    expect(paragraphs.at(-1)!).not.toContain("fixes a reported bug");
  });

  it("leaves feature reviews without it", async () => {
    const prompt = await promptFor(undefined);
    for (const line of BRIEF) expect(prompt).not.toContain(line);
  });
});
