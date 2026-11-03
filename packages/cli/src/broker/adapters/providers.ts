import { pinnedProviderBin, PROVIDER_CLI_PINS } from "../../config/pins.ts";
import { renderProvider } from "./render.ts";
import type { Provider } from "../../release/types.ts";
import { netlifyCommand, netlifyCurrentCommand, netlifyVersion, readNetlifyCurrent } from "./netlify.ts";
import { readVercelCurrent, vercelCommand, vercelCurrentCommand, vercelVersion } from "./vercel.ts";
import type { ProviderModule } from "./types.ts";

/**
 * The deploy provider registry. The adapters, the execution helpers and doctor reach a provider only through this
 * table, so adding one to `Provider` fails to compile until it has a module here and a deploy tree in
 * release/artifacts.ts (decision 161).
 */
export const PROVIDERS: Record<Provider, ProviderModule> = {
  vercel: { cli: { bin: home => pinnedProviderBin("vercel", home), pin: () => PROVIDER_CLI_PINS.vercel }, label: "Vercel CLI", command: vercelCommand, currentCommand: vercelCurrentCommand, readCurrent: readVercelCurrent, version: vercelVersion },
  netlify: { cli: { bin: home => pinnedProviderBin("netlify", home), pin: () => PROVIDER_CLI_PINS.netlify }, label: "Netlify CLI", command: netlifyCommand, currentCommand: netlifyCurrentCommand, readCurrent: readNetlifyCurrent, version: netlifyVersion },
  render: renderProvider,
} as const satisfies Record<Provider, ProviderModule>;
export const PROVIDER_NAMES = Object.keys(PROVIDERS) as Provider[];
