# What Jarvis should take from Google's Elephant-Goldfish Model

Date: 2026-10-27. Source: google/elephant-goldfish-model (EGM) v0.1.0, last commit 2026-10-21, cloned read-only. Jarvis at commit 21003f6.

## Verdict in one paragraph

The complaint is right, but the hole is in a different place than "the architect skill has no rubric". Jarvis has a strong *verdict* spine: runner-made evidence, protected checks with a nonce, hash-chained ledger, runner-computed review verdict, fast-forward-only promotion, sandboxed reviewers. It has an almost empty *decision* layer: every design decision (what to build, how to split it, which engineering option) is made once, by one model, in one context, with no fresh-eyes review of the decision, no required alternatives, and no way for a finding to come back to the author. EGM is the mirror image: it has no runtime and no code-level evidence at all, but its whole product is the decision layer. The two fit together without overlap.

Honest caveat: EGM cannot "verify what a good architecture is" either. Nobody's prompt can. What EGM does is make the decision *legible* (alternatives with rejection reasons), *adversarially read* (a hostile fresh-context reviewer with named audit vectors and a document standard), *contestable only with evidence* (the author must cite a file and symbol or a recorded decision), and *overridable by the human* (ESCALATE). That is the realistic target for Jarvis too.

## Verified wiring bugs in Jarvis (fix before anything from EGM)

These were checked against the code, not only reported by the audit.

1. **Review findings never reach the repair session.** `runner/repair.ts:32` appends only `summary`; `review/service.ts:211` sets summary to the literal `Review fail`. The builder gets two blind repairs, then a block. This hits every build golden task.
2. **Reviews run on the fast tier in production.** `commands/run-compose.ts:88,94` hard-code `tier: 1`; `runner/routing.ts:37` routes tier 1 reviews to `default: "fast"`. Decision 24's "tier-2 final review always strong" never fires from `jarvis run`. Backlog 119 defers this.
3. **The check-authoring review is unreachable.** `runner/checks-author.ts:371` `installChecks` has no caller outside tests; `jarvis run` reads only already-approved checks. The architect's proposals and the eight bypass probes are reviewed by nobody in production.
4. **Medium and low findings are dropped.** Not in REPORT.md, not in a backlog, not shown to the builder.
5. **A reviewer can pass on a shallow read.** `review/verdict.ts:33`: `{"findings":[]}` is a PASS; no coverage list in loop mode. Decision 114 already observed "3 or 4 turns and read only the changed files".

## What to take from EGM, ranked

### 1. A Goldfish design-review stage before the build loop
Today the only fresh-eyes step before code is the spec-reader, which checks testability, not design. The plan (`.jarvis/plan.json`) gets schema and AC-coverage validation only (`runner/plan.ts:52-70`).

Add a stage between architect and `jarvis run`: fresh-context, read-only reviewers over `docs/spec/vN.md`, `.jarvis/plan.json`, the decision register and the repo. Reuse Jarvis's own machinery: plugin agents with restricted tools (like `plugin/agents/spec-reader.md`), the Codex Seatbelt jail, a runner-computed verdict like `review/verdict.ts`. Borrow three EGM personas, adapted to Jarvis's artifacts:

- **zoom_out** ("Skeptical Architect"): must run code search before accepting any new utility; flags YAGNI, premature optimization (caching, sharding, queues), reinventing existing components, altitude drops.
- **design_critic**: checks the plan against a standard; flags unbacked assertions, single points of failure, unmitigated risks. Severity Blocker / Major / Nit.
- **implementation_readiness**: "Do I know exactly what to code, where, and how, based on this text?" Flags every choice the plan leaves to the implementer.

EGM's isolation rules worth copying exactly: the reviewer gets only the target, the standard, and an explicit reading list; never the parent deliberation, never planner notes (Jarvis already does this for code review); a reviewer that cannot read a required file reports an incomplete review, not a verdict; a launched reviewer is not a completed review.

### 2. The Zero-Decision Rule for plans, and required alternatives for decisions
EGM's `implementation-readiness-standard.md`: a plan "must leave zero design or architectural choices to the implementer" or it fails. EGM's `feature-spec-standard.md` Alternatives Rule: a design fails if it "proposes a single path without proving that other viable designs were considered and rejected for specific, documented reasons".

In Jarvis: `jarvis decide --alternatives` defaults to `-` (`decisions/decide.ts:43`). Make alternatives with a rejection reason required for architect-class and build-class engineering decisions. Then the readiness goldfish checks that every choice a build session would otherwise make is either in the plan, in `notes`, or in the register. This is the direct answer to "the model makes the decision": the decision still comes from the model, but it is written down with what it rejected and why, and a second model with no memory of the reasoning has to be unable to find a gap.

### 3. The Resolve protocol for findings
Today the spec author triages its own reader's findings ("Fix each gap in the draft, or record why not"). EGM's `egm_resolve` gives each finding exactly one of:

- **CONTEST**: must cite evidence the reviewer could have read (a file and symbol, or a recorded decision). "This was intentional" is not evidence. Severity may not be changed.
- **ESCALATE**: the evidence is outside every file the reviewer could read (a convention, a verbal decision). Do not fix; give it to the user, listed first.
- **PROPOSE FIX**: exact textual replacement.
- **DECLINE**: nits only, recorded.

Plus: "Do not add context only to satisfy a reviewer." Apply this to spec-reader findings, to the new design-review findings, and to code-review findings in the repair prompt (bug 1 above).

### 4. A reviewer must-check list and a "what I checked" output
EGM's weakest point is also Jarvis's: no reviewer-side evidence contract. Jarvis is better placed to fix it because its verdict is runner-computed. Require loop-mode reviews to output a `cleared` list (already exists in report mode, `review-fix.ts:48`) naming what was read and which must-check items were covered (data flow, error paths, unchanged callers, the bug brief's two traced inputs). An empty findings list with an empty cleared list is `investigate`, not `pass`.

### 5. Intermediate zoom-out after fix rounds, and a re-audit cap
EGM learned that fix rounds bloat designs with defensive over-engineering, so Stage 8 re-runs zoom_out on the fixed document "while avoiding re-flagging decisions accepted" earlier, and each stage allows one re-audit before residual findings become accepted trade-offs. Jarvis's repair loop (two repairs, then blocked) has the cap but not the pruning pass. Add one zoom-out pass over the diff after a review-driven repair.

## Do not copy

- `test_scenarios.yaml`: regex assertions with no runner; Jarvis's skill tests have the same weakness (phrases exist in prose) and should not get more of it.
- EGM's drift report: grep-by-LLM with no baseline. Jarvis's `sweep` is already equivalent.
- EGM's three-tier severity as the whole scoring model. Keep Jarvis's confidence rule and runner verdict; add EGM's severity definitions as the reviewer's vocabulary only.
- EGM's prompt-as-program size (22 KB review skill at the host's limit). Jarvis's runner should carry stage order and gating in code, with the persona as the only prompt.

## Where this lands in the architecture
A new stage per `docs/03-architecture.md` §8 (proof + Codex review before it starts). Candidate decisions to record: the design-review stage and its verdict; required alternatives for engineering decisions; the resolve categories; the cleared-list requirement. Related backlog: 119 (review tier), 127 and 133 (design reviewer unwired), 160 (security reviewer).
