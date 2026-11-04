# Elephant–Goldfish in Jarvis

Plugin 0.1.2 integrates Google's Elephant–Goldfish Model into spec-based planning. Start a fresh Claude Code session and use `/jarvis feature: <request>` or `/jarvis build: <request>`. The spec skill invokes the bundled `egm-review` automatically before confirmation. [Decision 203](01-decisions.md#203-complete-egms-spec-to-plan-integration-with-an-isolated-comprehension-pass-nov-3-2026).

## Where it runs

| Point in the workflow | Role and input | Result |
|---|---|---|
| Research, intake and drafting | The author retains project context, EGM's Elephant role | A versioned Jarvis spec |
| Before spec confirmation | Fresh `jarvis:egm-comprehension`, Sonnet, reads the spec alone | Two paraphrases and comprehension gaps |
| Same spec review pass | Fresh `jarvis:spec-reader`, Opus, reads the spec and permitted references | Requirements, contradictions and testability findings |
| After spec confirmation and architecture | Existing calibrated `jarvis plan review` sessions apply zoom-out, critic and readiness lenses | Runner-recorded findings and counted plan review |
| Before local execution | Existing checks and plan-review gate | The reviewed plan can enter the build loop |

The two spec readers share one pass of the spec skill's existing three-pass budget. The author resolves findings through the existing fix, contest, escalate and nit-decline actions. Product questions join the normal confirmation. Incomplete reviews stop confirmation and handoff. Each report retains both paraphrases, reviewer completion statuses, input hashes and exclusions at `docs/intake/egm-vN-pass-P.md`.

Bug fixes, refactors, questions and unattended build workers retain their own pipelines. For manual spec inspection, invoke the installed `egm-review` skill with a spec path and pass number. It returns findings to the author. A review report has no authority to confirm a spec or start a build.

## Adaptation and boundaries

This integrates the missing comprehension step with Jarvis's existing EGM-derived architecture review (decisions 170–172). Jarvis uses its own spec grammar, single confirmation, bounded review loops, protected checks and calibrated plan gate. Upstream's full interactive five-stage workflow is adapted to these existing components. The skill and role ship inside Jarvis, so no separate EGM installation or runtime download is required. [Pinned upstream and modifications](../skills/egm-review/references/upstream.md), [Apache-2.0 license](../skills/egm-review/LICENSE).

The interactive comprehension role has only Read and is instructed to read only the supplied spec. The critic has its existing read-only tools and allowed input list. Input isolation and report hashes are skill-level instructions, not a runner-enforced filesystem jail or completion gate. The runner's independent plan review and build gates retain their existing enforcement. Reports are stored under the author-only intake directory, which the plan-review checkout removes.

## Verification on November 3, 2026

The integration tests first failed for the absent dispatch, role and installed files. After implementation, 120 focused tests across nine files passed, including real plugin materialization, build-plugin exclusion, skill contracts and existing workflow mutation checks. Typecheck passed.

The real pinned Claude Code passed its live safety canary before two fresh Sonnet comprehension sessions using the new role text. The coherent fixture returned both paraphrases, three nits and no blockers or majors. A second fixture added mutually exclusive requirements for the same successful write. The reviewer identified the contradiction as a Blocker. Both sessions completed successfully. Private receipts are under `~/.jarvis/egm-verification/1793753182523/`.

The live role test uses Jarvis's sandboxed reviewer adapter, whose read-only tool list is broader than the interactive role's Read-only list. Transcript inspection confirmed each session made exactly one Read call, targeting only its supplied spec. This verifies role behavior on two fixtures. It does not establish a complete interactive `/jarvis` conversation or prove that every future agent follows the dispatch contract. The three new skill eval scenarios are specifications for future workflow evaluation, not executed model evals.

The local user plugin was updated from 0.1.1 to 0.1.2 through the pinned CLI, and the runner-owned plugin was refreshed through `installPlugin`. SHA-256 comparisons matched seven relevant files in both installed locations against the checkout. Existing Claude Code sessions need a restart to load the new skill and role.
