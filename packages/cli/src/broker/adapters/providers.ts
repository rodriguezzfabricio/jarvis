import type { Provider } from "../../release/types.ts";
import { netlifyCommand, netlifyCurrentCommand, netlifyVersion, readNetlifyCurrent } from "./netlify.ts";
import { readVercelCurrent, vercelCommand, vercelCurrentCommand, vercelVersion } from "./vercel.ts";
import type { ProviderModule } from "./types.ts";

/**
 * The deploy provider registry. The adapters, the execution helpers and doctor reach a provider only through this
 * table, so adding one to `Provider` fails to compile until it has a module here and a deploy tree in
 * release/artifacts.ts (decision 161).
 */
export const PROVIDERS = {
  vercel: { label: "Vercel CLI", command: vercelCommand, currentCommand: vercelCurrentCommand, readCurrent: readVercelCurrent, version: vercelVersion },
  netlify: { label: "Netlify CLI", command: netlifyCommand, currentCommand: netlifyCurrentCommand, readCurrent: readNetlifyCurrent, version: netlifyVersion },
} as const satisfies Record<Provider, ProviderModule>;
export const PROVIDER_NAMES = Object.keys(PROVIDERS) as Provider[];
