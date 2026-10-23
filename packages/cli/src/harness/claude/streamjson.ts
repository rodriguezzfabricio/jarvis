/** Minimal parser for `claude -p --output-format stream-json` output. */

export type StreamEvent = { type: string; [key: string]: unknown };

export function parseStreamJson(text: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const v = JSON.parse(t) as unknown;
      if (v && typeof v === "object" && typeof (v as { type?: unknown }).type === "string") events.push(v as StreamEvent);
    } catch {
      // Ignore partial or non-JSON lines; callers check for the events they need.
    }
  }
  return events;
}

export interface InitInfo {
  claudeCodeVersion: string | undefined;
  model: string | undefined;
  permissionMode: string | undefined;
  apiKeySource: string | undefined;
  plugins: unknown[];
  memoryPaths: unknown;
}

export function initInfo(events: readonly StreamEvent[]): InitInfo | undefined {
  const e = events.find((x) => x.type === "system" && x.subtype === "init");
  if (!e) return undefined;
  const str = (k: string) => (typeof e[k] === "string" ? (e[k] as string) : undefined);
  return {
    claudeCodeVersion: str("claude_code_version"),
    model: str("model"),
    permissionMode: str("permissionMode"),
    apiKeySource: str("apiKeySource"),
    plugins: Array.isArray(e.plugins) ? (e.plugins as unknown[]) : [],
    memoryPaths: e.memory_paths,
  };
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: { isError: boolean; text: string };
}

type Block = { type?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown; is_error?: unknown; content?: unknown };

function blocks(e: StreamEvent): Block[] {
  const msg = e.message as { content?: unknown } | undefined;
  return Array.isArray(msg?.content) ? (msg.content as Block[]) : [];
}

function contentText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (x && typeof x === "object" && "text" in x ? String((x as { text: unknown }).text) : JSON.stringify(x))).join("\n");
  return JSON.stringify(c ?? "");
}

export function toolCalls(events: readonly StreamEvent[]): ToolCall[] {
  const calls = new Map<string, ToolCall>();
  for (const e of events) {
    for (const b of blocks(e)) {
      if (e.type === "assistant" && b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
        calls.set(b.id, { id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
      }
      if (e.type === "user" && b.type === "tool_result" && typeof b.tool_use_id === "string") {
        const call = calls.get(b.tool_use_id);
        if (call) call.result = { isError: b.is_error === true, text: contentText(b.content) };
      }
    }
  }
  return [...calls.values()];
}

export interface RateLimitWindow {
  utilization: number;
  resetsAt: number | undefined;
}

export interface RateLimitInfo {
  status: string | undefined;
  resetsAt: number | undefined;
  rateLimitType: string | undefined;
  windows: Record<string, RateLimitWindow>;
}

/** decision 62: usage limits come from rate_limit_event, never from the exit code. */
export function rateLimits(events: readonly StreamEvent[]): RateLimitInfo[] {
  return events
    .filter((e) => e.type === "rate_limit_event")
    .map((e) => {
      const i = (e.rate_limit_info ?? {}) as Record<string, unknown>;
      const raw = (i.unifiedWindows ?? {}) as Record<string, { utilization?: unknown; resetsAt?: unknown }>;
      const windows: Record<string, RateLimitWindow> = {};
      for (const [k, w] of Object.entries(raw)) {
        if (typeof w?.utilization === "number") windows[k] = { utilization: w.utilization, resetsAt: typeof w.resetsAt === "number" ? w.resetsAt : undefined };
      }
      return {
        status: typeof i.status === "string" ? i.status : undefined,
        resetsAt: typeof i.resetsAt === "number" ? i.resetsAt : undefined,
        rateLimitType: typeof i.rateLimitType === "string" ? i.rateLimitType : undefined,
        windows,
      };
    });
}

/** True when any assistant message reports a rate-limit error (a limited run can still end "success"). */
export function hitRateLimitError(events: readonly StreamEvent[]): boolean {
  return events.some((e) => e.type === "assistant" && (e.error === "rate_limit" || (e.message as { error?: unknown } | undefined)?.error === "rate_limit"));
}

/**
 * When to resume after a run (decision 62): if the plan rejected the run, or any window is at or
 * above the threshold, the latest reset among the windows that are over it (or the event's own
 * reset when the run was rejected). Undefined means no wait is needed.
 */
export function usageWaitUntil(infos: readonly RateLimitInfo[], opts: { threshold?: number; limitedByError?: boolean } = {}): number | undefined {
  const threshold = opts.threshold ?? 0.85;
  const last = infos.at(-1);
  if (!last) return opts.limitedByError ? Math.floor(Date.now() / 1000) + 3600 : undefined;
  const over = Object.values(last.windows).filter((w) => w.utilization >= threshold);
  const rejected = last.status === "rejected" || opts.limitedByError === true;
  if (!rejected && over.length === 0) return undefined;
  const resets = over.map((w) => w.resetsAt).filter((r): r is number => typeof r === "number");
  if (rejected && last.resetsAt !== undefined) resets.push(last.resetsAt);
  return resets.length ? Math.max(...resets) : Math.floor(Date.now() / 1000) + 3600;
}
