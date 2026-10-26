# Mutation hygiene, stages 0-1 (decision 115): Codex review 2

Reviewer: Codex gpt-6-astra, effort high, read-only. Branch worktree-agent-a074ac5c18aa1c42a; round 1 range 927131c..9dc1d73, round 2 9dc1d73..732834f. Oct 25, 2026.

PASS

Round 1 finding: **RESOLVED** — `scripts/mutation-classify.mjs:27–31` removes the suffix shortcut. Rewritten promise-chain failures require a matching SHA-256 record naming `AssertionError`. Regression coverage includes the reported TypeError suffix and genuine assertion failures.

New critical/high findings: **None**.

The main merge leaves the classifier, reporter, gate seam, and sandbox implementation unchanged. Both gate phases still default to `runSandboxed`; the policy test delegates to the real sandbox without widening its policy.

Validation: inspected the installed Vitest implementation and passed 15 in-memory reporter/classifier cases, including conflicting error names. Full Vitest and mutation runs were not executed because they write files. No files were changed.
