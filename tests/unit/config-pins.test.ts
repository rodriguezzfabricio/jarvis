import { join } from "node:path";
import { expect, it } from "vitest";
import { CODEX_VERSION, pinnedCodexBin } from "../../packages/cli/src/config/pins.ts";

it("pins Codex to a versioned native executable independent of npm global updates", () => {
  const home = "/runner-home";
  expect(pinnedCodexBin(home)).toBe(join(home, ".local", "share", "codex", "versions", CODEX_VERSION, "codex"));
});
