import { vi } from "vitest";
import { nativeGitComparisons } from "./helpers/native-git-comparisons.ts";
import { nativeGitApis } from "./helpers/native-git-test.ts";

// Exercise the original comparison assertions using only absolute controlled executables.
// The normal 75-case plan remains unchanged, including its host lookup cases.
vi.mock("./helpers/native-git-test.ts", async importOriginal => ({
  ...await importOriginal<typeof import("./helpers/native-git-test.ts")>(),
  comparisonBatches: [["CPATH"], ["LIBRARY_PATH"], ["MANPATH"], ["SDKROOT"]],
}));
for (const api of nativeGitApis) nativeGitComparisons(api);
