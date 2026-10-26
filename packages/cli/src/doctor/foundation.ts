import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requestBroker } from "../broker/client.ts";
import { ChecksStore } from "../checks/store.ts";
import { verifyLedger } from "../ledger/ledger.ts";
import { runSandboxed } from "../sandbox/srt.ts";
import { verifyChecksReadOnly } from "./read-only.ts";
import type { DoctorCheck } from "./doctor.ts";

/** Stage 1 doctor checks (decision 46; architecture §3.2): the foundation is in place and intact. */
export interface FoundationDeps {
  jarvisHome: string;
  pluginDir: string;
  socketPath: string;
  tmpRoot?: string;
  ledgerVerify?: typeof verifyLedger;
}

export async function foundationChecks(d: FoundationDeps): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  const add = (name: string, level: DoctorCheck["level"], detail: string) => out.push({ name, level, detail });

  // Every project's ledger verifies, and its protected checks still match the approved lock.
  const projects = join(d.jarvisHome, "projects");
  const ids = existsSync(projects) ? readdirSync(projects).filter((x) => !x.startsWith(".")) : [];
  if (ids.length === 0) add("ledgers", "pass", "no projects yet");
  for (const id of ids) {
    const dir = join(projects, id);
    const v = (d.ledgerVerify ?? verifyLedger)(dir);
    if (v.contended) out.push({ name: `ledger.${id}`, level: "warn", status: "busy", detail: "busy, re-run: writers kept the ledger moving; not verified" });
    else add(`ledger.${id}`, v.ok ? "pass" : "fail", v.ok ? `${v.entries.length} entries verified${v.repairable.length ? ` (repairable: ${v.repairable.join(", ")})` : ""}` : v.problems.join("; "));
    const store = new ChecksStore(dir);
    // A project that ever approved checks must still have its lock (Codex stage 0 review 7): a missing
    // lock is a failure, not a project without checks.
    const approved = v.ok && v.entries.some((e) => e.kind === "checks_approved");
    if (v.ok && (approved || existsSync(store.lockPath))) {
      try {
        const c = verifyChecksReadOnly(store, d.ledgerVerify);
        add(`checks.${id}`, c.ok ? "pass" : "fail", c.ok ? "protected checks match the approved lock" : c.problems.join("; "));
      } catch (e) {
        add(`checks.${id}`, "fail", String(e));
      }
    }
  }

  // Secrets files are owner-only.
  const secrets = join(d.jarvisHome, "secrets");
  for (const f of existsSync(secrets) ? readdirSync(secrets) : []) {
    const mode = statSync(join(secrets, f)).mode & 0o777;
    add(`secrets.${f}`, (mode & 0o077) === 0 ? "pass" : "fail", `mode ${mode.toString(8)}`);
  }

  // The broker answers on its socket (it runs only during runs, so absence is a warning).
  if (existsSync(d.socketPath)) {
    try {
      const r = await requestBroker(d.socketPath, { op: "doctor.ping", payload: {} } as never, 5_000);
      add("broker", r.status === "invalid" ? "pass" : "fail", `answered "${r.status}" to a ping`);
    } catch (e) {
      add("broker", "fail", `socket exists but the broker did not answer: ${String(e)}`);
    }
  } else add("broker", "warn", d.socketPath ? "not running (it runs only while a run is active)" : "no run socket selected; use doctor --socket or JARVIS_BROKER_SOCKET");

  // The Jarvis plugin is in place with its hooks.
  out.push(checkPlugin(d.pluginDir));

  // The checks sandbox really blocks the runner folder and allows the checkout.
  const root = mkdtempSync(join(realpathSync(d.tmpRoot ?? "/tmp"), "jarvis-srt-"));
  try {
    const secret = join(root, "denied");
    const work = join(root, "work");
    mkdirSync(secret);
    mkdirSync(work);
    writeFileSync(join(secret, "x.txt"), "SRT-CANARY");
    const r = await runSandboxed({ policy: { denyRead: [secret], allowRead: [], allowWrite: [work] }, command: `cat ${join(secret, "x.txt")} 2>/dev/null; echo ok > ${join(work, "w.txt")}; echo done`, cwd: work, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 30_000 });
    const text = r.stdout;
    const held = !text.includes("SRT-CANARY") && existsSync(join(work, "w.txt"));
    add("checks_sandbox", held ? "pass" : "fail", held ? "srt blocked the denied folder and allowed the checkout" : "srt did not hold");
  } catch (e) {
    add("checks_sandbox", "fail", `srt self-test failed: ${String(e).slice(0, 200)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return out;
}

/** The Jarvis plugin is in place with its hooks. Shared with jarvis setup, which verifies its install. */
export function checkPlugin(pluginDir: string): DoctorCheck {
  const d = { pluginDir };
  try {
    const hooks = JSON.parse(readFileSync(join(d.pluginDir, "hooks", "hooks.json"), "utf8")) as { hooks?: Record<string, unknown> };
    const registrationsMatch = (name: string, command: string, matcher?: string): boolean => {
      const registrations = hooks.hooks?.[name];
      if (!Array.isArray(registrations) || registrations.length === 0) return false;
      return registrations.some((registration: unknown) => {
        if (!registration || typeof registration !== "object") return false;
        const candidate = registration as { matcher?: unknown; hooks?: unknown };
        const registrationKeys = Object.keys(candidate).sort();
        const expectedRegistrationKeys = (matcher === undefined ? ["hooks"] : ["hooks", "matcher"]).sort();
        if (registrationKeys.join("\0") !== expectedRegistrationKeys.join("\0")) return false;
        if (candidate.matcher !== matcher) return false;
        if (!Array.isArray(candidate.hooks) || candidate.hooks.length === 0) return false;
        return candidate.hooks.some((hook: unknown) => {
          if (!hook || typeof hook !== "object") return false;
          const entry = hook as { type?: unknown; command?: unknown };
          const keys = Object.keys(entry).sort();
          return keys.join("\0") === ["command", "type"].join("\0")
            && entry.type === "command" && entry.command === command;
        });
      });
    };
    const manifest = JSON.parse(readFileSync(join(d.pluginDir, ".claude-plugin", "plugin.json"), "utf8")) as { name?: unknown; version?: unknown };
    const ok = registrationsMatch("PreToolUse", 'node "${CLAUDE_PLUGIN_ROOT}/hooks/tripwire.mjs"', "Bash|Read|Edit|Write|Glob|Grep")
      && registrationsMatch("SessionStart", 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"')
      && existsSync(join(d.pluginDir, "hooks", "tripwire.mjs"))
      && existsSync(join(d.pluginDir, "hooks", "session-start.mjs"))
      && manifest.name === "jarvis"
      && typeof manifest.version === "string" && manifest.version.length > 0;
    return { name: "plugin", level: ok ? "pass" : "fail", detail: ok ? `${d.pluginDir}: tripwire and SessionStart hooks present` : "plugin is incomplete" };
  } catch (e) {
    return { name: "plugin", level: "fail", detail: `plugin unreadable: ${String(e)}` };
  }
}
