// Compatibility for snapshot-case-worker.mjs, whose caller still passes the old context.
// Decision 137: never replace Node's process APIs or emulate PATH and shim environment semantics.
export function useRealGit(_realGit: string, _shimEnv: Record<string, string> = {}): void {}
