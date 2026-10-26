# Suite-speed Codex review 3 — FAIL

same-family review; Claude cross-review pending

Reviewed head: f024b8e5e50f6a44227951d0eb8ab87e91388470. Both independent reviewers returned FAIL. Their raw reports are retained in the adjacent Astra and Sol files.

Two fresh-clone full suites failed the native execFileSync probe at its 10-second child deadline. A separate fresh-clone experiment also demonstrated that the helper could turn child ETIMEDOUT into an assertion the mutation classifier called caught, with product code unchanged. Targeted green results did not establish full-suite reliability.

The integrator uniformly selected one of seven relied-on commands for V8: Astra's required install/typecheck/full-suite command. Its fresh-clone repeat exited 1 with exactly the original counts: one failed, 3,634 passed and 16 skipped tests; one failed, 237 passed and nine skipped files. This reproduces the reported failure, not acceptance.

Original log SHA-256: e9a5d7347e6d394d2af2aebcb37b89d41b0a12ca92d583c60a34788d0b929829.
Repeat: e39ba74d055555a1b173cf834aad56743b8e5991d0e4f9fe6456a4910e708d42.
False-catch control: 26d85cb29e9c82079baa2f10c7e6b234a59563044f5e5e8b8245c759ab5e273c.
Exact commands, timestamps, exits, random selection and counts are retained in the private handoff manifest and comparison artifact.

No confirmed mutation gate completed. The corrected candidate requires fresh independent review and evidence; no main merge was authorized by this review.
