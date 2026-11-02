# Jarvis continuation — November 2, 2026

Source handoff: Fable 5.1's November 1 session, committed through `c14075d`.
Continuation branch: `codex/finish-jarvis`. Main was clean at takeover.

## Current work

Fabricio clarified the immediate target on Nov 2: **usable local Jarvis first**. Full v1 proof gates remain required before declaring v1 complete.

Fabricio also explicitly chose to **keep the planning-only `/jarvis` stop** (decision 120). This checkpoint prepares local planning and review; it does not enable automatic build launch or mark the later stage proofs complete.

1. [x] Recover the handoff and inspect the actual local state.
2. [x] Restore the reviewer pin and repair the two failing release integration tests (`a51d6ce`, `b1091ec`; 59 pin/install checks and 17 release checks pass).
3. [x] Restore the missing Claude pin with its signed bundle and pass the live doctor/canary. After the old symlink disappeared again, pin the intact bundle directly; the direct path passes the live canary (decisions 178, 180).
4. [x] Diagnose calibration and record its blocker. Three fixture revisions still did not clear all reviewers; calibration is deferred for the planning-only checkpoint, and no shared passing pair is saved.
5. [x] Rerun the complete suite and verify the local launcher/plugin. Final result: 4,657 passed, 18 skipped in 446.93 seconds; 306 files passed, 10 skipped. Typecheck, live doctor/canary, and all five local CLI smoke checks pass. See [the local readiness checkpoint](reviews/local-readiness-2026-11-02.md).

## Facts recovered

- Fable's passing plan negative control is recorded in `reviews/plan-negative-control-1.md`. Its temporary ledger did not become a shared calibration. The habit-tracker ledger has a valid bad-plan control at sequence 12, but its last completed good-plan control (sequence 24) says `resolve`. The final attempt stopped before recording another verdict. No calibration pass can be assumed.
- `lane/task10` is at `8bd6181`; its 20-file change is absent from main. Its real-gate proof waited on a stale quiet slot and its mutation control failed under load. Neither is passing evidence.
- Fable's 96-definition fast mutation run ended after 25 recorded catches. It has no completed summary and was never confirmation evidence.
- At takeover, doctor reported the Codex global launcher was 0.166.0 versus the 0.164.0 pin. Decision 176 repairs the installation path without changing the reviewed version. Both pins and the live canary now pass; typecheck passes. Free space is about 33 GB, enough for one writer.
- The old quiet-slot owner no longer has a running worker. Its text is preserved at `~/.jarvis-work/quiet-slot.fable-nov1`. The takeover used sequential checks and releases its slot at the completed local checkpoint, preserving its own marker as `quiet-slot.codex-nov2-complete`.

The first full baseline took 384.55 seconds: 4,632 passed, two release integration failures, 18 skipped. The first failure was the known independent-builder ordering assumption (backlog 244); the second was the fixture's missing dependency declaration and lockfile. Both are repaired without weakening the release dependency policy (decision 177). Evidence is retained outside the public checkout at `~/.jarvis/local-readiness/2026-11-02-codex/`.

Calibration is not an installation failure now: the exact Claude pin and live safety probe pass. The good fixture still receives `resolve`. The latest findings challenge its artificial T1/T2 diagnostic split and a claim about case ordering whose runner contract is absent from the reviewer checkout. Three fixture corrections were attempted, then editing stopped per the local AGENTS instruction. The next calibration work should simplify the good plan and supply a verifiable check-format contract; do not keep adding tiny tasks or rerun unchanged material hoping for a pass. Fabricio asked for the best next step; the recommendation was to finish the planning-only checkpoint and defer this separate proof work.

## Completion bar

The existing stage reviews are not all approved. Later code already exists, but its presence does not close a stage. Follow the recorded gates, preserve failed historical evidence, and do not substitute subset mutation catches for `--confirm` or a stage-scoped confirmation. Decision 154's last measured estimate for the final full confirmation was approximately 71 machine-hours; the current test baseline must be measured again before scheduling it.

Deferred beyond this local-readiness checkpoint: task 10's independent review/proof and merge, the frozen golden-task reruns, remaining stage reviews, and full mutation confirmation. None is marked complete by the local repair.
