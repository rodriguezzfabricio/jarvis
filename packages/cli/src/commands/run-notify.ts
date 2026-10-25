import { lstatSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { readNoFollow } from "../config/private-file.ts";
import { parseNotifyConfig } from "../notify/config.ts";
import type { Message, Notifier } from "../notify/notifier.ts";
import { NtfyNotifier, type NtfyOptions } from "../notify/ntfy.ts";
import type { UsageWaitNotice } from "../runner/usage-wait.ts";

/**
 * What `jarvis run` tells Fabricio through the runner's notifier (decision 50, architecture §3.7): a blocked
 * task, a usage wait longer than two hours, and the end of the run. Messages are short status lines with no
 * buttons; the details stay in REPORT.md. A missing or broken notifier config never blocks the run
 * (decisions 10, 91): every notice resolves, and the runner's log says it wasn't delivered, naming the config
 * file and never its contents (topic names are bearer capabilities).
 */
export interface RunNotifications {
  usageWait(notice: UsageWaitNotice): Promise<void>;
  blocked(notice: { taskId: string; reason: string }): Promise<void>;
  /** The run's end: its status and the report's one-line summary, or "error" when the loop threw. */
  finished(outcome: { status: "complete" | "blocked"; summary: string } | { status: "error" }): Promise<void>;
}
export interface RunNotificationOptions {
  /** ~/.jarvis/notify.json, as jarvis setup writes it. Read once, when the run starts. */
  configPath: string;
  project: string;
  /** Test seam; production uses the ntfy adapter, which validates the URL and topics. */
  createNotifier?: (config: NtfyOptions) => Notifier;
  warn?: (text: string) => void;
  /** How long one send may take before the run gives up on it (the adapter's own timeout is 10 s). */
  timeoutMs?: number;
}

type Config = { status: "ok"; notifier: Notifier; secrets: string[] } | { status: "missing" | "invalid" };

function load(o: RunNotificationOptions): Config {
  let raw: string;
  try {
    if (!lstatSync(o.configPath, { throwIfNoEntry: false })) return { status: "missing" };
    raw = readNoFollow(o.configPath); // runner-owned files refuse symlinks (O_NOFOLLOW) and anything but a file
  } catch { return { status: "invalid" }; }
  try {
    const config = parseNotifyConfig(JSON.parse(raw));
    const options: NtfyOptions = { baseUrl: config.baseUrl, topic: config.topic, replyTopic: config.replyTopic, ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}) };
    return { status: "ok", notifier: (o.createNotifier ?? ((c) => new NtfyNotifier(c)))(options), secrets: [config.topic, config.replyTopic] };
  } catch { return { status: "invalid" }; }
}

const oneLine = (text: string) => text.replace(/[\r\n\t\x00-\x1f]+/g, " ").trim().slice(0, 240);

export function runNotifications(o: RunNotificationOptions): RunNotifications {
  const warn = o.warn ?? console.error;
  const timeoutMs = o.timeoutMs ?? 30_000;
  const config = load(o);
  const problem = config.status === "missing" ? `${o.configPath} is missing` : `${o.configPath} is not a valid notifier configuration`;
  if (config.status === "missing") warn(`Notifications are off for this run: no notifier configuration at ${o.configPath} (run jarvis setup).`);
  if (config.status === "invalid") warn(`Notifications are off for this run: ${o.configPath} is not a valid notifier configuration (run jarvis setup --redo ntfy).`);

  async function send(what: string, build: () => Message): Promise<void> {
    if (config.status !== "ok") { warn(`Notification not delivered (${what}): ${problem}.`); return; }
    const stop = new AbortController();
    try {
      const message = build();
      const timedOut = delay(timeoutMs, "timeout", { signal: stop.signal }).catch(() => "stopped");
      if (await Promise.race([config.notifier.send(message, []).then(() => "sent"), timedOut]) === "timeout") throw new Error(`timed out after ${timeoutMs} ms`);
    } catch (error) {
      let reason = oneLine(error instanceof Error ? error.message : String(error));
      for (const secret of config.secrets) reason = reason.replaceAll(secret, "<topic>");
      warn(`Notification not delivered (${what}) through ${o.configPath}: ${reason}`);
    } finally { stop.abort(); }
  }
  const head = `Jarvis ${o.project}:`;
  return {
    blocked: (n) => send(`${n.taskId} blocked`, () => ({ kind: "blocked", text: `${head} ${n.taskId} is blocked: ${oneLine(String(n.reason))}. The rest of the plan continues; REPORT.md has the details.` })),
    usageWait: (n) => send("usage wait", () => {
      const hours = Math.max(1, Math.round(n.waitMs / 3_600_000));
      const until = new Date(n.resumeAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      return { kind: "usage-wait", waitMs: n.waitMs, text: `${head} usage limit reached. Waiting about ${hours} h, until ${until}; ${n.taskId} resumes then.` };
    }),
    finished: (outcome) => send("run finished", () => ({
      kind: "finished",
      text: outcome.status === "error" ? `${head} the run stopped with an error. The runner log on your Mac has the details.` : `${head} run ${outcome.status}. ${oneLine(String(outcome.summary))}`,
    })),
  };
}
