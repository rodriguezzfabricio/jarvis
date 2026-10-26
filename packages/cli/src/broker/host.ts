import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Ledger } from "../ledger/ledger.ts";
import { Broker } from "./broker.ts";
import { outboxAdapters } from "./outbox.ts";
import { envFileSecrets } from "./secrets.ts";
import { startBrokerServer } from "./server.ts";

/**
 * The broker a project's run hosts (architecture §3.4, §3.6): the project's configured adapters (stage 1:
 * the local outbox) and its owner-only secrets file, the same composition `jarvis broker` runs. The secrets
 * are read here, in the runner, and never reach a session's environment, files or settings.
 */
export function projectBroker(o: { jarvisHome: string; projectDir: string; project: string; ledger: Ledger }): Broker {
  const secretsPath = join(o.jarvisHome, "secrets", `${o.project}.env`);
  return new Broker({
    ledger: o.ledger, project: o.project, adapters: outboxAdapters(join(o.projectDir, "outbox")),
    // A secrets file anyone else can read refuses the broker, and so the run (envFileSecrets).
    secrets: existsSync(secretsPath) ? envFileSecrets(secretsPath) : { get: () => undefined },
  });
}

/** The process a broker is hosted in: `process`, or a stand-in in tests. */
export interface SignalHost {
  readonly pid: number;
  once(event: string, listener: (signal: NodeJS.Signals) => void): unknown;
  removeListener(event: string, listener: (signal: NodeJS.Signals) => void): unknown;
  kill(pid: number, signal: NodeJS.Signals): unknown;
}
export const HOST_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export interface HostedBroker {
  /** The bound address: the one task sessions are given (decision 78). */
  socketPath: string;
  /** The public alias, for clients on the host. */
  alias: string;
  /** Executions a dead broker left behind, marked unknown before listening (decision 41). */
  reconciled: number;
  /** Stops listening and removes both names. Idempotent. */
  close(): Promise<void>;
}

/**
 * Hosts the broker for one run. Its names are removed when the run closes it, and also on exit (an
 * uncaught exception or a process.exit included) and on SIGINT, SIGTERM and SIGHUP, which are then re-raised
 * so the runner still stops as it would have. Removal is synchronous: startBrokerServer's close unlinks the
 * alias and closes the listener, which unlinks the bound address, before it returns. SIGKILL leaves the
 * names behind; they answer nobody, and every run binds names of its own.
 */
export async function hostBroker(broker: Broker, alias: string, host: SignalHost = process): Promise<HostedBroker> {
  const reconciled = broker.reconcile();
  const server = await startBrokerServer(broker, alias);
  const teardown = () => server.close();
  const onExit = () => { teardown().catch(() => {}); };
  const onSignal = (signal: NodeJS.Signals) => {
    detach();
    teardown().catch(() => {});
    host.kill(host.pid, signal); // with no listener left, the default action ends the runner
  };
  function detach() {
    host.removeListener("exit", onExit);
    for (const s of HOST_SIGNALS) host.removeListener(s, onSignal);
  }
  host.once("exit", onExit);
  for (const s of HOST_SIGNALS) host.once(s, onSignal);
  return { socketPath: server.socketPath, alias, reconciled, close: async () => { detach(); await teardown(); } };
}
