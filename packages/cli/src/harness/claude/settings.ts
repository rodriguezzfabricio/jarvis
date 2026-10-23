import { writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";

/**
 * Generated settings for a task session (decisions 12, 13, 59, 60).
 *
 * Claude Code silently drops a whole --settings file if any value is invalid,
 * so this module only emits keys verified on the pinned version, and the
 * doctor's live canary probe (doctor/canary.ts) proves the file took effect.
 */

export interface TaskSettingsInput {
  /** Real (symlink-resolved) path of the task's worktree. */
  worktree: string;
  /** Real path of the runner-owned Jarvis home (~/.jarvis or a probe stand-in). */
  jarvisHome: string;
  /** Real path of the broker's Unix socket; omit when no broker runs (baselines). /tmp symlinks don't match. */
  brokerSocket?: string;
  /** Allow WebSearch and WebFetch (both run outside the shell sandbox and only read). Off for build tasks. */
  webResearch?: boolean;
  /** Hosts sandboxed commands and WebFetch may reach. */
  allowedDomains: readonly string[];
}

/** Permission-rule form of an absolute path: //abs/path (a single leading / is relative to the settings file). */
export function absRule(path: string): string {
  if (!isAbsolute(path)) throw new Error(`expected an absolute path, got ${path}`);
  return `/${path}`;
}

const Abs = z.string().refine((p) => isAbsolute(p), "must be an absolute path");

/** The safety invariants every task settings file must satisfy. Extra keys are rejected. */
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
            denyWrite: z.array(Abs).min(1),
          })
          .strict(),
      })
      .strict(),
    permissions: z
      .object({
        allow: z.array(z.string()),
        deny: z.array(z.string()).min(1),
      })
      .strict(),
  })
  .strict();

export type TaskSettings = z.infer<typeof SafeTaskSettings>;

export function buildTaskSettings(input: TaskSettingsInput): TaskSettings {
  for (const [name, p] of Object.entries({
    worktree: input.worktree,
    jarvisHome: input.jarvisHome,
    brokerSocket: input.brokerSocket ?? "/",
  })) {
    if (!isAbsolute(p)) throw new Error(`${name} must be an absolute real path, got ${p}`);
  }
  if (input.worktree === input.jarvisHome || input.worktree.startsWith(`${input.jarvisHome}/`)) {
    throw new Error("the worktree must be outside the runner-owned folder (decision 67)");
  }
  if (input.brokerSocket && (input.brokerSocket.startsWith("/tmp/") || input.brokerSocket.startsWith("/var/"))) {
    // On macOS these are symlinks into /private; the sandbox matches real paths only.
    throw new Error(`brokerSocket must be a real path (resolve /tmp and /var to /private/...): ${input.brokerSocket}`);
  }
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
        denyWrite: [input.jarvisHome],
      },
    },
    permissions: {
      allow: [
        `Edit(${absRule(input.worktree)}/**)`,
        ...(input.webResearch ? ["WebSearch", "WebFetch"] : input.allowedDomains.map((d) => `WebFetch(domain:${d})`)),
      ],
      deny: [
        `Read(${absRule(input.jarvisHome)}/**)`,
        `Edit(${absRule(input.jarvisHome)}/**)`,
        ...(input.webResearch ? [] : ["WebSearch"]),
      ],
    },
  };
  return assertSafeTaskSettings(settings);
}

/** Throws unless the settings satisfy every safety invariant. */
export function assertSafeTaskSettings(settings: unknown): TaskSettings {
  const parsed = SafeTaskSettings.safeParse(settings);
  if (!parsed.success) {
    throw new Error(`unsafe task settings: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

/** The only way task settings reach disk: validated first, written owner-only. */
export function writeTaskSettings(path: string, settings: unknown): void {
  const safe = assertSafeTaskSettings(settings);
  writeFileSync(path, `${JSON.stringify(safe, null, 2)}\n`, { mode: 0o600 });
}
