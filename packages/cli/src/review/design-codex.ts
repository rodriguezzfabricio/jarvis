import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { CODEX_VERSION, pinnedCodexBin } from "../config/pins.ts";
import { runSession } from "../proc/session.ts";
import type { CodexReviewerOptions } from "./codex.ts";
import { openCodexJail } from "./confine.ts";
import { DESIGN_LIMITS, validateDesignImage } from "./design-evidence.ts";
import { DesignVerdictSchema, evaluateDesignVerdict } from "./design-verdict.ts";
import type { ReviewerOutput } from "./types.ts";
import { checkoutHash } from "./workspace.ts";

export const DESIGN_REVIEW_MODEL = "gpt-6-astra";
export interface DesignReviewerInput { workspace: string; outputDir: string; prompt: string; images: readonly string[]; timeoutMs: number }
export type DesignReviewer = (input: DesignReviewerInput) => Promise<ReviewerOutput>;
const under = (root: string, path: string) => root === path || path.startsWith(`${root}/`);

function validate(input: DesignReviewerInput): void {
  const workspace = realpathSync(input.workspace), output = realpathSync(input.outputDir);
  if (under(workspace, output) || under(output, workspace)) throw new Error("review outputs must be separate from the read-only checkout");
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0 || Buffer.byteLength(input.prompt) > DESIGN_LIMITS.promptBytes) throw new Error("invalid design review bounds");
  if (!input.images.length || input.images.length > DESIGN_LIMITS.pages) throw new Error("design review requires bounded images");
  let bytes = 0;
  for (const path of input.images) {
    const stat = lstatSync(path); const real = realpathSync(path); bytes += stat.size;
    if (!isAbsolute(path) || !stat.isFile() || stat.isSymbolicLink() || under(workspace, real) || under(output, real) || !stat.size || stat.size > DESIGN_LIMITS.imageBytes || bytes > DESIGN_LIMITS.imagesBytes) throw new Error("invalid read-only image evidence");
    validateDesignImage(readFileSync(path));
  }
}

/** Same proven Seatbelt boundary as the code reviewer; no browser or unrestricted fallback. */
export function createCodexDesignReviewer(options: CodexReviewerOptions = {}): DesignReviewer {
  const home = options.home ?? homedir(), bin = options.binary ?? pinnedCodexBin(home), session = options.session ?? runSession;
  if (!isAbsolute(bin)) throw new Error("Codex binary must be an absolute pin");
  return async input => {
    const captures: unknown[] = [];
    const output = (extra: Partial<ReviewerOutput>): ReviewerOutput => ({ reviewer: "codex", model: DESIGN_REVIEW_MODEL, rawOutput: JSON.stringify(captures), rawVerdict: "", ...extra });
    try {
      validate(input);
      if (!existsSync(bin)) throw new Error("pinned Codex binary is missing");
      const before = checkoutHash(input.workspace);
      const jail = await openCodexJail({ home, bin, workspace: input.workspace, readFiles: [...input.images], writeDirs: [input.outputDir], session, ...options.confinement });
      try {
        const common = { cwd: input.workspace, env: jail.env, timeoutMs: input.timeoutMs, maxOutputBytes: 1024 * 1024 };
        const version = await session({ ...common, ...jail.wrap(bin, ["--version"]) }); captures.push({version});
        if (version.code !== 0 || version.timedOut || version.overflowed || version.stdout.trim() !== `codex-cli ${CODEX_VERSION}`) throw new Error("pinned Codex version check failed");
        const schema = join(input.outputDir, "schema.json"), verdict = join(input.outputDir, "verdict.json");
        writeFileSync(schema, JSON.stringify(z.toJSONSchema(DesignVerdictSchema)), {flag: "wx", mode: 0o600});
        const result = await session({ ...common, ...jail.wrap(bin, ["exec", "-C", input.workspace, "-m", DESIGN_REVIEW_MODEL,
          "--sandbox", "danger-full-access", "--ephemeral", "--json", "--skip-git-repo-check", "-c", "project_doc_max_bytes=0", "-c", 'model_reasoning_effort="high"',
          "--output-schema", schema, "-o", verdict, ...input.images.flatMap(path => ["-i", path]), "--", input.prompt]) });
        captures.push({result, proxyRefused: jail.proxy.refused});
        if (result.code !== 0 || result.timedOut || result.overflowed) throw new Error("design review process failed or exceeded bounds");
        const events = result.stdout.trim().split("\n").map(line => JSON.parse(line) as {type?: string});
        if (!events.some(e => e.type === "turn.completed") || events.some(e => e.type === "turn.failed")) throw new Error("design review did not complete");
        if (checkoutHash(input.workspace) !== before) throw new Error("read-only design checkout changed");
        const stat = lstatSync(verdict);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("invalid design verdict file");
        const rawVerdict = readFileSync(verdict, "utf8");
        if (evaluateDesignVerdict(rawVerdict).verdict === "error") throw new Error("invalid design verdict");
        return output({rawVerdict});
      } finally { await jail.close(); }
    } catch (error) { return output({error: error instanceof Error ? error.message : String(error)}); }
  };
}
