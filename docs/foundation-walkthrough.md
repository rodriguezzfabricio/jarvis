# Run the foundation example

From a Jarvis checkout with Node 24 and dependencies installed:

```sh
node scripts/foundation-smoke.mjs
```

Expected duration: under 10 seconds on the development Mac. Five `PASS` lines demonstrate this local sequence:

1. The `jarvis act` CLI entry point reaches a Unix-socket broker and exits **2**, pending approval. The outbox stays empty.
2. Approving the original request does not approve a changed payload: it still exits **2**.
3. The exact approved payload exits **0**, creates one local outbox file, and records a success receipt.
4. Retrying exits **6**, duplicate. The outbox still has one file and the ledger verifies.
5. Changing valid data in the disposable ledger produces a hash mismatch. An approved, unexecuted request exits **8** with a ledger-verification error and creates no additional file.

The example constructs the broker with local outbox adapters and no secrets. It simulates approval through the broker API; it does not exercise the `jarvis approve` command or ask a person to approve an external action. It sends no email, starts no model, and uses a new private temporary directory on every run. Successful runs remove that directory; failures retain it and print its path.

This is an integration example for the current foundation. It does not prove sandbox isolation, crash recovery, concurrent execution, real delivery, or stage completion. Those remain covered by the independent review, unit/fault suites, live safety tests, mutation check, and stage evidence.
