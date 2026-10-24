import { setTimeout as delay } from "node:timers/promises";
import { LedgerTamperError } from "../ledger/ledger.ts";

export interface Clock {
  now(): number;
  /** Injected sleeps should honor abort so an early answer cancels the deadline timer. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
export interface IntakeWaitOptions {
  clock?: Clock;
  timeoutMs?: number;
  pollMs?: number;
}
export type IntakeResult<T> = { status: "answers"; answers: T[] } | { status: "defaults (unconfirmed)" };

/** Intake/spec confirmation only: never use a timeout to approve a broker hard stop. readAnswers
 * supplies counted answers for this intake; ignore unrelated replies and process steer separately.
 * A missed notification or stalled reader cannot extend the deadline (decisions 10, 50).
 * Transport errors count as no answer; ledger tampering always propagates. */
export async function waitForIntake<T>(readAnswers: () => Promise<T[]>, options: IntakeWaitOptions = {}): Promise<IntakeResult<T>> {
  const clock = options.clock ?? { now: () => performance.now(), sleep: (ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal }) };
  const timeout = options.timeoutMs ?? 900_000;
  const interval = options.pollMs ?? 5000;
  if (!Number.isSafeInteger(timeout) || timeout < 0 || !Number.isSafeInteger(interval) || interval <= 0) throw new Error("invalid intake timeout or poll interval");
  const fallback = { status: "defaults (unconfirmed)" as const };
  if (timeout === 0) return fallback;
  const deadline = clock.now() + timeout;
  const stop = new AbortController();
  const expired = clock.sleep(timeout, stop.signal).then(() => fallback);
  const poll = async (): Promise<IntakeResult<T>> => {
    while (!stop.signal.aborted && clock.now() < deadline) {
      let answers: T[];
      try { answers = await readAnswers(); } catch (error) {
        if (error instanceof LedgerTamperError) throw error;
        answers = [];
      }
      if (stop.signal.aborted || clock.now() >= deadline) break;
      if (answers.length > 0) return { status: "answers", answers };
      await clock.sleep(Math.min(interval, deadline - clock.now()), stop.signal);
    }
    return fallback;
  };
  try {
    return await Promise.race([poll(), expired]);
  } finally {
    stop.abort();
  }
}
