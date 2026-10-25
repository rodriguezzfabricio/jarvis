# Initial publication check

October 25, 2026. This is a record of preparation for the first public repository, not a security certification or a completed v1 stage proof.

## Secret scan

Gitleaks 8.28.0 scanned the local Git history with `--log-opts='--all'`, inline allow comments ignored, decode depth 3, archive depth 2, and redacted reporting. The scan returned exit 1 with 146 findings across 19 test and review-report paths. A nonzero result was reviewed rather than described as a clean automatic scan.

The flagged historical lines were inspected. They contain synthetic scanner inputs, test-only sentinel values, dummy key material, a generated test-key reproduction and a synthetic JWT. Review reports repeat those test payloads. No live account credential was identified among the reported findings. Existing tests and history were preserved, and no global scanner allowlist was added to hide the findings.

The personal evaluation repository and local Jarvis runtime folders are not part of this Git repository. The tracked file list was checked for environment files, credential files and nested repositories. Scan results do not prove the absence of every possible secret.

## Documentation checks

Local Markdown link targets resolve. The CLI help runs on Node 24.21.0, and `scripts/install.sh --dry-run` completes with the installed pinned binaries. The dry run does not establish a clean-machine installation.

The README labels the project experimental and distinguishes implemented components from unfinished proofs. The evaluation page records the passing smoke run and a subsequent failed hidden evaluation, unequal compute budgets, and the private benchmark’s reproducibility limit. The existing MIT license and adapted-skill credits remain included.
