import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requestBroker } from "../broker/client.ts";
import { ChecksStore } from "../checks/store.ts";
import { verifyLedger } from "../ledger/ledger.ts";
import { srtCommand, writeSrtSettings } from "../sandbox/srt.ts";
import type { DoctorCheck } from "./doctor.ts";

/** Stage 1 doctor checks (decision 46; architecture §3.2): the foundation is in place and intact. */
export interface FoundationDeps {
  jarvisHome: string;
  pluginDir: string;
  socketPath: string;
  tmpRoot?: string;
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
    const v = verifyLedger(dir);
    add(`ledger.${id}`, v.ok ? "pass" : "fail", v.ok ? `${v.entries.length} entries verified${v.repairable.length ? ` (repairable: ${v.repairable.join(", ")})` : ""}` : v.problems.join("; "));
    const store = new ChecksStore(dir);
    if (existsSync(store.lockPath) && v.ok) {
      try {
        const { Ledger } = await import("../ledger/ledger.ts");
        const c = store.verify(Ledger.open(dir));
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
  } else add("broker", "warn", "not running (it runs only while a run is active)");

  // The Jarvis plugin is in place with its hooks.
  try {
    const hooks = JSON.parse(readFileSync(join(d.pluginDir, "hooks", "hooks.json"), "utf8")) as { hooks?: Record<string, unknown> };
    const ok = !!hooks.hooks?.PreToolUse && existsSync(join(d.pluginDir, "hooks", "tripwire.mjs")) && existsSync(join(d.pluginDir, ".claude-plugin", "plugin.json"));
    add("plugin", ok ? "pass" : "fail", ok ? `${d.pluginDir}: tripwire and SessionStart hooks present` : "plugin is incomplete");
  } catch (e) {
    add("plugin", "fail", `plugin unreadable: ${String(e)}`);
  }

  // The checks sandbox really blocks the runner folder and allows the checkout.
  const root = mkdtempSync(join(realpathSync(d.tmpRoot ?? "/tmp"), "jarvis-srt-"));
  try {
    const secret = join(root, "denied");
    const work = join(root, "work");
    mkdirSync(secret);
    mkdirSync(work);
    writeFileSync(join(secret, "x.txt"), "SRT-CANARY");
    const settings = join(root, "srt.json");
    writeSrtSettings(settings, { denyRead: [secret], allowRead: [], allowWrite: [work] });
    const [bin, ...args] = srtCommand(settings, `cat ${join(secret, "x.txt")} 2>/dev/null; echo ok > ${join(work, "w.txt")}; echo done`);
    const text = execFileSync(bin, args, { cwd: work, encoding: "utf8", timeout: 30_000 });
    const held = !text.includes("SRT-CANARY") && existsSync(join(work, "w.txt"));
    add("checks_sandbox", held ? "pass" : "fail", held ? "srt blocked the denied folder and allowed the checkout" : "srt did not hold");
  } catch (e) {
    add("checks_sandbox", "fail", `srt self-test failed: ${String(e).slice(0, 200)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return out;
}
