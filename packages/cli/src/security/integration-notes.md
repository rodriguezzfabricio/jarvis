# Security review follow-up

Proposed decision-register addition (the lane cannot edit docs/01-decisions.md):

> Scanner subprocess reports use runner-owned temporary files when a tool opens its report path.
> On the lane's managed Mac sandbox, gitleaks 8.28.0 exits with "Report path is not writable"
> for /dev/stdout (operation not permitted). The adapter rewrites that report destination to a
> private temporary file, parses it after the process ends and removes it. Full gitleaks redaction
> is mandatory. This replaces the earlier /dev/stdout invocation assumption.

Coverage note for the integrator's docs:

> Gitleaks dir does not scan Git history. Its default configuration allowlists node_modules/.
> A pass covers the candidate's scanned current-tree files; it does not prove historical commits
> or vendored dependency directories contain no secrets. History scanning and dependency-directory
> coverage require separately approved checks and rules. Candidate suppression files are rejected,
> preserved on disk and reported as errors rather than silently removed.
