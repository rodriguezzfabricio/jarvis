import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSandboxed, type SrtPolicy } from "../sandbox/srt.ts";
import { readDependencyPlan, type DependencyPlan } from "./deps-lock.ts";
import { pinnedDependencyTools, type DependencyPins } from "./dependency-pins.ts";
import { within } from "./paths.ts";

export interface DependencyLimits { timeoutMs: number; maxOutputBytes: number; maxBytes: number; maxFiles: number }
export interface DependencyInput {
  checkout: string; scratch: string; evidenceDir: string; policy: SrtPolicy;
  pins?: DependencyPins;
  /** Runner/test overrides can only lower the fixed caps. */
  limits?: Partial<DependencyLimits>;
  sandbox?: typeof runSandboxed;
}
export interface DependencyResult extends DependencyPlan { durationMs: number }
const CAPS: DependencyLimits = { timeoutMs: 300_000, maxOutputBytes: 4 * 1024 * 1024, maxBytes: 1024 ** 3, maxFiles: 100_000 };
const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const WORKER = fileURLToPath(new URL("./dependency-worker.ts", import.meta.url));

function limits(overrides: Partial<DependencyLimits> = {}): DependencyLimits {
  const result = { ...CAPS };
  for (const key of Object.keys(CAPS) as (keyof DependencyLimits)[]) {
    const value = overrides[key] ?? CAPS[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > CAPS[key]) throw new Error("dependency limit must be positive and within runner caps");
    result[key] = value;
  }
  return result;
}
function tools(plan: DependencyPlan, pins: DependencyPins, scratch: string) {
  const pin = pins[plan.manager];
  if (pin.version !== plan.version) throw new Error("declared package-manager version differs from runner pin");
  const paths = [pins.node, pin.bin, pin.root];
  if (paths.some(p => !isAbsolute(p))) throw new Error("dependency tool pin must be absolute");
  const [node, bin, root] = paths.map(p => realpathSync(p)) as [string, string, string];
  if ([node, bin, root].some(p => within(realpathSync(scratch), p, true)) || !within(root, bin)) throw new Error("dependency tool pin is candidate-owned or outside its runtime root");
  for (const path of [node, bin, root]) {
    const st = lstatSync(path);
    if ((st.mode & 0o022) !== 0 || (st.uid !== 0 && st.uid !== process.getuid?.())) throw new Error("dependency tool pin is writable by others");
  }
  if (!lstatSync(node).isFile() || !lstatSync(bin).isFile() || !lstatSync(root).isDirectory()) throw new Error("dependency tool pin needs regular files and a runtime directory");
  return { node, bin, root };
}

/** Installs on the committed checkout. Only this step gets registry access; failures throw before the build. */
export async function installDependencies(i: DependencyInput): Promise<DependencyResult | undefined> {
  const plan = readDependencyPlan(i.checkout);
  if (!plan) return undefined;
  const pins = i.pins ?? pinnedDependencyTools(), pin = tools(plan, pins, i.scratch), cap = limits(i.limits);
  const home = join(i.scratch, "dependency-home"), cache = join(i.scratch, "dependency-cache");
  for (const dir of [home, cache]) mkdirSync(dir, { mode: 0o700 });
  const globalConfig = join(home, "global.npmrc");
  writeFileSync(globalConfig, "", { mode: 0o400, flag: "wx" });
  const worker = join(i.scratch, "runner-install.ts");
  writeFileSync(worker, readFileSync(WORKER), { mode: 0o400, flag: "wx" });
  const args = plan.manager === "npm"
    ? ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--include=dev", "--include=optional"]
    : ["install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile", "--config.manage-package-manager-versions=false", "--config.package-manager-strict-version=true", "--config.side-effects-cache=false", "--store-dir", cache];
  const request = { bin: pin.bin, version: plan.version, nodeVersion: pins.nodeVersion, args,
    roots: [join(i.checkout, "node_modules"), home, cache], maxBytes: cap.maxBytes, maxFiles: cap.maxFiles };
  const result = await (i.sandbox ?? runSandboxed)({
    policy: { ...i.policy, allowRead: [...i.policy.allowRead, pin.node, pin.root], allowWrite: [...i.policy.allowWrite, home, cache],
      allowedDomains: ["registry.npmjs.org"], allowLocalBinding: false, allowUnixSockets: [] },
    command: `${quote(pin.node)} ${quote(worker)} ${quote(JSON.stringify(request))}`,
    cwd: i.checkout,
    env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", HOME: home, TMPDIR: home, CI: "1",
      npm_config_userconfig: "/dev/null", npm_config_globalconfig: globalConfig, npm_config_cache: cache,
      npm_config_registry: "https://registry.npmjs.org/", npm_config_ignore_scripts: "true", npm_config_audit: "false", npm_config_fund: "false",
      npm_config_update_notifier: "false", npm_config_manage_package_manager_versions: "false", COREPACK_ENABLE_NETWORK: "0",
      XDG_CONFIG_HOME: home, XDG_CACHE_HOME: cache, XDG_DATA_HOME: cache, PNPM_HOME: home },
    timeoutMs: cap.timeoutMs, maxOutputBytes: cap.maxOutputBytes, killGraceMs: 1000,
    stdoutPath: join(i.evidenceDir, "deps-stdout"), stderrPath: join(i.evidenceDir, "deps-stderr"),
  });
  if (result.timedOut) throw new Error("dependency install timed out");
  if (result.overflowed) throw new Error("dependency install output limit exceeded");
  const failures: Record<number, string> = { 72: "dependency tool version differs from pin", 73: "dependency install size limit exceeded", 74: "dependency install file count limit exceeded", 75: "dependency install has a link outside its roots or a special file" };
  if (result.code !== 0) throw new Error(failures[result.code ?? -1] ?? `dependency install exited ${String(result.code)}`);
  return { ...plan, durationMs: result.durationMs };
}
