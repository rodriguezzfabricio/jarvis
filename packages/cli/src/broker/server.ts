import { chmodSync, existsSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import type { Broker, BrokerResponse } from "./broker.ts";

/** The broker's Unix socket (owner-only). One newline-terminated JSON request per connection. */
export async function startBrokerServer(broker: Broker, socketPath: string): Promise<{ close: () => Promise<void> }> {
  if (existsSync(socketPath)) rmSync(socketPath);
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
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(socketPath, () => res());
  });
  chmodSync(socketPath, 0o600);
  return {
    close: () =>
      new Promise<void>((res) => {
        server.close(() => res());
        if (existsSync(socketPath)) rmSync(socketPath, { force: true });
      }),
  };
}
