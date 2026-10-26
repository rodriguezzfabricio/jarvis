import { randomInt } from "node:crypto";
import { lstatSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { envFileSecretsWriter, isStorableSecret, type SecretsWriter } from "../broker/secrets.ts";
import { pinnedClaudeBin, CLAUDE_CODE_VERSION } from "../config/pins.ts";
import { checkTrustedDir, checkTrustedTree, readNoFollow, refuseSymlink, writePrivateAtomic, type TrustOptions } from "../config/private-file.ts";
import { checkClaudePinned } from "../doctor/doctor.ts";
import { parseNotifyConfig } from "../notify/config.ts";
import { saveTaste } from "../intake/taste.ts";
import type { Notifier } from "../notify/notifier.ts";
import { NtfyNotifier, type NtfyOptions } from "../notify/ntfy.ts";
import { ACCOUNTS, DEPLOY, type AccountSpec } from "./accounts.ts";
import { installPlugin } from "./plugin.ts";
import { ACCOUNT_STEPS, STEPS, isFinished, jarvisHome, loadState, saveState, type SetupState, type StepName, type StepRecord } from "./state.ts";
import type { Tty } from "./tty.ts";

/** jarvis setup (architecture §3.2; decisions 13, 39, 43, 46, 50): one-time, interactive, resumable. */
export interface SetupDeps {
  home: string;
  tty: Tty;
  print: (text: string) => void;
  /** The repo's plugin folder, copied to ~/.jarvis/plugin for task sessions' --plugin-dir. */
  pluginSource: string;
  /** The Jarvis checkout, whose .claude-plugin/marketplace.json interactive sessions add. */
  repoRoot: string;
  secrets?: SecretsWriter;
  createNotifier?: (config: NtfyOptions) => Notifier;
  exec?: (bin: string, args: string[]) => string;
  exists?: (path: string) => boolean;
  randomInt?: (max: number) => number;
  now?: () => Date;
  /** Fault injection for state saves. */
  rename?: typeof renameSync;
  /** Test seam for ownership checks; defaults to process.getuid(). */
  uid?: number;
  /** Test seam for the macOS ACL listing (`/bin/ls -lde`); defaults to the real one on macOS. */
  acl?: (path: string) => string;
}
export interface SetupOptions { redo?: readonly string[]; sendTest?: boolean }
export interface SetupResult { ok: boolean; state: SetupState; pending: StepName[] }

/** Where house-stack account tokens go. Not a valid project id, so no project's <id>.env can collide. */
export const accountsSecretsPath = (jarvisHomeDir: string) => join(jarvisHomeDir, "secrets", "house-stack.accounts.env");
export const NTFY_BASE_URL = "https://ntfy.sh";
const TOPIC_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const TOPIC_RANDOM_LENGTH = 24;

/** --redo names; "accounts" means every account step. Unknown names are refused. */
export function parseRedo(values: readonly string[]): Set<StepName> {
  const out = new Set<StepName>();
  for (const value of values) {
    if (value === "accounts") for (const step of ACCOUNT_STEPS) out.add(step);
    else if ((STEPS as readonly string[]).includes(value)) out.add(value as StepName);
    else throw new Error(`Unknown setup step "${value}". Steps: ${STEPS.join(", ")}, or accounts for every account`);
  }
  return out;
}

/** jarvis-<24 random [a-z0-9]> and its -reply twin (architecture §3.7). Topic names are bearer capabilities. */
export function generateTopics(pick: (max: number) => number = randomInt): { topic: string; replyTopic: string } {
  let random = "";
  for (let i = 0; i < TOPIC_RANDOM_LENGTH; i++) random += TOPIC_ALPHABET[pick(TOPIC_ALPHABET.length)];
  const topic = `jarvis-${random}`;
  return { topic, replyTopic: `${topic}-reply` };
}

/**
 * Before anything is asked: every existing runner folder setup writes or trusts must be ours and writable only
 * by us, and an installed plugin must be a trusted tree (Codex review of setup, finding 1). jarvisHome has
 * already checked the home folder and ~/.jarvis.
 */
function checkRunnerFolders(jarvis: string, trust: TrustOptions): void {
  for (const rel of ["secrets", "memory", join("memory", "user")]) {
    const path = join(jarvis, rel);
    if (lstatSync(path, { throwIfNoEntry: false })) checkTrustedDir(path, trust);
  }
  const plugin = join(jarvis, "plugin");
  if (lstatSync(plugin, { throwIfNoEntry: false })) checkTrustedTree(plugin, trust);
}

type Outcome = Omit<StepRecord, "at">;
interface Context {
  deps: SetupDeps;
  home: string;
  jarvis: string;
  secrets: SecretsWriter;
  redo: Set<StepName>;
  state: SetupState;
  trust: TrustOptions;
}
const yes = (answer: string) => /^y(es)?$/i.test(answer.trim());
const SKIPPED_ACCOUNT = "skipped; Jarvis develops against local services (SQLite, or Postgres in Docker) until this account exists (decision 43)";

export async function runSetup(deps: SetupDeps, options: SetupOptions = {}): Promise<SetupResult> {
  const redo = parseRedo(options.redo ?? []);
  const trust: TrustOptions = { ...(deps.uid !== undefined ? { uid: deps.uid } : {}), ...(deps.acl ? { acl: deps.acl } : {}) };
  const jarvis = jarvisHome(deps.home, trust);
  checkRunnerFolders(jarvis, trust);
  let state = loadState(jarvis);
  const ctx: Context = { deps, home: deps.home, jarvis, secrets: deps.secrets ?? envFileSecretsWriter(accountsSecretsPath(jarvis), trust), redo, state, trust };
  const print = deps.print;
  for (const step of STEPS) {
    const prior = state.steps[step];
    if (prior && isFinished(prior) && !redo.has(step)) {
      print(`- ${step}: ${prior.status} earlier (${prior.at}); skipping. Use --redo ${step} to run it again.`);
      continue;
    }
    print(`\n== ${step} ==`);
    const outcome = await runStep(step, ctx);
    print(`${step}: ${outcome.status}. ${outcome.detail}`);
    state = { ...state, steps: { ...state.steps, [step]: { ...outcome, at: (deps.now ?? (() => new Date()))().toISOString() } } };
    ctx.state = state;
    saveState(jarvis, state, { ...trust, ...(deps.rename ? { rename: deps.rename } : {}) });
  }
  let ok = true;
  if (options.sendTest) ok = (await sendTest(ctx)) && ok;
  const pending = STEPS.filter((s) => !isFinished(state.steps[s]));
  if (pending.length) {
    ok = false;
    print(`\nNot finished: ${pending.join(", ")}. Fix what is listed above and run jarvis setup again; finished steps are skipped.`);
  } else print("\nSetup is complete. Run jarvis doctor --live before any unattended run.");
  return { ok, state, pending };
}

function runStep(step: StepName, ctx: Context): Promise<Outcome> | Outcome {
  switch (step) {
    case "claude": return claudeStep(ctx);
    case "secrets": return secretsStep(ctx);
    case "accounts.deploy": return deployStep(ctx);
    case "ntfy": return ntfyStep(ctx);
    case "taste": return tasteStep(ctx);
    case "plugin": return pluginStep(ctx);
    default: {
      const spec = ACCOUNTS[step];
      if (!spec) throw new Error(`no handler for ${step}`);
      return accountStep(spec, ctx, true);
    }
  }
}

function claudeStep(ctx: Context): Outcome {
  const check = checkClaudePinned(ctx.home, ctx.deps.exec, ctx.deps.exists);
  if (check.level === "pass") return { status: "done", detail: check.detail };
  ctx.deps.print(`Claude Code ${CLAUDE_CODE_VERSION} must be installed at ${pinnedClaudeBin(ctx.home)} (decision 57): ${check.detail}`);
  return { status: "failed", detail: check.detail };
}

function secretsStep(ctx: Context): Outcome {
  try {
    ctx.secrets.prepare();
  } catch (error) {
    return { status: "failed", detail: `the secrets backend isn't usable: ${(error as Error).message}` };
  }
  ctx.deps.print([
    `Secrets backend: an owner-only env file, ${ctx.secrets.location} (decision 13).`,
    "Only the broker reads it; task sessions are denied the whole ~/.jarvis folder (decisions 59, 69).",
    "The macOS Keychain backend isn't built yet; the env file is the default on every OS.",
  ].join("\n"));
  return { status: "done", detail: `env file at ${ctx.secrets.location}` };
}

function printAccount(spec: AccountSpec, print: (text: string) => void): void {
  print([`${spec.title}`, ...spec.create.map((l) => `  Create: ${l}`), ...spec.scope.map((l) => `  Scope: ${l}`),
    "  Setup stores the token without contacting the provider; validation happens later."].join("\n"));
}

async function readToken(label: string, ctx: Context): Promise<string> {
  for (;;) {
    const value = (await ctx.deps.tty.askHidden(`${label}: `)).trim();
    if (value === "" || isStorableSecret(value)) return value;
    ctx.deps.print("That doesn't look like a token (8 or more printable characters, no spaces or quotes). Paste it again, or press Enter to skip this account.");
  }
}

async function accountStep(spec: AccountSpec, ctx: Context, confirm: boolean): Promise<Outcome> {
  if (!isFinished(ctx.state.steps.secrets)) return { status: "failed", detail: "the secrets backend isn't ready; fix the secrets step first" };
  const print = ctx.deps.print;
  printAccount(spec, print);
  if (confirm && !yes(await ctx.deps.tty.ask(`Store the ${spec.title} ${spec.tokens.length > 1 ? "credentials" : "token"} now? [y/N] `))) return { status: "skipped", detail: SKIPPED_ACCOUNT, provider: spec.provider };
  const values: string[] = [];
  for (const token of spec.tokens) {
    const value = await readToken(token.label, ctx);
    if (value === "") return { status: "skipped", detail: SKIPPED_ACCOUNT, provider: spec.provider };
    values.push(value);
  }
  const secrets = spec.tokens.map((token) => ({ key: token.key, tier: token.tier, brokerOnly: token.tier === "production" }));
  secrets.forEach((meta, i) => {
    ctx.secrets.set(meta.key, values[i] ?? "", { brokerOnly: meta.brokerOnly });
    print(`Stored ${meta.key} in ${ctx.secrets.location}${meta.brokerOnly ? " (broker-only)" : ""}.`);
  });
  values.length = 0;
  return { status: "done", detail: `stored ${secrets.map((s) => s.key).join(", ")}`, provider: spec.provider, secrets };
}

async function deployStep(ctx: Context): Promise<Outcome> {
  if (!isFinished(ctx.state.steps.secrets)) return { status: "failed", detail: "the secrets backend isn't ready; fix the secrets step first" };
  ctx.deps.print("Deploy host for web apps: Vercel Hobby for personal projects, Netlify Free for commercial ones (decision 33).");
  for (;;) {
    const answer = (await ctx.deps.tty.ask("Deploy host: Vercel or Netlify? [vercel/netlify, Enter to skip] ")).toLowerCase();
    if (answer === "" || answer === "n" || answer === "skip") return { status: "skipped", detail: SKIPPED_ACCOUNT };
    const spec = DEPLOY[answer];
    if (spec) return accountStep(spec, ctx, false);
    ctx.deps.print("Answer vercel, netlify, or press Enter to skip.");
  }
}

function printSubscribe(config: { topic: string; replyTopic: string }, print: (text: string) => void): void {
  print([
    "Subscribe on your phone (decision 50):",
    "  1. Install the ntfy app (iOS App Store or Google Play).",
    `  2. Tap + and subscribe to ${config.topic} on ${NTFY_BASE_URL}. Jarvis's questions, approvals and run results arrive here.`,
    `  3. Subscribe to ${config.replyTopic} too. Buttons post your answers there, and you type steer notes into its publish box.`,
    "  Topic names work like passwords: don't share them. Messages stay short; details stay in REPORT.md on your Mac.",
    "  Run jarvis setup --send-test to send one test notification.",
  ].join("\n"));
}

function readNotifyConfig(path: string): NtfyOptions {
  const config = parseNotifyConfig(JSON.parse(readNoFollow(path)));
  new NtfyNotifier({ baseUrl: config.baseUrl, topic: config.topic, replyTopic: config.replyTopic });
  return { baseUrl: config.baseUrl, topic: config.topic, replyTopic: config.replyTopic };
}

function ntfyStep(ctx: Context): Outcome {
  const path = join(ctx.jarvis, "notify.json");
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) return { status: "failed", detail: `${path} is a symlink; runner-owned files refuse symlinks` };
  if (existing && !ctx.redo.has("ntfy")) {
    try {
      const config = readNotifyConfig(path);
      printSubscribe(config, ctx.deps.print);
      return { status: "done", detail: "kept the existing topics your phone already subscribes to" };
    } catch {
      return { status: "failed", detail: `${path} is not a valid notifier configuration; run jarvis setup --redo ntfy to replace it` };
    }
  }
  const config = { baseUrl: NTFY_BASE_URL, ...generateTopics(ctx.deps.randomInt) };
  new NtfyNotifier(config);
  try {
    writePrivateAtomic(path, `${JSON.stringify(config, null, 2)}\n`, ctx.trust);
  } catch (error) {
    return { status: "failed", detail: (error as Error).message };
  }
  if (existing) ctx.deps.print("New topics replace the old ones: unsubscribe from the old topics in the ntfy app.");
  printSubscribe(config, ctx.deps.print);
  return { status: "done", detail: `wrote ${path} with new topics` };
}

