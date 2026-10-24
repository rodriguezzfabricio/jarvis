import { describe, expect, it } from "vitest";
import { parseStreamJson } from "../../packages/cli/src/harness/claude/streamjson.ts";
import { sessionUsage } from "../../packages/cli/src/harness/claude/usage.ts";

const lines = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n");
const init = { type: "system", subtype: "init", model: "claude-sonnet-5-5", claude_code_version: "2.1.309" };
const assistant = (id: string, usage: Record<string, unknown>) => ({ type: "assistant", message: { id, content: [], usage } });
const result = (extra: Record<string, unknown> = {}) => ({
  type: "result", subtype: "success", is_error: false, num_turns: 4, total_cost_usd: 0.4321,
  usage: { input_tokens: 1200, output_tokens: 3400, cache_read_input_tokens: 56000, cache_creation_input_tokens: 7800 },
  ...extra,
});

describe("Claude session usage from stream-json", () => {
  it("reads the final result's totals, cost, turns and the init model", () => {
    const usage = sessionUsage(parseStreamJson(lines(init, assistant("m1", { input_tokens: 1, output_tokens: 1 }), result())));
    expect(usage).toEqual({
      reportedModel: "claude-sonnet-5-5", inputTokens: 1200, outputTokens: 3400, cacheReadTokens: 56000, cacheWriteTokens: 7800,
      costUsd: 0.4321, turns: 4, complete: true,
    });
  });

  it("uses the last result when a stream reports more than one", () => {
    const usage = sessionUsage(parseStreamJson(lines(init, result({ num_turns: 1 }), result({ num_turns: 9 }))));
    expect(usage.turns).toBe(9);
  });

  it("marks a truncated stream incomplete and sums assistant usage once per message id", () => {
    const text = lines(
      init,
      assistant("m1", { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100 }),
      assistant("m1", { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }),
      assistant("m2", { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 200, cache_creation_input_tokens: 3 }),
    ) + '\n{"type":"result","subtype":"succ';
    const usage = sessionUsage(parseStreamJson(text));
    expect(usage).toEqual({
      reportedModel: "claude-sonnet-5-5", inputTokens: 30, outputTokens: 12, cacheReadTokens: 300, cacheWriteTokens: 3,
      costUsd: undefined, turns: undefined, complete: false,
    });
  });

  it("falls back to assistant usage when the result has none, and keeps the result's cost and turns", () => {
    const final = result();
    delete (final as { usage?: unknown }).usage;
    const usage = sessionUsage(parseStreamJson(lines(init, assistant("m1", { input_tokens: 4, output_tokens: 2 }), final)));
    expect(usage).toMatchObject({ inputTokens: 4, outputTokens: 2, cacheReadTokens: undefined, costUsd: 0.4321, turns: 4, complete: true });
  });

  it("reports missing or wrong-typed fields as undefined, never as zero", () => {
    const usage = sessionUsage(parseStreamJson(lines(
      { type: "system", subtype: "init" },
      result({ total_cost_usd: "0.43", num_turns: null, usage: { input_tokens: "12", output_tokens: 5 } }),
    )));
    expect(usage).toEqual({
      reportedModel: undefined, inputTokens: undefined, outputTokens: 5, cacheReadTokens: undefined, cacheWriteTokens: undefined,
      costUsd: undefined, turns: undefined, complete: true,
    });
  });

  it("passes absurd numbers through unchanged for the runner to reject", () => {
    const usage = sessionUsage(parseStreamJson(lines(result({ total_cost_usd: -5, usage: { input_tokens: 1e300, output_tokens: 1.5 } }))));
    expect(usage).toMatchObject({ inputTokens: 1e300, outputTokens: 1.5, costUsd: -5 });
  });

  it("returns an empty, incomplete record for an empty stream", () => {
    expect(sessionUsage(parseStreamJson(""))).toEqual({
      reportedModel: undefined, inputTokens: undefined, outputTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined,
      costUsd: undefined, turns: undefined, complete: false,
    });
  });
});
