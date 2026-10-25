import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { runSession, type SessionOutcome, type SessionSpec } from "../proc/session.ts";
import { validateDesktopPlan, type DesktopBuildObservation, type DesktopPlan } from "./desktop-types.ts";
export interface DesktopBuildDeps { spawn?: (spec: SessionSpec) => Promise<SessionOutcome>; exists?: (path: string) => boolean }
const ENV = new Set(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "CI", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GOMODCACHE", "GOCACHE", "npm_config_cache", "CARGO_HOME", "RUSTUP_HOME", "DEVELOPER_DIR"]);

/** The plan's bundle is a real directory in the checkout (no link at any level) with an Info.plist and Contents/MacOS. */
function builtBundle(repo: string, bundle: string): boolean {
  try {
    const root = realpathSync(repo); let path = root;
    for (const part of bundle.split("/")) { path = join(path, part); if (!lstatSync(path).isDirectory()) return false; }
    const rel = relative(root, realpathSync(path));
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && lstatSync(join(path, "Contents")).isDirectory() && lstatSync(join(path, "Contents", "MacOS")).isDirectory() && lstatSync(join(path, "Contents", "Info.plist")).isFile();
  } catch { return false; }
}

/** Case sandbox only: no native launch, WindowServer access, or Apple Events. */
export async function observeDesktopBuild(repo: string, plan: DesktopPlan, env: Record<string, string>, deps: DesktopBuildDeps = {}): Promise<DesktopBuildObservation> {
  validateDesktopPlan(plan);
  if (!isAbsolute(repo)) throw new Error("Desktop checkout must be absolute");
  if (Object.keys(env).some(k => !ENV.has(k))) throw new Error("Desktop environment must use the runner allowlist");
  const raw: DesktopBuildObservation = { kind: "qa-desktop-build", status: "fail", bundle: plan.bundle };
  if (![plan.tauriBin, plan.build.bin].every(deps.exists ?? existsSync)) return { ...raw, status: "not run", reason: "not run: desktop (Tauri build tools unavailable)" };
  try {
    const build = await (deps.spawn ?? runSession)({ bin: plan.build.bin, args: plan.build.args, cwd: repo, env: { ...env, CARGO_NET_OFFLINE: "true", npm_config_offline: "true", YARN_ENABLE_NETWORK: "0" }, timeoutMs: plan.buildTimeoutMs, killGraceMs: 1000, maxOutputBytes: 1024 * 1024 });
    raw.build = { code: build.code, timedOut: build.timedOut, overflowed: build.overflowed };
    // An exit 0 alone isn't a build: the plan's app bundle must exist (Opus review of QA follow-up 1).
    if (build.code === 0 && !build.timedOut && !build.overflowed) return builtBundle(repo, plan.bundle) ? { ...raw, status: "observed" } : { ...raw, reason: "desktop build produced no app bundle" };
    if (!build.timedOut && !build.overflowed && /no matching package|enableNetwork.*false|failed to download|attempting to make an HTTP request|ENOTCACHED|ENETUNREACH|could not resolve|network.*unreachable|offline.*(?:cache|package|crate|download)/i.test(build.stderr + build.stdout)) return { ...raw, status: "not run", reason: "not run: desktop build needs network" };
    return { ...raw, reason: "desktop build failed" };
  } catch (error) { return { ...raw, reason: String(error instanceof Error ? error.message : error) }; }
}
