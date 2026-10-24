# Foundation integration example — Opus review

October 24, 2026. Base revision: `749bad8`. Supplemental review of the Codex-authored example only; this is not a stage-0/1 approval.

## Reviewer and isolation

- Pinned Claude Code 2.1.309; requested and reported model: `claude-opus-5-5`; requested effort: `high`.
- Both review sessions reported subscription authentication (`apiKeySource: none`). They had only Read, Glob and Grep tools, restricted mode, explicit validated settings, no persistence, no external MCP servers and no web access.
- The live canary passed all 21 checks before review. No production source or existing builder-checkout files were changed.

## Validation performed by Codex

- `node scripts/foundation-smoke.mjs`: all five steps passed after corrections.
- Three independent negative controls in a disposable source copy were each caught by an AssertionError with exit 1: automatic approval, skipped duplicate suppression, skipped entry hash verification. The unmodified copied example passed first.
- `pnpm exec vitest run tests/unit/broker.test.ts tests/unit/ledger.test.ts`: 40 tests passed across 2 files (4.69 seconds).
- `pnpm typecheck`, `node --check scripts/foundation-smoke.mjs` and `git diff --check`: passed. Typecheck covers the CLI TypeScript project, not this JavaScript script. The complete mutation suite and full stage evidence remain with the existing Claude builder.

## First review and corrections

The first review requested changes. All were addressed: tamper valid entry data rather than its kind; use an approved/unexecuted action after tampering; require the ledger-specific error; put broker/ledger setup inside try/finally; compare approval IDs and payload hashes; describe the CLI entry point and an integration demonstration accurately. The second independent session reviewed the corrected files and returned the verdict below.

## Re-review verdict (verbatim)

**PASS**

I read both files and checked them against `broker.ts` and `ledger.ts`. I didn't run the script; this is based on reading the code.

1. **Changes valid data, not the entry kind:** Fixed. Lines 82–85 change `data.summary` in entry 0 and keep the JSON valid. Entry 0 is always the `approval_request` from step 1, because `Ledger.open` writes no starting entry, and its `summary` is a string (`broker.ts:212`). Line 88 checks for `hash mismatch`, which `ledger.ts:147` produces for an edited entry.
2. **Tampering blocks an approved, unexecuted payload:** Fixed. `changedPayload` is approved at line 77 and has no receipt yet, so without the tampering it would run and write a second file. The ledger is confirmed clean at line 78 before the edit, and line 91 confirms the outbox still has one file.
3. **Error message is the ledger-verification one:** Fixed. Line 90 matches the exact text at `broker.ts:183`, which is only returned when a `LedgerTamperError` is caught. An exit 8 from any other cause would fail this check.
4. **Ledger and broker setup inside `try`:** Fixed (lines 43–45). If setup fails, `finally` keeps the temp directory and prints its path, and `server?.close()` is safe when no server started.
5. **Changed approval/hash and success receipt hashes:** Fixed. Lines 55–57 check that the changed payload gets a new approval ID and a different hash. Lines 62–63 check both the success response hash and the receipt hash against the original pending hash. A pass can't come from two missing values matching, because line 57 already requires the hashes to be present and different.
6. **Softer proof wording:** Fixed. Script line 2 and doc line 19 now call this an integration example, not proof, and list what it doesn't cover. Doc line 17 also says approval is simulated through the broker API, not the `jarvis approve` command.

The doc's five steps match the script's checks and exit codes (2, 2, 0, 6, 8). I found no remaining issues that need changes.

## Reviewed content hashes (SHA-256)

```json
{
  "scripts/foundation-smoke.mjs": "9cd0f5152b43f40294d18b080da51ce69172fe0106943bb93d78e7044cdf3f2e",
  "docs/foundation-walkthrough.md": "ff1180503138e9b3aaa91f9bdd699679197d49faecaaabb237bf3c5b1ae232f8",
  "docs/parallel-handoff.md": "e6b80a94f15a019d7a50851c7646fc5fbb5e17df1348aa1d84a8f003068ebe82"
}
```

Raw local session evidence: `/private/tmp/jarvis-opus-foundation-FTDQXY/` (temporary, not required to run the example). This saved report preserves the final verdict and reviewed-file hashes.
