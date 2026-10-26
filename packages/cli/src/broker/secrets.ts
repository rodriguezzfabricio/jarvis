import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, type Stats, type renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { checkAcl, checkTrustedDir, privateDir, readNoFollow, refuseSymlink, writePrivateAtomic, type TrustOptions } from "../config/private-file.ts";
import type { SecretsBackend } from "./broker.ts";

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/**
 * The default secrets backend (decision 13): an env file at ~/.jarvis/secrets/<project>.env, owner-only.
 * Only the broker reads it; task sessions are denied the whole runner folder (decisions 59, 69).
 */
export interface SecretsReadOptions extends TrustOptions {
  open?: (path: string, flags: number) => number;
  fstat?: (fd: number) => Stats;
}

/** ACL checks use the existing absolute /bin/ls adapter on macOS. Other platforms currently check
 * POSIX ownership/mode only unless an ACL reader is supplied (config/private-file.ts's limit).
 * The parent must be trusted; descriptor checks and identity checks bind the reads to the checked paths. */
function readSecrets(path: string, options: SecretsReadOptions): string {
  const directory = dirname(path);
  checkTrustedDir(directory, options);
  const open = options.open ?? openSync;
  const stat = options.fstat ?? fstatSync;
  const uid = options.uid ?? process.getuid?.();
  const dirFd = open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const parent = stat(dirFd);
    if (!parent.isDirectory() || (parent.mode & 0o022) !== 0 || (uid !== undefined && parent.uid !== uid)) throw new Error("untrusted secrets parent");
    checkAcl(directory, options);
    sameFile(directory, parent);
    const fd = open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = stat(fd);
      if (!st.isFile()) throw new Error(`${path} must be a regular file`);
      if ((st.mode & 0o177) !== 0) throw new Error(`${path} must have mode 0600 or stricter`);
      if (uid !== undefined && st.uid !== uid) throw new Error(`${path} must belong to the current user`);
      checkAcl(path, options);
      sameFile(path, st);
      sameFile(directory, parent);
      return readFileSync(fd, "utf8");
    } finally { closeSync(fd); }
  } finally { closeSync(dirFd); }
}

function sameFile(path: string, opened: Stats): void {
  const current = lstatSync(path);
  if (current.dev !== opened.dev || current.ino !== opened.ino) throw new Error(`${path} changed while being checked`);
}

export function envFileSecrets(path: string, options: SecretsReadOptions = {}): SecretsBackend {
  const text = readSecrets(resolve(path), options);
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = LINE.exec(line);
    if (!m) continue;
    let v = (m[2] ?? "").trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    values.set(m[1] ?? "", v);
  }
  return { get: (k) => values.get(k) };
}

/** The write side of the backend, used only by jarvis setup (decision 43). Errors name the key, never the value. */
export interface SecretsWriter {
  /** Where values go, for messages. Never a value. */
  readonly location: string;
  /** Creates or checks the backend before any value is asked for. */
  prepare(): void;
  /** brokerOnly marks a production token: only the broker's approval-bound operations may use it (decision 12). */
  set(key: string, value: string, meta: { brokerOnly: boolean }): void;
}

/** Printable ASCII without spaces or quotes, so the reader above returns it byte for byte and no line can be injected. */
export function isStorableSecret(value: string): boolean {
  return /^[\x21\x23-\x26\x28-\x7e]{8,4096}$/.test(value);
}

const MARKER = "# broker-only: ";

function checkOwnerOnly(path: string, what: string, uid: number | undefined, trust: TrustOptions): void {
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (!existing) return;
  if ((existing.mode & 0o077) !== 0) throw new Error(`${path}: the secrets ${what} must be owner only (it is ${(existing.mode & 0o777).toString(8)})`);
  if (uid !== undefined && existing.uid !== uid) throw new Error(`${path} must belong to the current user`);
  // Owner-only mode bits aren't enough on macOS: an ACL can still let another user in.
  checkAcl(path, trust);
}

/** Writes KEY=value lines into the env file envFileSecrets reads: owner-only folder and file, atomic replace, no symlinks, no ACL. */
export function envFileSecretsWriter(path: string, options: { rename?: typeof renameSync; /** Test seams for ownership and ACLs. */ uid?: number; acl?: (path: string) => string } = {}): SecretsWriter {
  const directory = dirname(path);
  const uid = options.uid ?? process.getuid?.();
  const trust: TrustOptions = { ...(uid !== undefined ? { uid } : {}), ...(options.acl ? { acl: options.acl } : {}) };
  const check = () => {
    refuseSymlink(directory);
    refuseSymlink(path);
    checkOwnerOnly(directory, "folder", uid, trust);
    checkOwnerOnly(path, "file", uid, trust);
  };
  return {
    location: path,
    prepare() {
      check();
      privateDir(directory, trust);
      check();
    },
    set(key, value, meta) {
      if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(key)) throw new Error("Secret key names are upper-case letters, digits and underscores");
      if (!isStorableSecret(value)) throw new Error(`Refusing to store ${key}: a token is 8 to 4096 printable ASCII characters with no spaces or quotes`);
      check();
      privateDir(directory, trust);
      const lines = lstatSync(path, { throwIfNoEntry: false }) ? readNoFollow(path).split("\n") : [];
      const kept = lines.filter((line) => line !== "" && line !== `${MARKER}${key}` && LINE.exec(line)?.[1] !== key);
      if (meta.brokerOnly) kept.push(`${MARKER}${key}`);
      kept.push(`${key}=${value}`);
      writePrivateAtomic(path, `${kept.join("\n")}\n`, { ...trust, ...(options.rename ? { rename: options.rename } : {}) });
    },
  };
}
