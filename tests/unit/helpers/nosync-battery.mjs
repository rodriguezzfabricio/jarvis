// Decision 154's battery: calls fsyncSync and fdatasyncSync on every kind of descriptor and argument the
// replacement must treat like native, and records what each call returned or threw. tests/unit/setup-nosync.test.ts
// runs it three times (a child without the setup file = native, a child with it, and the test worker) and compares.
// As a script: node nosync-battery.mjs <scratch folder> <result file>. Run under `true | node ... 2>&1 | cat`, the
// child's own stdin is an anonymous pipe, the one descriptor kind a Node process can't make for itself.
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** What a call did, as plain JSON: the return value, or the error's class, code, errno, syscall and message (never its stack). */
function outcome(call) {
  try {
    return { returned: String(call()) };
  } catch (error) {
    return { threw: { ctor: error?.constructor?.name, code: error?.code, errno: error?.errno, syscall: error?.syscall, message: String(error?.message) } };
  }
}

function kindOf(fd) {
  try {
    const stat = fstatSync(fd);
    return stat.isFile() ? "file" : stat.isDirectory() ? "directory" : stat.isFIFO() ? "fifo" : stat.isSocket() ? "socket" : stat.isCharacterDevice() ? "character device" : "other";
  } catch (error) {
    return `no descriptor (${error?.code})`;
  }
}

/** The case names, in the order they run. "pipe" only exists when `inheritedPipe` is true. */
export const CASE_NAMES = [
  "file", "file opened read-only", "folder", "named pipe", "pipe", "socket", "/dev/null", "closed descriptor",
  "string", "-1", "1.5", "NaN", "2**31", "undefined", "null", "bigint", "object",
];

/**
 * @param {{ fsyncSync: (fd: any) => void, fdatasyncSync: (fd: any) => void }} fns the functions under test
 * @param {string} dir a scratch folder this call may fill (it is emptied at the end)
 * @param {{ inheritedPipe: boolean }} options true if this process's fd 0 is an anonymous pipe
 */
export async function runBattery(fns, dir, { inheritedPipe }) {
  const filePath = join(dir, "file");
  writeFileSync(filePath, "x");
  const folder = join(dir, "folder");
  mkdirSync(folder);
  const fifoPath = join(dir, "fifo");
  execFileSync("/usr/bin/mkfifo", [fifoPath]);
  // A listening TCP socket: a unix socket's path can pass the 104 characters macOS allows under a long temp folder.
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const open = [];
  const hold = (path, flags) => { const fd = openSync(path, flags); open.push(fd); return fd; };
  const fds = {
    file: hold(filePath, "r+"),
    "file opened read-only": hold(filePath, "r"),
    folder: hold(folder, "r"),
    "named pipe": hold(fifoPath, constants.O_RDONLY | constants.O_NONBLOCK),
    socket: server._handle.fd,
    "/dev/null": hold("/dev/null", "r+"),
  };
  // A closed descriptor is made at the call, so no later open can have taken its number.
  const closed = () => { const fd = openSync(filePath, "r"); closeSync(fd); return fd; };
  const args = {
    ...fds,
    ...(inheritedPipe ? { pipe: 0 } : {}),
    "closed descriptor": closed,
    string: "3", "-1": -1, "1.5": 1.5, NaN: Number.NaN, "2**31": 2 ** 31, undefined: undefined, null: null, bigint: 3n, object: {},
  };
  const result = { source: {}, kinds: {}, outcomes: { fsyncSync: {}, fdatasyncSync: {} } };
  for (const name of Object.keys(fns)) result.source[name] = String(fns[name]);
  for (const [label, arg] of Object.entries(args)) {
    for (const name of Object.keys(fns)) {
      const fd = typeof arg === "function" ? arg() : arg;
      if (name === "fsyncSync") result.kinds[label] = typeof fd === "number" ? kindOf(fd) : `not a number (${typeof fd})`;
      result.outcomes[name][label] = outcome(() => fns[name](fd));
    }
  }
  for (const fd of open) closeSync(fd);
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
  return JSON.parse(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The ES module imports are what product code uses: a replacement that only reached require("node:fs") shows here.
  const { fsyncSync, fdatasyncSync } = await import("node:fs");
  const [dir, resultFile] = process.argv.slice(2);
  const result = await runBattery({ fsyncSync, fdatasyncSync }, dir, { inheritedPipe: true });
  writeFileSync(resultFile, JSON.stringify(result));
}
