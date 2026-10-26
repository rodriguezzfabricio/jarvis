import { unpackZip, type ZipLimits } from "./zip.ts";

/**
 * The toolchain unpack in a process of its own (decision 123): the runner starts it with no inherited environment
 * and a capped heap, and kills it at the deadline (go.ts). Arguments: <zip> <dest> <within> <sha256> <limits JSON>.
 * Prints one JSON line, {ok: true, files, bytes} or {ok: false, error}; exits 0 only on success.
 */
const [zip, dest, within, sha256, limits] = process.argv.slice(2);
try {
  if (!zip || !dest || !within || !sha256 || !limits) throw new Error("refused: the toolchain unpack was started without its arguments");
  const r = unpackZip(zip, dest, within, sha256, JSON.parse(limits) as ZipLimits);
  process.stdout.write(`${JSON.stringify({ ok: true, ...r })}\n`);
} catch (e) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) })}\n`);
  process.exitCode = 2;
}
