# Stage 2 proof, round 3: summary (decisions 105, 116, 132)

Oct 26–28, 2026. A Claude stand-in played Fabricio through the real `/jarvis` flow (pinned Claude Code 2.1.309, `claude-opus-5-5`) on fresh snapshots of golden tasks 1 and 11, after the round 3 prerequisites merged (decision 132: skill evals out of the plugin, recorded research fixtures, bounded intake). Both runs passed the fixture and read verifiers (decision 132), so the round counts. Two independent judges rated each run blind to each other; the full verdicts are in the private evals repo (`reviews/stage2-run3/`).

| Task | Claude `claude-opus-5-5` judge | Codex `gpt-6-astra` judge |
|---|---|---|
| 1, intake for the recruiter finder | FAIL (questions 4/5, 2 vetoes; two rubric lines missed) | FAIL (questions 2/5) |
| 11, intake and mockups for a habit tracker | PASS (intake 4/5, mockups 4/5, 2 vetoes) | FAIL (intake 3/5, mockups 3/5) |

**Result: the round fails.** Task 1 fails from both judges; task 11 is a split, which decision 105 leaves to Fabricio, but the stage needs both tasks.

**What both judges agreed on.** Research ran before the questions, from recorded fixtures only; nothing was sent, bought or signed up for; every question carried a default with a reason and a trade-off; the three mockup directions differ in layout and flow. The questions themselves were close to the bar (4/5 from the Claude judge on both tasks).

**Where the runs fell short, in the judges' order of seriousness:**
1. **A default that contradicts the request.** Task 1's first default made the feature prepare messages without sending them, because the session read a line that limits what a build may do as a product rule. One "use defaults" tap would have produced the wrong product.
2. **Engineering left undecided or decided against the goal.** No do-not-contact or suppression list for a feature that emails strangers from the owner's account (task 1); a weekday rule that works against the forgiving-streak goal the research supports (task 11).
3. **The umbrella map pulled in a later stage.** Task 1's story map carried the project's existing follow-up into the new feature and left out the approve and get-channel stages.
4. **The spec grew past what one confirmation can carry.** 81 to 92 acceptance criteria, around 45 assumptions and decisions, 13 new unconfirmed assumptions in one confirmation message, three spec-reader passes, 59 to 64 minutes per run.
5. **Drift after the user's "Yes".** The spec and `DESIGN.md` disagree on a token (task 11); design rules were recorded after the confirmation; the accepted mockup changed in several ways the user never saw; `PRODUCT.md` and the research file keep lines the session later reversed.
6. **A default was not re-asked when an answer contradicted it.** Task 11's first answer named forgetting to open the app as the pain, and the reminders default stayed "none in version 1" although the research had found a free path.

**Next: round 4** after the intake, spec and design skills state these as rules (decision 121: rules, not golden-task specifics): a default never narrows the requested outcome, and a build constraint is not a product rule; the umbrella names the stages of the new job only; engineering that protects third parties is decided, not left open; a spec that outgrows one confirmation is cut to the walking skeleton with the rest as later stories; nothing in the spec, `DESIGN.md` or the mockups changes after confirmation without a new confirmation; an accepted default is re-asked once when a later answer contradicts it.
