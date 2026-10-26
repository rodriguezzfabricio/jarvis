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

Check one primary action per screen, reduced-motion behavior, and WCAG 2.2 AA. Run axe-core and require zero serious or critical issues. Accessibility automation supplements keyboard and focus interaction checks. Verify the first-value budget from the spec without hiding information someone needs to decide: a deletion approval still shows the affected files, source and recovery options.

## Use the real target

- **Web:** run the project's Playwright tests with the runner-owned Playwright toolchain from the approved check definition, plus its pinned axe accessibility pass against the running local app. Never load Playwright or axe-core from candidate `node_modules`. Capture the accessibility tree, final page URL and screenshots at 375, 768 and 1440 px, and compare screenshot baselines on the same machine. If the approved toolchain or running target is absent, report **not run**; do not download a replacement or call that a pass.
- **iOS:** use Maestro flows against the built app on the selected iOS simulator. The runner gets Maestro's absolute binary path from pins or doctor (`/Users/fabriciorodriguez/.maestro/bin/maestro` on Fabricio's machine). Expo web screenshots don't prove native behavior. If only web was tested, report **web-only**; otherwise report **not run** with the missing prerequisite.
- **Desktop:** install a reviewed `DesktopPlan` with the project's build command and bundle path through `installDesktopChecks`, then approve it through the existing checks store. The case sandbox runs only the build, with offline package-manager settings; downloads report **not run: desktop build needs network**. Never enable Apple Events in a case sandbox. The build check passes only if the build exits 0 and leaves the plan's `.app` bundle in the checkout. The built app is candidate code, so it is launched only by a sandboxed native launcher (decision 102). None exists yet, so native coverage is **not run: desktop (no sandboxed native launcher)**, and nothing ever launches the app on the runner directly. When one exists: the runner copies the stopped build output before checkout cleanup, and only after the build gate passes does it launch the copy, require survival for the protected duration, check its PID's status item, and request a clean quit of that PID. Native probes use fixed osascript programs with a numeric PID argument; candidate scripts and argv are never accepted. Missing artifact handoff, launcher or Tauri means **not run: desktop**. Existing Accessibility permissions are required; QA never grants them or installs tools. Exercise the offline API with a local stub as a separate acceptance case. A browser test of the web UI is **web-only** until native checks pass. Report golden task 12 as **built, not distributed**.

Use local stub services and synthetic data for emails, approvals and paid operations. QA does not authorize real sends, purchases or production changes.

Run token lint, DESIGN.md lint, the deterministic AI-tells and copy scans, and the installed Impeccable detector on changed source and the running URL. Token lint reports raw colors, off-scale dimensions and undeclared fonts at file:line. Leave subjective layout, originality, hierarchy and context-dependent tells to the independent design reviewer. The generic negative control in the golden tasks must fail before that reviewer's verdicts count.

## Evidence belongs to the runner

During a task session, test results and screenshots are feedback and claims. **Only the runner's protected checks after the session ends count as evidence** (decisions 49 and 76). The runner checks the committed candidate on a fresh checkout, captures raw observations outside candidate write access, and runs assertions separately with no candidate code. Check definitions and their approved lock remain runner-owned. Do not edit a protected check to make a failure disappear.

Hand the runner the relevant check IDs and target scope. `runLaneChecks` delegates approved definitions to the existing `runGate`; absent definitions are **not run**. `runPlaywright` and `runMaestro` produce unverified observations, never a gate pass. Do not convert exit 0, candidate-written reports, pasted terminal output or agent narrative into evidence.

The toolchain, driver and manifest live in protected check fixtures and are covered by the existing `ChecksStore` approval. Checks and installed toolchains remain symlink-free. `installChromiumBundle` materializes a local Chromium `.app` by dereferencing contained source aliases into real files, refuses escaping, cyclic and dangling sources, records the complete bundle file list and hashes, and smoke launches it once before updating the manifest. A failed launch does not install or approve it. Reapprove the resulting protected files through the existing reviewed path.

Browser observations independently reconcile Playwright's `page.frames()`, CDP renderer frame trees and iframe targets. Out-of-process frames get their own CDP session and isolated axe world, with iframe messaging disabled. Every frame is tested. URL and loader identity must remain unchanged across the run; a frame still at `about:blank` with a `src` fails. Each observation records the frame count, IDs, document URLs, loader IDs and per-frame axe results. The isolated verifier requires complete coverage and approved axe versions. Inaccessible frames, differing frame sets, document changes and missing isolated worlds fail without a fallback to page globals.

Native evidence is made only by the runner: it records the build gate reference, hashes the materialized artifact manifest and native observation, and appends a separate `native-smoke` result tied to the revision. A build gate alone never counts as native coverage.

Report the candidate revision, runner gate/evidence references, tested targets and states, findings with file:line, and any missing coverage. Missing tools, missing native targets, tampered checks, timeouts and truncated output cannot support a done claim. Keep unverified observations labeled as such.
