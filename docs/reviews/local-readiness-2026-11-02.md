# Local readiness checkpoint — November 2, 2026

Superseded checkpoint: Fabricio subsequently authorized the local end-to-end build (decision 183). Calibration and the local CLI build/bug/recovery proofs are now complete. The planning-only scope below is preserved as history. [Current evidence](local-e2e-2026-11-02.md).

Scope: Fabricio requested usable local Jarvis first, then explicitly chose to retain the planning-only `/jarvis` stop. This is a repair and verification record, not an independent stage approval or a v1 completion claim.

## Repairs

- `a51d6ce`: isolate the exact Codex 0.164.0 native pin from updates to the ordinary global installation (decision 176).
- `b1091ec`: repair both release composition fixtures after dependency gating; the real sandboxed dependency worker must produce the build's marker, and independent builders may finish in either order (decision 177).
- `c462117`, `47d8ba9`, `e4b2f0e`: make calibration checks executable and internally consistent, including error behavior, special characters, preserved data and safe intermediate tasks (decisions 179, 181, 182). Negative examples reproduced each repair's gaps first. Reviewer policy and thresholds are unchanged.
- `a9af433`: point Claude 2.1.309 directly into the preserved, signed app bundle after the old version entry disappeared twice (decisions 178, 180). No signature bypass or version upgrade.
- `042ca3a`: align the doctor's mock and missing-pin instructions with the preserved bundle. The live doctor already passed; the full suite exposed a test still recognizing the old filename suffix.

## Verification

| Check | Result |
|---|---|
| Initial full baseline | 4,632 passed, 2 failed, 18 skipped; 384.55 seconds. Both failures were the release composition cases repaired above. |
| Focused release checks | 17 passed; removing dependency-pin forwarding reproduced the failure before the fix. |
| Pin/install checks | 59 passed after the Codex repair; 12 passed after the Claude repair. The direct Claude pin test failed against the old path first. |
| Doctor/pin/install follow-up | 35 passed after updating the stale doctor mock. The preceding full run passed 4,656 tests and failed that one case, with 18 skipped, in 425.13 seconds. |
| Fixture and plan command checks | 35 passed after the repairs, in 19.27 seconds. The growing test file was split into two with shared setup, per AGENTS.md. Broken variants demonstrate that the strengthened fixture checks reject the targeted defects. |
| Typecheck | Passed after the code changes. |
| Live doctor on the direct Claude pin | Passed all mandatory checks, including the live canary's allowed operations and denied reads, writes, network access and hook access. Both agent versions match. |
| Real CLI / local broker smoke | All 5 checks passed: pending approval, changed-payload approval, one local outbox receipt, duplicate prevention and rejection of a tampered ledger. No outside message was sent. |
| Installed launcher | `jarvis --help` works; `ask:` triage selects read-only research and answer, with no handoff. |
| Plugin | Installed and enabled; the configured local marketplace resolves this checkout's current command, skills, 3 agents and 2 hooks. |
| Final full suite | **PASS:** 4,657 passed, 18 skipped; 306 files passed, 10 skipped; 446.93 seconds. `pnpm test` exited 0 on code commit `042ca3a`. Skipped tests are not claimed as passing evidence. |
| Shared plan calibration | Not ready; deferred. The good fixture still receives `resolve`, so no shared calibration pair is saved. The valid earlier bad control caught T2, T3 and D3, but that alone cannot unlock counted plan reviews. |

Raw local logs are retained privately under `~/.jarvis/local-readiness/2026-11-02-codex/`. Plan control receipts remain in the runner-owned ledger and evidence folders; failed attempts are preserved.

The final good control is sequence 48, overall `resolve`, hash `c131e70dd21e3ac7c34697777e91d5f654ee0facf714a7270c9b5aab96e122b3`. Zoom-out and critic returned `resolve`; readiness passed. All used `claude-opus-5-5` and unchanged policy `b734806658c538783ba536dbb5c804f4056a175a6cc6c9f9564b4e2f56e54d75`. The earlier valid bad control is sequence 12, hash `6d4b126ff9af56e1bb83e4eb0321012ed9b45dd184f3d66482be5f167f5dbf01`. Neither a partial good pass nor the bad pass is presented as a successful pair.

## Boundaries

The launcher uses this checkout. `/jarvis` still stops after planning, by Fabricio's explicit choice. A future architect plan still needs approved checks and a counted review at its exact hash; calibration does not approve a project plan.

After three fixture repair attempts, calibration editing stopped. The remaining findings concern unnecessary intermediate diagnostic work in the three-task good plan and the absence of verifiable runner case-order documentation in the review material. The fixture's executable checks pass their positive and negative examples, but that does not substitute for the live review. Simplifying that plan and documenting the external format contract is the next calibration investigation, outside this planning-only checkpoint.

No stage is promoted by this checkpoint. Task 10's branch and proof, frozen golden-task reruns, remaining independent stage reviews, fresh-machine installation and full mutation confirmation remain open. The added release mutation is not claimed as a completed `--confirm` run. No deployment or production grant was made.

Doctor reports about 33 GB free, so the existing single-writer limit applies. Unconfigured Vercel/Netlify pins, a missing protected QA manifest and the absence of a broker outside a run are warnings, not evidence that those optional paths have been verified.
