import { describe, expect, it } from "vitest";
import { buildChildEnv, findForbiddenEnv } from "../../packages/cli/src/harness/claude/env.ts";

const shell = {
  HOME: "/Users/f",
  USER: "f",
  PATH: "/evil/bin:/usr/bin",
  ANTHROPIC_API_KEY: "sk-test-not-real",
  CLAUDE_CODE_USE_OPENAI: "1",
  OPENAI_BASE_URL: "https://elsewhere.example",
  OPENAI_API_KEY: "not-real",
  CLAUDE_CONFIG_DIR: "/Users/f/.other",
  GITHUB_TOKEN: "not-real",
};

describe("child environment (decision 58)", () => {
  it("keeps only allowlisted variables and a fixed PATH", () => {
    const env = buildChildEnv(shell);
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH", "USER"]);
    expect(env.PATH).not.toContain("/evil/bin");
  });

  it("finds variables that would reroute or rebill a session", () => {
    expect(findForbiddenEnv(shell)).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_OPENAI", "CLAUDE_CONFIG_DIR", "OPENAI_BASE_URL"]);
    expect(findForbiddenEnv(buildChildEnv(shell))).toEqual([]);
  });

  it("refuses to add a forbidden variable on purpose", () => {
    expect(() => buildChildEnv(shell, { ANTHROPIC_API_KEY: "x" })).toThrow();
    expect(buildChildEnv(shell, { FAKE_CLAUDE_MODE: "safe" }).FAKE_CLAUDE_MODE).toBe("safe");
  });
});
