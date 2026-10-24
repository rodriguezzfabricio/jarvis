import type { SessionUsage } from "../../runner/harness.ts";
import { initInfo, type StreamEvent } from "./streamjson.ts";

interface Tokens { input?: number | undefined; output?: number | undefined; cacheRead?: number | undefined; cacheWrite?: number | undefined }

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

function tokens(usage: unknown): Tokens | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  return { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens) };
}

/** A field is unknown only when no message reported it. */
function sum(list: readonly Tokens[], key: keyof Tokens): number | undefined {
  const values = list.map((t) => t[key]).filter((v): v is number => v !== undefined);
  return values.length ? values.reduce((a, b) => a + b, 0) : undefined;
}

/** One API call can span several assistant events with the same message id; the last carries its usage. */
function messageTokens(events: readonly StreamEvent[]): Tokens | undefined {
  const byMessage = new Map<string, Tokens>();
  let anonymous = 0;
  for (const e of events) {
    if (e.type !== "assistant") continue;
    const message = e.message as { id?: unknown; usage?: unknown } | undefined;
    const t = tokens(message?.usage);
    if (t) byMessage.set(typeof message?.id === "string" ? message.id : `#${anonymous++}`, t);
  }
  if (!byMessage.size) return undefined;
  const list = [...byMessage.values()];
  return { input: sum(list, "input"), output: sum(list, "output"), cacheRead: sum(list, "cacheRead"), cacheWrite: sum(list, "cacheWrite") };
}

/**
 * What a `claude -p` stream says the session consumed. The final `result` carries session totals
 * (`usage`, `total_cost_usd`, `num_turns`); a stream without one was killed, timed out or truncated,
 * and the assistant messages' own usage is summed instead, as a lower bound. Values are passed through
 * unchecked; the runner rejects implausible ones (runner/usage-log.ts).
 */
export function sessionUsage(events: readonly StreamEvent[]): SessionUsage {
  const result = events.filter((e) => e.type === "result").at(-1);
  const t = tokens(result?.usage) ?? messageTokens(events) ?? {};
  return {
    reportedModel: initInfo(events)?.model,
    inputTokens: t.input,
    outputTokens: t.output,
    cacheReadTokens: t.cacheRead,
    cacheWriteTokens: t.cacheWrite,
    costUsd: num(result?.total_cost_usd),
    turns: num(result?.num_turns),
    complete: result !== undefined,
  };
}
