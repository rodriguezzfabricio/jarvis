# Desktop plugin compatibility check (decision 80)

Run `node scripts/desktop-plugin-check.mjs prepare` from the Jarvis checkout.
The script prints a unique project folder and a prompt file. Preparation writes no
Claude app settings, project hooks, credentials, or approval records.

1. The operator runs `node scripts/desktop-plugin-check.mjs cli --run <printed-run>`
   in an integrator-approved quiet slot. It runs a fresh live canary before the pinned
   CLI, using the existing restricted harness, clean environment, Haiku full model ID,
   no session persistence, no network allowlist, and generated validated settings.
2. Open the printed folder in a **new desktop Code chat** with the local Jarvis plugin
   enabled from the Jarvis repository's marketplace. Use the app's normal permission
   mode; never select bypass permissions. Enabling the plugin is Fabricio's app action.
3. Paste the contents of the printed `PROMPT.txt`. It asks for exactly one harmless
   Bash command: `printf '%s\n' 'npm publish'`. The tripwire should reject the literal
   publish text. If the hook is absent, this command only prints text.
4. Run `node scripts/desktop-plugin-check.mjs verify --run <printed-run> --transcript <file>`.
   The transcript must be a framework-created `.jsonl` in the printed workspace's
   `~/.claude/projects/<slug>/` directory. Verification is read-only and returns JSON;
   exit 0 means both channels passed, exit 1 means incomplete or failed evidence.

The desktop app may bundle a different Claude Code version. The output records it;
only the CLI version is pinned. This check proves plugin compatibility, **not** the
restricted task-session security envelope or completion of a stage. Stage review
remains independent. A screenshot or a model's assertion is not evidence.

The parser requires an actual SessionStart success record containing the exact
Jarvis receipt and a tool-result denial linked to the exact Bash command. Desktop
records must match the new workspace, start time, session, SDK entrypoint (`sdk-cli`), and plugin hook path. Terminal entrypoint `cli` is rejected. This metadata distinguishes terminal records; it does not cryptographically attest to the desktop UI versus another SDK host.
CLI records must identify the expected plugin and pinned version, complete successfully,
and accompany a successful canary and process outcome. Hook files are hashed during
preparation; changing them requires a new run. The run folder is runner-owned and
outside the workspace. No automatic verdict file or approval is written.

Historical forbidden-Read attempts are not a compatibility proof: built-in permissions
reject the read before the tripwire runs. The replacement command tests the hook
without weakening permissions. CLI inline plugins report `jarvis@inline`; the desktop
marketplace plugin reports `jarvis@jarvis`. A plugin installed at a different cached
path may fail this conservative check; inspect the actual framework record before
changing the parser. Do not substitute model-generated evidence.

Each CLI capture is single-use, with a start marker reserved before its canary.
After interruption or failure, prepare a new run instead of overwriting evidence.
The verifier trusts runner-owned files and the framework transcript location; it is
not an attestation against a malicious host user. Transcript reads are capped at 16 MiB.
