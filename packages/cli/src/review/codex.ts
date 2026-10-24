import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { CODEX_VERSION, pinnedCodexBin } from "../config/pins.ts";
import { runSession, type SessionOutcome, type SessionSpec } from "../proc/session.ts";
import type { Reviewer, ReviewerInput, ReviewerOutput } from "./types.ts";
import { VerdictSchema } from "./verdict.ts";

export interface CodexReviewerOptions {
  home?: string;
  /** Test seam. Production uses the absolute pin, never PATH. */
  binary?: string;
  session?: (spec: SessionSpec) => Promise<SessionOutcome>;
}
export function codexEnvironment(home: string, user: string = userInfo().username): Record<string, string> {
  return { HOME: join(home, ".jarvis/codex-home/home"), USER: user, PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin", CODEX_HOME: join(home, ".jarvis/codex-home") };
}
function usageLimit(result: SessionOutcome): boolean {
  if (result.code !== 1 || result.timedOut || result.overflowed) return false;
  const lines = result.stdout.trim().split("\n");
  const limit = lines.findIndex((l) => l.includes("You've hit your usage limit"));
  return limit >= 0 && lines.slice(limit + 1).some((l) => {
    try { return (JSON.parse(l) as { type?: string }).type === "turn.failed"; } catch { return false; }
  });
}
function readVerdict(path: string): string {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 16 * 1024 * 1024) throw new Error("invalid Codex verdict file");
  return readFileSync(path, "utf8");
}

export function createCodexReviewer(options: CodexReviewerOptions = {}): Reviewer {
  const home = options.home ?? homedir();
  const bin = options.binary ?? pinnedCodexBin(home);
  if (!isAbsolute(bin)) throw new Error("Codex binary must be an absolute path");
  const session = options.session ?? runSession;
  return async (input: ReviewerInput): Promise<ReviewerOutput> => {
    const base = { reviewer: "codex" as const, model: input.model, rawVerdict: "" };
    const captures: unknown[] = [];
    const output = (extra: Partial<ReviewerOutput>): ReviewerOutput => ({ ...base, rawOutput: JSON.stringify(captures), ...extra });
    try {
      if (!existsSync(bin)) return output({ error: "pinned Codex binary is missing", fallbackReason: "missing_binary" });
      const common = { bin, cwd: input.workspace, env: codexEnvironment(home), timeoutMs: input.timeoutMs, maxOutputBytes: 16 * 1024 * 1024 };
      const version = await session({ ...common, args: ["--version"] }); captures.push({ version });
      if (version.timedOut || version.overflowed || version.code !== 0) return output({ error: "Codex version check failed" });
      if (version.stdout.trim() !== `codex-cli ${CODEX_VERSION}`) return output({ error: "pinned Codex version mismatch", fallbackReason: "version_mismatch" });
      const schema = join(input.outputDir, "schema.json"), verdict = join(input.outputDir, "verdict.json");
      writeFileSync(schema, JSON.stringify(z.toJSONSchema(VerdictSchema)), { flag: "wx", mode: 0o600 });
      const result = await session({ ...common, args: [
        "exec", "-C", input.workspace, "-m", input.model, "--sandbox", "read-only", "--ephemeral", "--json", "--skip-git-repo-check",
        "-c", "project_doc_max_bytes=0", "-c", `model_reasoning_effort="${input.effort}"`, "--output-schema", schema, "-o", verdict, "--", input.prompt,
      ] }); captures.push({ result });
      if (usageLimit(result)) return output({ error: "Codex usage limit", fallbackReason: "usage_limit" });
      if (result.timedOut || result.overflowed || result.code !== 0) return output({ error: "Codex review failed or timed out" });
      const events = result.stdout.trim().split("\n").map((l) => JSON.parse(l) as { type?: string });
      if (events.some((e) => e.type === "turn.failed") || !events.some((e) => e.type === "turn.completed")) return output({ error: "Codex review did not complete" });
      const rawVerdict = readVerdict(verdict); captures.push({ rawVerdict });
      return output({ rawVerdict });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error); captures.push({ error: message });
      return output({ error: message, ...(!existsSync(bin) ? { fallbackReason: "missing_binary" as const } : {}) });
    }
  };
}