async function sendTest(ctx: Context): Promise<boolean> {
  const path = join(ctx.jarvis, "notify.json");
  try {
    refuseSymlink(path);
    const config = readNotifyConfig(path);
    const notifier = (ctx.deps.createNotifier ?? ((c: NtfyOptions) => new NtfyNotifier(c)))(config);
    await notifier.send({ kind: "confirmation", text: "Jarvis setup test notification. If this reached your phone, notifications work." }, []);
    ctx.deps.print(`Sent a test notification to ${config.topic}. Check your phone.`);
    return true;
  } catch (error) {
    ctx.deps.print(`The test notification failed: ${(error as Error).message}`);
    return false;
  }
}

function splitList(text: string): string[] {
  return text.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

async function tasteStep(ctx: Context): Promise<Outcome> {
  const target = join(ctx.jarvis, "memory", "user", "taste.json");
  if (lstatSync(target, { throwIfNoEntry: false }) && !ctx.redo.has("taste")) return { status: "done", detail: `a taste profile is already saved at ${target}` };
  const { tty, print } = ctx.deps;
  print("Taste profile (decision 39): every design default starts from it. About 10 minutes, asked once.");
  if (!yes(await tty.ask("Set up your taste profile now? [y/N] "))) return { status: "skipped", detail: "declined; run jarvis setup --redo taste, or jarvis taste save <file>, later" };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const profile = {
      admired: splitList(await tty.ask("3 to 5 apps or sites you admire (comma-separated): ")),
      aiMade: await tty.ask("One app or site that looks AI-made to you: "),
      tone: (await tty.ask("Serious or playful? ")).toLowerCase(),
      dislikedColors: splitList(await tty.ask("Colors you dislike (comma-separated, Enter for none): ")),
      dislikedFonts: splitList(await tty.ask("Fonts you dislike (comma-separated, Enter for none): ")),
      platforms: splitList(await tty.ask("Platforms you live on, e.g. macOS, iOS, web (comma-separated): ")),
    };
    const scratch = mkdtempSync(join(ctx.jarvis, ".setup-taste-"));
    try {
      const file = join(scratch, "taste.json");
      writeFileSync(file, JSON.stringify(profile), { mode: 0o600, flag: "wx" });
      const saved = saveTaste(file, { home: ctx.home });
      return { status: "done", detail: `saved ${saved}` };
    } catch (error) {
      print(`${(error as Error).message}. Let's try again.`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  return { status: "failed", detail: "the taste profile wasn't valid after three tries" };
}

function pluginStep(ctx: Context): Outcome {
  let dest: string;
  try {
    dest = installPlugin(ctx.deps.pluginSource, ctx.jarvis, ctx.trust);
  } catch (error) {
    return { status: "failed", detail: (error as Error).message };
  }
  ctx.deps.print([
    `Installed the Jarvis plugin at ${dest}, with its skills copied in as real files.`,
    "Task sessions never load this folder directly: each session gets its own copy with only the build and debug skills, and only that copy is passed to --plugin-dir.",
    "For your interactive Claude Code and the desktop app (intake), enable it from the Jarvis marketplace yourself (decision 80):",
    `  /plugin marketplace add ${ctx.deps.repoRoot}`,
    "  /plugin install jarvis@jarvis",
    "Then check it with: node scripts/desktop-plugin-check.mjs prepare (docs/desktop-plugin-check.md).",
  ].join("\n"));
  return { status: "done", detail: `${dest}: doctor's plugin check passed, the build and debug skills are present, and every file is yours and writable only by you` };
}
