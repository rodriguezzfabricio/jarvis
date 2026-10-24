import { chmodSync, linkSync, lstatSync, rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createServer, type Server } from "node:net";
import type { Broker, BrokerResponse } from "./broker.ts";

/** Each foreground run gets a distinct project-bound address; clients receive this exact path. */
export function brokerSocketPath(project: string, run: string = randomUUID(), home = homedir()): string {
  const key = createHash("sha256").update(JSON.stringify([project, run])).digest("hex").slice(0, 24);
  return join(home, ".jarvis", "run", `${key}.sock`);
}

/** The broker's Unix socket (owner-only). One newline-terminated JSON request per connection. */
export async function startBrokerServer(broker: Broker, socketPath: string): Promise<{ socketPath: string; close: () => Promise<void> }> {
  // libuv unlinks its bound name on close, even if that name was replaced. Bind a private
  // instance name and publish a hard link atomically; never bind the shared public name.
  const parent = dirname(socketPath);
  const room = (process.platform === "darwin" ? 103 : 107) - Buffer.byteLength(parent) - 1;
  if (room < 1 || Buffer.byteLength(socketPath) > (process.platform === "darwin" ? 103 : 107)) {
    throw new Error(`Broker socket path is too long: ${socketPath}; select a shorter --socket path.`);
  }
  let privatePath = "";
  const server: Server = createServer((conn) => {
    let buf = "";
    conn.setEncoding("utf8");
    conn.setTimeout(30_000, () => conn.destroy());
    conn.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > 256 * 1024) {
        conn.end(`${JSON.stringify({ status: "invalid", payloadHash: "", message: "request too large" })}\n`);
        return;
      }
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = "";
      let req: unknown;
      try {
        req = JSON.parse(line);
      } catch {
        conn.end(`${JSON.stringify({ status: "invalid", payloadHash: "", message: "not JSON" })}\n`);
        return;
      }
      broker
        .handle(req as never)
        .then((res: BrokerResponse) => conn.end(`${JSON.stringify(res)}\n`))
        .catch((e: unknown) => conn.end(`${JSON.stringify({ status: "error", payloadHash: "", message: String(e).slice(0, 300) })}\n`));
    });
    conn.on("error", () => {});
  });
  for (let attempt = 0; ; attempt++) {
    if (attempt >= 32) throw new Error(`No free private socket name beside ${socketPath}; select a shorter --socket path.`);
    const random = randomUUID().replaceAll("-", "");
    const name = room >= 40 ? `.b-${random}.sock` : random.slice(0, room);
    privatePath = join(parent, name);
    if (privatePath === socketPath) continue;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(privatePath, () => { server.removeListener("error", onError); resolve(); });
      });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= 31) throw error;
    }
  }
  try {
    chmodSync(privatePath, 0o600);
    // EEXIST is deliberate: neither an active listener nor an unverified stale path is replaced.
    linkSync(privatePath, socketPath);
  } catch (error) {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Broker socket already exists: ${socketPath}. Select a different --socket or start without an explicit path for a new run.`, { cause: error });
    }
    throw error;
  }
  const owned = lstatSync(privatePath);
  let closing: Promise<void> | undefined;
  return {
    // Sandbox allowlists must name the bound address, not its public alias.
    socketPath: privatePath,
    close: () => closing ??= new Promise<void>((resolve, reject) => {
      try {
        const current = lstatSync(socketPath, { throwIfNoEntry: false });
        if (current?.dev === owned.dev && current.ino === owned.ino) rmSync(socketPath);
      } catch (error) {
        server.close(() => reject(error));
        return;
      }
      server.close(() => resolve());
    }),
  };
}
