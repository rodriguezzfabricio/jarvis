import { runGate, type GateCheck, type GateInput, type GateResult, type GateStatus } from "../checks/gate.ts";
import type { CheckId, LaneSelection } from "./selection.ts";

export interface LaneGateInput {
  selections: readonly LaneSelection[];
  /** Approved check definitions, loaded by the runner, never from the candidate. */
  definitions: Partial<Record<CheckId, GateCheck>>;
  input: Omit<GateInput, "check">;
}
export type LaneCheckResult = { check: CheckId; status: GateStatus; result: GateResult } |
  { check: CheckId; status: "not run"; reason: string };

/** The existing gate owns lock verification, sandboxing, checkout creation and ledger evidence. */
export async function runLaneChecks(options: LaneGateInput, gate: (input: GateInput) => Promise<GateResult> = runGate): Promise<LaneCheckResult[]> {
  const results: LaneCheckResult[] = [];
  for (const check of new Set(options.selections.flatMap(l => l.checks))) {
    const definition = Object.hasOwn(options.definitions, check) ? options.definitions[check] : undefined;
    if (!definition) { results.push({ check, status: "not run", reason: "no protected definition" }); continue; }
    const result = await gate({ ...options.input, check: definition });
    results.push({ check, status: result.status, result });
  }
  return results;
}
