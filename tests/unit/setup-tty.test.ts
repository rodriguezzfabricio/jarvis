import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { InterruptedError, streamTty } from "../../packages/cli/src/setup/tty.ts";

function terminal(isTTY = true) {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  const modes: boolean[] = [];
  if (isTTY) { input.isTTY = true; input.setRawMode = vi.fn((mode: boolean) => { modes.push(mode); return input; }); }
  let written = "";
  const output = { write: (text: string) => { written += text; return true; } };
  return { input, output, modes, written: () => written, tty: streamTty(input, output) };
}

it("reads a hidden token in raw mode, never echoes it, and restores the terminal", async () => {
  const t = terminal();
  const answer = t.tty.askHidden("GitHub token: ");
  setImmediate(() => { t.input.write("ghp_SENTI"); t.input.write("NELx\u007fTOKEN\r"); });
  expect(await answer).toBe("ghp_SENTINELTOKEN");
  expect(t.written()).toBe("GitHub token: \n");
  expect(t.modes).toEqual([true, false]);
  t.tty.close();
});

it("treats Ctrl-C and Ctrl-D in a hidden prompt as an interruption and still restores the terminal", async () => {
  for (const key of ["\u0003", "\u0004"]) {
    const t = terminal();
    const answer = t.tty.askHidden("Token: ");
    setImmediate(() => t.input.write(`abc${key === "\u0004" ? "\u007f\u007f\u007f" : ""}${key}`));
    await expect(answer).rejects.toBeInstanceOf(InterruptedError);
    expect(t.modes).toEqual([true, false]);
    expect(t.written()).not.toContain("abc");
    t.tty.close();
  }
});

it("refuses to read a token from anything but a terminal", async () => {
  const t = terminal(false);
  setImmediate(() => t.input.write("piped-token-value\n"));
  await expect(t.tty.askHidden("Token: ")).rejects.toThrow(/terminal/i);
  expect(t.written()).not.toContain("piped-token-value");
  t.tty.close();
});

it("reads ordinary answers line by line, keeping input typed ahead", async () => {
  const t = terminal();
  setImmediate(() => t.input.write("yes\r\nvercel\n"));
  expect(await t.tty.ask("Store it? ")).toBe("yes");
  expect(await t.tty.ask("Which? ")).toBe("vercel");
  expect(t.written()).toBe("Store it? Which? ");
  expect(t.modes).toEqual([]);
  t.input.end();
  await expect(t.tty.ask("More? ")).rejects.toBeInstanceOf(InterruptedError);
  t.tty.close();
});
