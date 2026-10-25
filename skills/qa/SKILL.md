---
name: qa
description: Test changed UI flows on their real target, using the accessibility tree, state coverage, design checks and runner evidence. Use for web, iOS or desktop UI changes; backend-only changes use their protected checks without a UI workflow.
---

# QA

Scope the checks to what changed (architecture §2). A misaligned button gets checks on its screen; a Go handler gets tests, API and security checks. Use the standards selections from `packages/cli/src/lanes/selection.ts`; repository dependencies alone don't justify testing unrelated screens. Do not start design directions or mockups for a bug fix.

Read the acceptance criteria, the first-value click budget, `DESIGN.md` and the changed flow. Follow the inherited design system. The AI-tells bans apply to new UI; an exception must cite the brief under DESIGN.md's Do's and Don'ts. A source comment cannot waive a check.

## Test the behavior

Read the accessibility tree before interacting or judging screenshots. Use roles and accessible names to find controls. Exercise the real flow, including the primary action and its result; a screenshot does not prove an interaction works.

For the changed flow, cover:

| State | What to check |
|---|---|
| Empty | Useful context and the action that creates first value, without a launch tour |
| Loading | Progress for work longer than about 400 ms; prevent duplicate actions |
| Error | Field-local explanation and recovery; retain entered values; no apologetic validation |
| Stale data / offline | Show freshness, preserve work, and explain retry or reconciliation |
| Keyboard only | Logical order, visible focus, no trap, reachable primary and secondary actions |

Check one primary action per screen, reduced-motion behavior, and WCAG 2.2 AA. Run axe-core and require zero serious or critical issues. Accessibility automation supplements keyboard and focus interaction checks. Verify the first-value budget from the spec without hiding information someone needs to decide: an outreach approval still shows the recipient, provenance and exact message.

## Use the real target

- **Web:** run the project's Playwright tests with the runner-owned Playwright toolchain from the approved check definition, plus its pinned axe accessibility pass against the running local app. Never load Playwright or axe-core from candidate `node_modules`. Capture the accessibility tree, final page URL and screenshots at 375, 768 and 1440 px, and compare screenshot baselines on the same machine. If the approved toolchain or running target is absent, report **not run**; do not download a replacement or call that a pass.
- **iOS:** use Maestro flows against the built app on the selected iOS simulator. The runner gets Maestro's absolute binary path from pins or doctor (`/Users/fabriciorodriguez/.maestro/bin/maestro` on Fabricio's machine). Expo web screenshots don't prove native behavior. If only web was tested, report **web-only**; otherwise report **not run** with the missing prerequisite.
- **Desktop:** require a native smoke test on the built Tauri app, including an offline API. A browser test of its web UI is **web-only** until that native check runs.

Use local stub services and synthetic data for emails, approvals and paid operations. QA does not authorize real sends, purchases or production changes.

Run token lint, DESIGN.md lint, the deterministic AI-tells and copy scans, and the installed Impeccable detector on changed source and the running URL. Token lint reports raw colors, off-scale dimensions and undeclared fonts at file:line. Leave subjective layout, originality, hierarchy and context-dependent tells to the independent design reviewer. The generic negative control in the golden tasks must fail before that reviewer's verdicts count.

## Evidence belongs to the runner

During a task session, test results and screenshots are feedback and claims. **Only the runner's protected checks after the session ends count as evidence** (decisions 49 and 76). The runner checks the committed candidate on a fresh checkout, captures raw observations outside candidate write access, and runs assertions separately with no candidate code. Check definitions and their approved lock remain runner-owned. Do not edit a protected check to make a failure disappear.

Hand the runner the relevant check IDs and target scope. `runLaneChecks` delegates approved definitions to the existing `runGate`; absent definitions are **not run**. `runPlaywright` and `runMaestro` produce unverified observations, never a gate pass. Do not convert exit 0, candidate-written reports, pasted terminal output or agent narrative into evidence.

The toolchain, driver and manifest live in protected check fixtures and are covered by the existing `ChecksStore` approval. The manifest pins package versions and hashes every tool file. The case command carries its approved manifest digest; the browser driver rechecks the digest and tool files before loading absolute entries. Axe runs in a Chromium CDP isolated world; the verifier compares its version with the approved pin and rejects redirects to a different page. An unavailable isolated world is an error, never a fallback to page globals.

Report the candidate revision, runner gate/evidence references, tested targets and states, findings with file:line, and any missing coverage. Missing tools, missing native targets, tampered checks, timeouts and truncated output cannot support a done claim. Keep unverified observations labeled as such.
