/** The terminal jarvis setup talks to. Tokens come only from askHidden: never argv, env or a pipe (decision 43). */
export interface Tty {
  ask(prompt: string): Promise<string>;
  /** Raw mode, nothing echoed; refuses anything that isn't a terminal. */
  askHidden(prompt: string): Promise<string>;
  close(): void;
}

/** Ctrl-C, Ctrl-D or end of input. Finished steps are already saved, so the next run resumes. */
export class InterruptedError extends Error {
  constructor() { super("Interrupted"); this.name = "InterruptedError"; }
}

type Input = NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };

export function streamTty(input: Input, output: { write(text: string): unknown }): Tty {
  const chunks: string[] = [];
  let ended = false;
  let waiter: ((chunk: string | null) => void) | undefined;
  let pending = "";
  const onData = (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (waiter) { const w = waiter; waiter = undefined; w(text); } else chunks.push(text);
  };
  const onEnd = () => { ended = true; if (waiter) { const w = waiter; waiter = undefined; w(null); } };
  let listening = false;
  const next = (): Promise<string | null> => {
    if (!listening) { listening = true; input.on("data", onData); input.on("end", onEnd); input.resume(); }
    const chunk = chunks.shift();
    if (chunk !== undefined) return Promise.resolve(chunk);
    if (ended) return Promise.resolve(null);
    return new Promise((resolve) => { waiter = resolve; });
  };
  const readLine = async (hidden: boolean): Promise<string> => {
    let line = "";
    for (;;) {
      if (pending === "") {
        const chunk = await next();
        if (chunk === null) throw new InterruptedError();
        pending = chunk;
      }
      while (pending !== "") {
        const ch = pending[0] ?? "";
        pending = pending.slice(1);
        if (ch === "\r" || ch === "\n") {
          if (ch === "\r" && pending.startsWith("\n")) pending = pending.slice(1);
          return line;
        }
        if (hidden) {
          if (ch === "\u0003" || (ch === "\u0004" && line === "")) { pending = ""; throw new InterruptedError(); }
          if (ch === "\u007f" || ch === "\b") { line = line.slice(0, -1); continue; }
        }
        line += ch;
      }
    }
  };
  return {
    async ask(prompt) {
      output.write(prompt);
      return (await readLine(false)).trim();
    },
    async askHidden(prompt) {
      if (input.isTTY !== true || typeof input.setRawMode !== "function") throw new Error("Tokens are read only from an interactive terminal, never from a pipe, argv or the environment");
      const setRaw = input.setRawMode.bind(input);
      setRaw(true);
      try {
        output.write(prompt);
        return await readLine(true);
      } finally {
        setRaw(false);
        output.write("\n");
      }
    },
    close() {
      input.off("data", onData);
      input.off("end", onEnd);
      input.pause();
    },
  };
}
