# Jarvis continuation — November 2, 2026

Source handoff: Fable 5.1's November 1 session, committed through `c14075d`.
Continuation branch: `codex/finish-jarvis`. Main was clean at takeover.

## Current local checkpoint

**Local CLI harness proof complete on this machine.** Tested source: `a677b6b`, branch `codex/finish-jarvis`. Fabricio's end-to-end request superseded the planning-only stop (decision 183). The installed plugin 0.1.1 now hands off to reviewed local builds. No deployment occurred; no formal stage or v1 completion is claimed.

1. [x] Restore exact-version pins and repair the local environment; doctor has no failures.
2. [x] Pass both plan calibration controls and save their verified pair through the production CLI.
3. [x] Complete real new-product and bug workflows with protected checks, independent Claude/Codex review, promotion, and reverified status/report. Recover from killing the new-product runner while a builder is alive; never credit the interrupted attempt.
4. [x] Finish regression and focused independent review: **4,707 passed, 18 skipped**, strict typecheck, live safety controls and separate Codex confinement proof. Preserve evidence and install/verify plugin 0.1.1.

Current evidence and exact limits: [local end-to-end verification](reviews/local-e2e-2026-11-02.md). Private receipts: `~/.jarvis/local-readiness/2026-11-02-codex/local-e2e/`. Sample accepted revision: `63af8bb55c70f4bf37113440f224cbb83d130e0e`; direct bug repair: `45e7b1eca5f09eec0261203d0e3a7353b68924e3`. The full interactive `/jarvis` conversation was not exercised live; dispatcher integration has composition coverage. The quiet slot is released at this checkpoint with its ownership marker preserved. Task 10's branch remains unmerged.

**Next use:** restart Claude Code to load plugin 0.1.1, open the intended project, and enter `/jarvis` with the request. Completion is shown by `jarvis status` and `jarvis report`, not the detached-launch PID. To resume direct request work, repeat its original command with `--local` and all workflow selectors.

## Facts recovered

- Fable's passing plan negative control is recorded in `reviews/plan-negative-control-1.md`. Its temporary ledger did not become a shared calibration. The habit-tracker ledger has a valid bad-plan control at sequence 12, but its last completed good-plan control (sequence 24) says `resolve`. The final attempt stopped before recording another verdict. No calibration pass can be assumed.
- `lane/task10` is at `8bd6181`; its 20-file change is absent from main. Its real-gate proof waited on a stale quiet slot and its mutation control failed under load. Neither is passing evidence.
- Fable's 96-definition fast mutation run ended after 25 recorded catches. It has no completed summary and was never confirmation evidence.
- At takeover, doctor reported the Codex global launcher was 0.166.0 versus the 0.164.0 pin. Decision 176 repairs the installation path without changing the reviewed version. Both pins and the live canary now pass; typecheck passes. Free space is about 33 GB, enough for one writer.
- The old quiet-slot owner no longer has a running worker. Its text is preserved at `~/.jarvis-work/quiet-slot.fable-nov1`. The takeover used sequential checks and releases its slot at the completed local checkpoint, preserving its own marker as `quiet-slot.codex-nov2-complete`.

The first full baseline took 384.55 seconds: 4,632 passed, two release integration failures, 18 skipped. The first failure was the known independent-builder ordering assumption (backlog 244); the second was the fixture's missing dependency declaration and lockfile. Both are repaired without weakening the release dependency policy (decision 177). Evidence is retained outside the public checkout at `~/.jarvis/local-readiness/2026-11-02-codex/`.

The previous calibration blocker is resolved by decisions 184 and 188: simplify artificial task decomposition and supply the reviewer with the trusted runner contract and the approved spec context. Preserve failed historical controls; use the newly saved verified pair.

## Completion bar

The existing stage reviews are not all approved. Later code already exists, but its presence does not close a stage. Follow the recorded gates, preserve failed historical evidence, and do not substitute subset mutation catches for `--confirm` or a stage-scoped confirmation. The current inventory and full-suite baseline project about 309 hours for serial full confirmation (decision 183); a planning estimate is not completed evidence.

Deferred beyond this local-readiness checkpoint: task 10's independent review/proof and merge, the frozen golden-task reruns, remaining stage reviews, and full mutation confirmation. None is marked complete by the local repair.
