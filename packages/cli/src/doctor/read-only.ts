import { dirname } from "node:path";
import type { ChecksStore } from "../checks/store.ts";
import { verifyLedger, type Ledger } from "../ledger/ledger.ts";

/** Adapt an already verified snapshot to the store's read-only entries call; never create a Ledger writer. */
export function verifyChecksReadOnly(store: ChecksStore, verify: typeof verifyLedger = verifyLedger): ReturnType<ChecksStore["verify"]> {
  const snapshot = verify(dirname(store.checksDir));
  if (!snapshot.ok) return { ok: false, problems: snapshot.problems, lockHash: undefined };
  const reader = { entries: () => snapshot.entries } as Ledger;
  return store.verify(reader);
}
