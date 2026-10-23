import { connect } from "node:net";
import type { BrokerRequest, BrokerResponse } from "./broker.ts";

/** `jarvis act`: the thin client a task session uses. It holds no credentials. */
export function requestBroker(socketPath: string, req: BrokerRequest, timeoutMs = 60_000): Promise<BrokerResponse> {
  return new Promise((resolve, reject) => {
    const s = connect(socketPath);
    let buf = "";
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error("broker did not answer in time"));
    }, timeoutMs);
    s.setEncoding("utf8");
    s.on("connect", () => s.write(`${JSON.stringify(req)}\n`));
    s.on("data", (d: string) => (buf += d));
    s.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buf.trim()) as BrokerResponse);
      } catch {
        reject(new Error(`unreadable broker answer: ${buf.slice(0, 200)}`));
      }
    });
    s.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** Exit codes for `jarvis act`, so scripts and agents can branch without parsing text. */
export const ACT_EXIT: Record<BrokerResponse["status"], number> = {
  succeeded: 0, pending: 2, rejected: 3, failed: 4, unknown: 5, duplicate: 6, invalid: 7, error: 8,
};
