# Stage 2 proof, round 2: summary (decision 105)

Oct 26, 2026. A Claude stand-in played Fabricio through the real `/jarvis` flow (pinned Claude Code 2.1.309, `claude-opus-5-5`) on fresh snapshots of golden tasks 1 and 11, after the stage 2 fixes merge (decisions 119–121). Two independent judges rated each run; the full verdicts are in the private evaluation repository.

| Task | Claude `claude-opus-5-5` judge | Codex `gpt-6-astra` judge |
|---|---|---|
| 1, intake for the recruiter finder | PASS (questions 4/5, 2 vetoes) | FAIL (questions 3/5, 6 vetoes) |
| 11, intake and mockups for a habit tracker | PASS (intake 4/5, mockups 4/5, 2 vetoes) | FAIL (intake 3/5, mockups 4/5, 4 vetoes) |

**Not counted.** The round is void as a proof, whatever the split:
- The plugin's `skills/` is the repo's `skills/` (a symlink), so each skill's `evals/evals.json`, which states golden task 1's expected outputs, was readable from the session, and two skill texts still used task 1's expected answers as examples (backlog 126; decision 121 had removed others).
- Research used live web through the quarantined researcher. Decision 70 says evals use recorded research fixtures, which were due with stage 2 and don't exist yet.

**What both judges agreed on:** the three mockup directions really differ in layout and flow (4/5 from both); no outreach was sent and nothing was bought. Common criticism: questions the session should have decided itself (source order, retention, idempotency and a do-not-contact list), intake for a new product that never asked about the person's own current habits, a release-permission question during intake, and a run length out of proportion to the request.

Next: round 3 after the contamination is removed, recorded research fixtures exist, and the general intake gaps above are fixed.
