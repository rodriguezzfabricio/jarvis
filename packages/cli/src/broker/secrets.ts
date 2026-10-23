import { readFileSync, statSync } from "node:fs";
import type { SecretsBackend } from "./broker.ts";

/**
 * The default secrets backend (decision 13): an env file at ~/.jarvis/secrets/<project>.env, owner-only.
 * Only the broker reads it; task sessions are denied the whole runner folder (decisions 59, 69).
 */
export function envFileSecrets(path: string): SecretsBackend {
  const st = statSync(path);
  if ((st.mode & 0o077) !== 0) throw new Error(`${path} must be readable by its owner only (chmod 600); it is ${(st.mode & 0o777).toString(8)}`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${path} must belong to the current user`);
  const values = new Map<string, string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = (m[2] ?? "").trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    values.set(m[1] ?? "", v);
  }
  return { get: (k) => values.get(k) };
}
