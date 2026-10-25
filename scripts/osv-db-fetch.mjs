// Explicit OSV database snapshot fetch (network). Run by the runner outside any gate, never inside one:
//   node scripts/osv-db-fetch.mjs /absolute/project /absolute/runner-owned/new-osv-snapshot
// Then install it with pinnedSecurityScanners(<snapshot>) and approve the checks store.
import { osvDbFetchMain } from "../packages/cli/src/security/osv-db-fetch.ts";
await osvDbFetchMain();
