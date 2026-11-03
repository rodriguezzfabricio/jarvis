import { join } from "node:path";
import { expect, it } from "vitest";
import { CLAUDE_CODE_VERSION, CODEX_VERSION, pinnedClaudeBin, pinnedCodexBin } from "../../packages/cli/src/config/pins.ts";

it("pins Claude directly inside its preserved signed bundle, outside the mutable versions directory", () => {
  expect(pinnedClaudeBin("/runner-home")).toBe(join("/runner-home", ".local", "share", "claude", "pinned-bundles", CLAUDE_CODE_VERSION, "claude.app", "Contents", "MacOS", "claude"));
});

it("pins Codex to a versioned native executable independent of npm global updates", () => {
  const home = "/runner-home";
  expect(pinnedCodexBin(home)).toBe(join(home, ".local", "share", "codex", "versions", CODEX_VERSION, "codex"));
});
