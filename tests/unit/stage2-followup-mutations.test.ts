import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("keeps follow-up mutation definitions applicable and uniquely named", () => {
  const files = ["packages/cli/src/intake/mutations-followup.json", "packages/cli/src/decisions/mutations-followup.json"];
  const mutations = files.flatMap((file) => JSON.parse(readFileSync(file, "utf8"))) as { name: string; file: string; anchor: string; replacement: string }[];
  expect(new Set(mutations.map((m) => m.name)).size).toBe(mutations.length);
  for (const mutation of mutations) {
    expect(readFileSync(mutation.file, "utf8").split(mutation.anchor).length - 1, mutation.name).toBe(1);
    expect(mutation.replacement).not.toBe(mutation.anchor);
  }
});
