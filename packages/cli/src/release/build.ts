import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { removeRunDir } from "../checks/gate.ts";
import { safeGit } from "../eval/git.ts";
import { materializeTree } from "../lanes/materialize.ts";
import type { Ledger, LedgerEntry } from "../ledger/ledger.ts";
import { runSandboxed } from "../sandbox/srt.ts";
import { tempRoots } from "../sandbox/temp.ts";
import { ARTIFACT_TYPE, type ReleaseSetup } from "./config.ts";
import { artifactDigest } from "./manifest.ts";
import { within } from "./paths.ts";

/**
 * The fixed-revision build (decision 157). The runner builds the checked revision itself, after the sessions end:
 * a fresh clone of the committed objects, the protected setup's build command in the sandbox a gate case gets (no
 * network, no credentials, the runner home unreadable), and the output folder copied out of the checkout into the
 * runner's artifact root, where no session or candidate can write. Its digest is recorded as the only binding of
 * an artifact to a revision; a manifest naming any other artifact is refused (checkManifest).
 */
export interface ReleaseBuildInput {
  ledger: Ledger;
  project: string;
  projectDir: string;
  jarvisHome: string;
  workRoot: string;
  repoPath: string;
  revision: string;
  build: ReleaseSetup["build"];
  artifactRoot: string;
  runId: string;
  /** HOME for the runner's git calls. */
  gitHome?: string;
  /** Test seam: runs the sandboxed build (default runSandboxed), so a test can see its policy. */
  sandbox?: typeof runSandboxed;
}
export type ReleaseBuildResult = { status: "pass"; entry: LedgerEntry; artifactDir: string; artifactHash: string } | { status: "fail"; reason: string };

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** The output folder is a real folder in the checkout at every level: no link can point the copy elsewhere. */
function outputFolder(checkout: string, output: string): string | undefined {
  let path = checkout;
  for (const part of output.split("/")) {
    path = join(path, part);
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return undefined;
  }
  return within(realpathSync(checkout), realpathSync(path)) ? path : undefined;
}

export async function buildRelease(i: ReleaseBuildInput): Promise<ReleaseBuildResult> {
  if (!/^[a-f0-9]{40}$/.test(i.revision)) return { status: "fail", reason: "the release revision is not a full commit id" };
  const home = i.gitHome ?? homedir();
  mkdirSync(i.workRoot, { recursive: true, mode: 0o700 });
  mkdirSync(i.artifactRoot, { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(join(i.workRoot, "release-build-"));
  const checkout = join(scratch, "checkout");
  const buildHome = join(scratch, "home");
  const cache = join(scratch, "cache");
  const evidenceDir = join(i.projectDir, "evidence", `release-build-${i.runId}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  for (const dir of [buildHome, cache, evidenceDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    // The same fresh clone a gate makes: committed objects only, every object re-hashed, no hooks or repo config.
    safeGit(scratch, ["-c", "protocol.file.allow=always", "-c", "transfer.fsckObjects=true", "clone", "--quiet", "--no-local", "--no-checkout", i.repoPath, checkout], { home });
    safeGit(checkout, ["checkout", "--quiet", "--detach", i.revision], { home });
    if (safeGit(checkout, ["rev-parse", "HEAD"], { home }).toString().trim() !== i.revision) return { status: "fail", reason: "the build checkout is not at the release revision" };
    const real = (p: string) => realpathSync(p);
    const stdoutPath = join(evidenceDir, "stdout");
    const stderrPath = join(evidenceDir, "stderr");
    const r = await (i.sandbox ?? runSandboxed)({
      policy: {
        denyRead: [real(i.jarvisHome), real(homedir()), ...tempRoots()],
        allowRead: [real(scratch)],
        allowWrite: [real(checkout), real(buildHome), real(cache)],
      },
      command: i.build.command,
      cwd: real(checkout),
      env: { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", CI: "1",
        HOME: real(buildHome), TMPDIR: real(buildHome), npm_config_cache: join(real(cache), "npm"), npm_config_offline: "true", NEXT_TELEMETRY_DISABLED: "1" },
      timeoutMs: i.build.timeoutMs,
      stdoutPath, stderrPath,
      killGraceMs: 5_000,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
    const logs = { stdout: existsSync(stdoutPath) ? sha(stdoutPath) : "", stderr: existsSync(stderrPath) ? sha(stderrPath) : "" };
    if (r.code !== 0 || r.timedOut || r.overflowed) return { status: "fail", reason: `the release build ${r.timedOut ? "timed out" : r.overflowed ? "printed too much" : `exited ${String(r.code)}`}; its output is in ${evidenceDir}` };
    const source = outputFolder(checkout, i.build.output);
    if (!source) return { status: "fail", reason: `the release build left no ${i.build.output} folder in the checkout` };
    const artifactDir = join(realpathSync(i.artifactRoot), `${i.revision}-${i.runId}`);
    const files = materializeTree(source, artifactDir, { sourceRoot: real(checkout), maxBytes: 1024 ** 3, maxFiles: 50_000 });
    const artifactHash = artifactDigest(artifactDir);
    const entry = i.ledger.append({ kind: "decision", actor: "runner", data: {
      type: ARTIFACT_TYPE, project: i.project, revision: i.revision, artifactDir, artifactHash, fileCount: Object.keys(files).length,
      build: { command: i.build.command, output: i.build.output, code: r.code, durationMs: r.durationMs },
      evidence: { dir: evidenceDir, files: Object.fromEntries(Object.entries(logs).filter(([, hash]) => hash !== "")) },
    } });
    return { status: "pass", entry, artifactDir, artifactHash };
  } catch (error) {
    return { status: "fail", reason: `the release build could not run: ${String(error instanceof Error ? error.message : error).slice(0, 300)}` };
  } finally {
    try { removeRunDir(scratch); } catch { /* left for the run's cleanup; the recorded result stands */ }
  }
}
