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

export interface RateLimitInfo {
  status: string | undefined;
  resetsAt: number | undefined;
  rateLimitType: string | undefined;
  utilization: Record<string, number>;
}

/** decision 62: usage limits come from rate_limit_event, never from the exit code. */
export function rateLimits(events: readonly StreamEvent[]): RateLimitInfo[] {
  return events
    .filter((e) => e.type === "rate_limit_event")
    .map((e) => {
      const i = (e.rate_limit_info ?? {}) as Record<string, unknown>;
      const windows = (i.unifiedWindows ?? {}) as Record<string, { utilization?: unknown }>;
      const utilization: Record<string, number> = {};
      for (const [k, w] of Object.entries(windows)) if (typeof w?.utilization === "number") utilization[k] = w.utilization;
      return {
        status: typeof i.status === "string" ? i.status : undefined,
        resetsAt: typeof i.resetsAt === "number" ? i.resetsAt : undefined,
        rateLimitType: typeof i.rateLimitType === "string" ? i.rateLimitType : undefined,
        utilization,
      };
    });
}
