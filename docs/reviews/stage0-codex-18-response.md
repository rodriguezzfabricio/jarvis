# Codex review round 18 (stages 0 and 1): integrator response

Reviewed revision e85023f, lanes A, B and D, verdict FAIL on all three. Triage under decision 84: a critical, or a high with a concrete path to a credential leak, an action outside the broker or a false pass, blocks; the rest goes to the backlog.

## Evidence
- Live probe and doctor --live: pass.
- Unit tests: 3 failures. Two ledger tests time out under load (traced to lane D's ledger.ts:382 finding, being fixed). One usage-mutation naming test (fixed in c39f46f).
- Live tests: the stage 1 safety fixture is no longer a Jarvis session, so the tripwire didn't fire (decision 96 regression, being fixed).
- Mutation check: never reached the mutations. An opt-in skipped test made the control "unfinished" (being fixed).

## Blocking
| Finding | Lanes | Owner |
|---|---|---|
| Gate candidates can read system temp folders (`checks/gate.ts:142`) | A, D | Claude worker (temp lane) |
| Localhost allowlisting reaches privileged services through the proxy (`eval/baseline.ts:48`) | B | Codex lane 21 |

## Not blocking, fixed anyway (they block the evidence or are cheap)
- Skipped tests and the control (A, D); background processes after suites (D); review-status: stage-scoped summaries and decision 84's bar (D).
- The safety live fixture's Jarvis session (A, D); task settings and `jarvis act` (D); relative Bash paths and the runner home (D, low).
- Ledger crash recovery deadline (D).
- The public Go proxy as an exfiltration route (B): sessions can't read credentials, so only the snapshot could leave. Lane 21 replaces the proxy with a read-only module cache if that's small; otherwise a decision records the residual risk.

## Backlog
- Snapshot scanner (A 1, B 5) and the npm-token fixture test (A): mediums under decision 79 (the scanner is hygiene; the boundary is the sandbox, the allowlist and the broker). Backlog rows 78–84.

Round 18 reruns its evidence and a narrow re-check of the two blocking findings once the fixes land.
