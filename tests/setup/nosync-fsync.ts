// Decision 154: in the gate's test workers, fsyncSync and fdatasyncSync keep native's checks and results and skip
// only the device flush (libuv's F_FULLFSYNC on macOS, about 9 ms a call). Nothing else changes: not product code,
// not the processes tests start, not the live canary, `jarvis doctor` or real runs.

/** Where a replacement keeps the function it replaced, so a second install starts from it and tests can reach it. */
export const NATIVE = Symbol.for("jarvis.nosync.native");

type Sync = (fd: number) => void;
type Stat = { isFile(): boolean; isDirectory(): boolean };
type Replacement = Sync & { [NATIVE]?: Sync };

// The range native accepts (an int32 that is not negative); anything else is native's to reject.
const isDescriptorNumber = (fd: unknown): fd is number => typeof fd === "number" && Number.isInteger(fd) && fd >= 0 && fd <= 2 ** 31 - 1;

/**
 * `native` without its flush for the one case that has no observable result: an open regular file or folder.
 * Everything else reaches `native` unchanged, so what it returns or throws is native's own: a closed descriptor
 * (EBADF), a pipe or a socket (EINVAL), a string or a negative number (its argument errors).
 */
export function withoutDeviceFlush(native: Sync, fstat: (fd: number) => Stat): Sync {
  const replacement: Replacement = (fd) => {
    if (isDescriptorNumber(fd)) {
      let stat: Stat;
      try {
        stat = fstat(fd);
      } catch {
        return native(fd);
      }
      if (stat.isFile() || stat.isDirectory()) return;
    }
    return native(fd);
  };
  Object.defineProperty(replacement, "name", { value: native.name });
  Object.defineProperty(replacement, NATIVE, { value: native });
  return replacement;
}

/** The part of the fs module this replaces; the real module has these. */
export interface SyncTarget { fsyncSync: Sync; fdatasyncSync: Sync; fstatSync: (fd: number) => Stat }

/** Replaces fsyncSync and fdatasyncSync on `target`, then tells ES module importers (`syncExports` is syncBuiltinESMExports). */
export function installNoSync(target: SyncTarget, syncExports: () => void): void {
  const fstat = target.fstatSync;
  for (const name of ["fsyncSync", "fdatasyncSync"] as const) {
    const current: Replacement = target[name];
    target[name] = withoutDeviceFlush(current[NATIVE] ?? current, fstat);
  }
  syncExports();
}
