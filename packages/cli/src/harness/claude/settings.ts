import { writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

/**
 * Generated settings for a task session (decisions 12, 13, 59, 60, 68, 69).
 *
 * Claude Code silently drops a whole --settings file if any value is invalid,
 * so this module emits only keys verified on the pinned version, and the live
 * canary probe (probe.ts) proves the file took effect. Validation is bound to
 * the trusted context: a settings object is safe only if it is exactly what
 * buildTaskSettings produces for that context.
 */

export interface TaskSettingsInput {
  /** Real (symlink-resolved) path of the task's worktree. */
  worktree: string;
  /** Real path of the runner-owned Jarvis home (~/.jarvis or a probe stand-in). */
  jarvisHome: string;
  /** Real path of the shared toolchain cache (~/.jarvis-work/cache): Go modules, npm, pnpm. */
  cacheDir: string;
  /** Real path of the broker's Unix socket; omit when no broker runs (baselines). */
  brokerSocket?: string;
  /** Hosts sandboxed commands may reach. */
  allowedDomains: readonly string[];
  /** Folders sessions may read but never write: the Jarvis install, so `jarvis act` runs (decision 12). */
  readOnlyDirs?: readonly string[];
}

/** Permission-rule form of an absolute path: //abs/path (a single leading / is relative to the settings file). */
export function absRule(path: string): string {
  if (!isAbsolute(path)) throw new Error(`expected an absolute path, got ${path}`);
  return `/${path}`;
}

const Abs = z.string().refine((p) => isAbsolute(p), "must be an absolute path");

/** Shape check; the policy check is the comparison with buildTaskSettings in assertSafeTaskSettings. */
export const SafeTaskSettings = z
  .object({
    autoMemoryEnabled: z.literal(false),
    sandbox: z
      .object({
        enabled: z.literal(true),
        failIfUnavailable: z.literal(true),
        allowUnsandboxedCommands: z.literal(false),
        autoAllowBashIfSandboxed: z.literal(true),
        network: z
          .object({
            allowedDomains: z.array(z.string().min(1)),
            allowUnixSockets: z.array(Abs).max(1),
          })
          .strict(),
        filesystem: z
          .object({
            denyRead: z.array(Abs).min(1),
            allowRead: z.array(Abs),
            allowWrite: z.array(Abs),
            denyWrite: z.array(Abs).min(1),
          })
          .strict(),
      })
      .strict(),
    permissions: z
      .object({
        allow: z.array(z.string()),
        deny: z.array(z.string()).min(1),
        blockReadsOutsideWorkingDirectories: z.literal(true),
      })
      .strict(),
  })
  .strict();

export type TaskSettings = z.infer<typeof SafeTaskSettings>;

const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);

function checkContext(input: TaskSettingsInput): void {
  for (const [name, p] of Object.entries({ worktree: input.worktree, jarvisHome: input.jarvisHome, cacheDir: input.cacheDir, brokerSocket: input.brokerSocket ?? "/" })) {
    if (!isAbsolute(p)) throw new Error(`${name} must be an absolute real path, got ${p}`);
    if (p.startsWith("/tmp/") || p.startsWith("/var/")) throw new Error(`${name} must be a real path (macOS /tmp and /var are symlinks into /private): ${p}`);
  }
  if (under(input.worktree, input.jarvisHome)) throw new Error("the worktree must be outside the runner-owned folder (decision 67)");
  if (under(input.cacheDir, input.jarvisHome)) throw new Error("the cache must be outside the runner-owned folder");
  if (under(input.cacheDir, input.worktree) || under(input.worktree, input.cacheDir)) throw new Error("the cache and the worktree must not contain each other");
  if (input.brokerSocket && !under(input.brokerSocket, input.jarvisHome)) throw new Error("the broker socket must live in the runner-owned folder");
  for (const d of input.readOnlyDirs ?? []) {
    if (!isAbsolute(d) || d.startsWith("/tmp/") || d.startsWith("/var/")) throw new Error(`read-only dir must be an absolute real path: ${d}`);
    if (under(d, input.jarvisHome) || under(input.jarvisHome, d)) throw new Error("a read-only dir must not contain or sit inside the runner-owned folder");
    if (under(input.worktree, d) || under(d, input.worktree)) throw new Error("a read-only dir must not contain or sit inside the worktree");
  }
  for (const d of input.allowedDomains) if (!/^[a-z0-9.*-]+(:\d+)?$/i.test(d) || d === "*") throw new Error(`invalid allowed domain: ${d}`);
}

export function buildTaskSettings(input: TaskSettingsInput): TaskSettings {
  checkContext(input);
  const settings: TaskSettings = {
    autoMemoryEnabled: false,
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      network: {
        allowedDomains: [...input.allowedDomains],
        allowUnixSockets: input.brokerSocket ? [input.brokerSocket] : [],
      },
      filesystem: {
        denyRead: [input.jarvisHome],
        // blockReadsOutsideWorkingDirectories closes reads of /Users and similar; the cache is reopened.
        allowRead: [input.cacheDir, ...(input.readOnlyDirs ?? [])],
        allowWrite: [input.cacheDir],
        denyWrite: [
          input.jarvisHome,
          join(input.worktree, ".git", "hooks"),
          join(input.worktree, ".git", "config"),
          join(input.worktree, ".claude"),
          ...(input.readOnlyDirs ?? []),
        ],
      },
    },
    permissions: {
      allow: [`Edit(${absRule(input.worktree)}/**)`, ...(input.readOnlyDirs ?? []).map((d) => `Read(${absRule(d)}/**)`)],
      deny: [`Read(${absRule(input.jarvisHome)}/**)`, `Edit(${absRule(input.jarvisHome)}/**)`, ...(input.readOnlyDirs ?? []).map((d) => `Edit(${absRule(d)}/**)`), "WebSearch", "WebFetch"],
      blockReadsOutsideWorkingDirectories: true,
    },
  };
  return SafeTaskSettings.parse(settings);
}

/** Throws unless the settings are exactly what buildTaskSettings produces for this context. */
export function assertSafeTaskSettings(settings: unknown, input: TaskSettingsInput): TaskSettings {
  const parsed = SafeTaskSettings.safeParse(settings);
  if (!parsed.success) {
    throw new Error(`unsafe task settings: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  if (!isDeepStrictEqual(parsed.data, buildTaskSettings(input))) {
    throw new Error("unsafe task settings: they differ from the policy for this context");
  }
  return parsed.data;
}

/** The only way task settings reach disk: built from the trusted context, checked, written owner-only. */
export function writeTaskSettings(path: string, input: TaskSettingsInput, settings: unknown = buildTaskSettings(input)): void {
  const safe = assertSafeTaskSettings(settings, input);
  writeFileSync(path, `${JSON.stringify(safe, null, 2)}\n`, { mode: 0o600 });
}

/** Environment variables that point toolchains at the shared, sandbox-writable cache. */
export function cacheEnv(cacheDir: string): Record<string, string> {
  return {
    GOMODCACHE: join(cacheDir, "go", "mod"),
    GOCACHE: join(cacheDir, "go", "build"),
    GOPATH: join(cacheDir, "go", "path"),
    GOTELEMETRY: "off",
    npm_config_cache: join(cacheDir, "npm"),
    npm_config_store_dir: join(cacheDir, "pnpm-store"),
    XDG_CACHE_HOME: join(cacheDir, "xdg"),
  };
}
