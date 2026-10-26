import { execFileSync } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, crc32, deflateRawSync, deflateSync, gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { createSnapshot, findCredentials, findEncodedCredentials, findSecretFields, scanViews } from "../../packages/cli/src/eval/snapshot.ts";
import { shortTmp } from "../helpers.ts";

const root = shortTmp("jts-backlog-");
// Removing ~200 repositories can outlast a short hook limit under a loaded full run (Oct 25: 14 s).
afterAll(() => rmSync(root, { recursive: true, force: true }), 120_000);
const key = (() => {
  for (;;) {
    const candidate = generateKeyPairSync("ed25519");
    if (/[-_]/.test(candidate.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"))) return candidate;
  }
})();
const der = key.privateKey.export({ format: "der", type: "pkcs8" });
const paddedDer = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ format: "der", type: "pkcs8" });
const pem = key.privateKey.export({ format: "pem", type: "pkcs8" }) as string;
const jwk = key.privateKey.export({ format: "jwk" });
const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const password = "Synthetic9qvM2";
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
let next = 0;

async function snapshot(name: string, content: string | Buffer, allow = false): Promise<string> {
  const repo = join(root, `src-${next}`);
  const dest = join(root, `dest-${next++}`);
  mkdirSync(repo);
  writeFileSync(join(repo, name), content);
  const home = root;
  safeGit(repo, ["init", "-q", "-b", "main"], { home });
  safeGit(repo, ["add", "-A"], { home });
  safeGit(repo, ["commit", "-qm", "synthetic fixture"], { home });
  await createSnapshot({ sourceRepo: repo, rev: "HEAD", dest, ...(allow ? { allowSecretsIn: [name] } : {}) });
  return dest;
}

async function acceptedSnapshot(name: string, content: string | Buffer, allow = false): Promise<string> {
  const result = snapshot(name, content, allow);
  await expect(result).resolves.toEqual(expect.any(String));
  return result;
}

function base32(buf: Buffer): string {
  let bits = "";
  for (const byte of buf) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) out += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[Number.parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return out.padEnd(Math.ceil(out.length / 8) * 8, "=");
}

function tar(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write("0000600\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write("ustar\0", 257);
  header.write("00", 263);
  header.write(`${header.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512 + 1024)]);
}

function zip(name: string, data: Buffer, encrypted = false): Buffer {
  const compressed = deflateRawSync(data);
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(encrypted ? 1 : 0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  local.copy(central, 6, 4, 30);
  central.writeUInt16LE(20, 4);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + n.length, 12);
  end.writeUInt32LE(local.length + n.length + compressed.length, 16);
  return Buffer.concat([local, n, compressed, central, n, end]);
}

function ebcdic(text: string): Buffer {
  const table = new Map<string, number>([["-", 0x60], [" ", 0x40], ["\n", 0x25], ["/", 0x61], ["+", 0x4e], ["=", 0x7e]]);
  for (const [start, alphabet] of [[0xc1, "ABCDEFGHI"], [0xd1, "JKLMNOPQR"], [0xe2, "STUVWXYZ"], [0x81, "abcdefghi"], [0x91, "jklmnopqr"], [0xa2, "stuvwxyz"], [0xf0, "0123456789"]] as const) {
    [...alphabet].forEach((c, i) => table.set(c, start + i));
  }
  return Buffer.from([...text].map((c) => table.get(c)!));
}

function putty(): string {
  const ssh = (s: Buffer | string) => {
    const b = Buffer.from(s);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    return Buffer.concat([len, b]);
  };
  const publicBlob = Buffer.concat([ssh("ssh-ed25519"), ssh(key.publicKey.export({ format: "der", type: "spki" }).subarray(-32))]);
  const privateBlob = ssh(der.subarray(-32));
  const macKey = createHash("sha1").update("putty-private-key-file-mac-key").digest();
  const mac = createHmac("sha1", macKey).update(Buffer.concat([ssh("ssh-ed25519"), ssh("none"), ssh("synthetic"), ssh(publicBlob), ssh(privateBlob)])).digest("hex");
  return `PuTTY-User-Key-File-2: ssh-ed25519\nEncryption: none\nComment: synthetic\nPublic-Lines: 1\n${b64(publicBlob)}\nPrivate-Lines: 1\n${b64(privateBlob)}\nPrivate-MAC: ${mac}\n`;
}

type Case = [row: number, scenario: string, name: string, content: string | Buffer];
const cases: Case[] = [
  [50, "command assignment after separator", "ci.yaml", `run: "cd app && API_KEY=${password} npm run build"\n`],
  [50, "adjacent password argument", "deployment.yaml", `args: ["--password", "${password}"]\n`],
  [51, "YAML comment", "settings.yaml", `# password: ${password}\nsettings: true\n`],
  [51, "TOML comment", "settings.toml", `# password = "${password}"\nhost = "prod.acme.net"\n`],
  [51, "JSONC comment", "settings.jsonc", `{// "password": "${password}"\n "enabled": true}\n`],
  [52, "TypeScript assignment", "creds.ts", `export const password = "${password}";\n`],
  [52, "TypeScript template password", "creds.ts", `export const password = \`${password}\`;\n`],
  [52, "documentation assignment", "README.md", `password = ${password}\n`],
  [52, "Python assignment", "generated.py", `PASSWORD = '${password}'\n`],
  [52, "notebook code cell", "analysis.ipynb", JSON.stringify({ cells: [{ cell_type: "code", source: [`PASSWORD = '${password}'\n`] }], metadata: {}, nbformat: 4, nbformat_minor: 5 })],
  [52, "HTTP API key", "request.http", `GET https://api.acme.net/\nX-API-Key: ${password}\n`],
  [53, "lockfile query token", "yarn.lock", `pkg:\n  resolved "https://registry.acme.net/pkg.tgz?token=${password}"\n`],
  [53, "source query api_key", "request.ts", `fetch("https://api.acme.net/download?api_key=${password}")`],
  [53, "query access_token", "notes.md", `https://api.acme.net/?access_token=${password}`],
  [54, "base64url DER", "blob.txt", der.toString("base64url")],
  [54, "padded base64url DER", "blob.txt", paddedDer.toString("base64").replaceAll("+", "-").replaceAll("/", "_")],
  [54, "16 character wrapping", "blob.txt", b64(der).match(/.{1,16}/g)!.join("\n")],
  [54, "quoted 24 character wrapping", "blob.txt", `"${b64(der).match(/.{1,24}/g)!.join("\n")}"`],
  [55, "short base64 login", "credential.txt", b64("svc:8k2Z")],
  [55, "Unicode base64 login", "credential.txt", b64("svc:Syñthetic9qvM2")],
  [55, "long base64 login", "credential.txt", b64(`svc:${"q8Zr2vLm0Tx".repeat(37)}`)],
  [56, "double base64 DER", "blob.txt", b64(b64(der))],
  [56, "base64 UTF-16LE PEM", "blob.txt", b64(Buffer.from(pem, "utf16le"))],
  [56, "base64 JSON credential", "blob.txt", b64(`{"password":"${password}"}`)],
  [57, "hex DER", "blob.txt", der.toString("hex")],
  [57, "base32 DER", "private.txt", base32(der)],
  [57, "source byte array", "key.js", `const key = Buffer.from([${[...der].join(",")}]);`],
  [58, "fully percent encoded token", "notes.md", [...token].map((c) => `%${c.charCodeAt(0).toString(16)}`).join("")],
  [59, "template literal escape", "key.js", 'const key = `\\x67hp_abcdefghijklmnopqrstuvwxyz0123456789`;'],
  [59, "backslash newline continuation", "key.js", 'const key = "ghp_abcdefghijklm\\\nnopqrstuvwxyz0123456789";'],
  [59, "Python octal escapes", "key.py", `key = "${[...token].map((c) => `\\${c.charCodeAt(0).toString(8)}`).join("")}"`],
  [59, "escaped Authorization with context", "request.ts", 'const h = { Authorization: "\\x42earer Synthetic9qvM2" };'],
  [60, "cp037 PEM", "private.txt", ebcdic(pem)],
  [60, "UTF-7 PEM", "private.txt", `+${Buffer.from(pem, "utf16le").swap16().toString("base64").replace(/=+$/, "")}-`],
  [61, "gzip PEM", "blob.gz", gzipSync(pem)],
  [61, "zlib DER", "blob.bin", deflateSync(der)],
  [61, "Brotli PEM", "blob.br", brotliCompressSync(Buffer.from(pem))],
  [61, "deflated ZIP member", "blob.zip", zip("secret.pem", Buffer.from(pem))],
  [61, "gzip dotenv member", ".env.gz", gzipSync(`API_KEY=${password}\n`)],
  [61, "ZIP dotenv member", "blob.zip", zip(".env", Buffer.from(`API_KEY=${password}\n`))],
  [61, "ZIP nested registry auth member", "blob.zip", zip("config/.yarnrc", Buffer.from(`"//registry.npmjs.org/:_authToken" ${password}\n`))],
  [61, "tar DER member", "blob.tar", tar("secret.der", der)],
  [62, "PuTTY v2 Ed25519", "identity.txt", putty()],
  [62, "encrypted PKCS8 DER", "key.bin", key.privateKey.export({ format: "der", type: "pkcs8", cipher: "aes-256-cbc", passphrase: "synthetic-build-passphrase" })],
  [62, "base64 encrypted PKCS8", "key.b64", b64(key.privateKey.export({ format: "der", type: "pkcs8", cipher: "aes-256-cbc", passphrase: "synthetic-build-passphrase" }))],
  [63, "distant private source JWK", "key.ts", `export const key = ${JSON.stringify({ kty: jwk.kty, note: "n".repeat(1200), ...jwk })};`],
  [63, "template literal JWK member", "identity.ts", `const identity = { kty: "OKP", crv: "Ed25519", x: "${jwk.x}", d: \`${jwk.d}\` };`],
];

describe("snapshot scanner backlog", () => {
  it.each(cases)("row %i: %s (%s)", async (_row, _scenario, name, content) => {
    await expect(snapshot(name, content)).rejects.toThrow(`credential-looking content in ${name}`);
  });

  it("row 62: genuine empty-password PKCS12 under an arbitrary suffix", async () => {
    const dir = join(root, "pfx");
    mkdirSync(dir);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ format: "pem", type: "pkcs8" });
    writeFileSync(join(dir, "key.pem"), rsa);
    execFileSync("/usr/bin/openssl", ["req", "-new", "-x509", "-key", join(dir, "key.pem"), "-subj", "/CN=synthetic.invalid", "-days", "1", "-out", join(dir, "cert.pem")], { stdio: "pipe" });
    const pfx = execFileSync("/usr/bin/openssl", ["pkcs12", "-export", "-inkey", join(dir, "key.pem"), "-in", join(dir, "cert.pem"), "-passout", "pass:"], { stdio: "pipe" });
    await expect(snapshot("identity.bin", pfx)).rejects.toThrow("identity.bin");
  });

  it("row 64: accepts base64 public URLs while refusing Basic credentials", async () => {
    const source = `const guide = "${b64("https://example.com/guide")}";`;
    const dest = await acceptedSnapshot("guide.ts", source);
    expect(readFileSync(join(dest, "guide.ts"), "utf8")).toBe(source);
    await expect(snapshot("request.http", `Authorization: Basic ${b64("svc:8k2Z")}`)).rejects.toThrow("request.http");
  });

  it.each([
    ["substitution.yaml", "run: cd app && API_KEY=$(cat /run/secrets/api) npm run build\n"],
    ["backticks.yaml", "run: cd app && API_KEY=`cat /run/secrets/api` npm run build\n"],
    ["source.py", "x = 1\nprint(x)\n"],
    ["source.ts", 'export const password = process.env.PASSWORD;\nconst h = { Authorization: `Bearer ${token}` };\nconst passwordMinLength = 12;\nconst obj = { password: runtimeValue };'],
    ["README.md", 'password = <password>\n# password: changeme\nUse --password to supply your password.'],
    ["ci.yaml", 'run: "cd app && API_KEY=${API_KEY} npm run build"\nargs: ["--password", "${DB_PASSWORD}"]\n# password: <password>\n'],
    ["compose.yml", 'services:\n  app:\n    environment: ["NODE_ENV=production", "API_KEY=${API_KEY}", "DB_PASSWORD="]\n    command: ["serve", "--port=3000"]\n'],
    ["package-lock.json", '{"packages":{"a":{"resolved":"https://registry.npmjs.org/a/-/a.tgz","integrity":"sha512-abcxyz=="}}}'],
    ["public.ts", `export const key = ${JSON.stringify(key.publicKey.export({ format: "jwk" }))};`],
    ["switches.yaml", "password: false\nsecret: null\n"],
    ["view.json", JSON.stringify({ view: b64('{"c":1,"t":2}') })],
    ["hashes.txt", createHash("sha256").update("ordinary data").digest("hex")],
    ["data.js", "const key = Buffer.from([1, 2, 3, 4, 5, 6]);"],
    ["utf7.txt", `+${Buffer.from("--- ordinary documentation ---!!", "utf16le").swap16().toString("base64").replace(/=+$/, "")}-`],
    ["image.bin", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 255, 0, 42])],
    ["assets.gz", gzipSync("ordinary documentation")],
    ["assets.br", brotliCompressSync(Buffer.from("ordinary documentation"))],
    ["assets.zip", zip("README.md", Buffer.from("ordinary documentation"))],
    ["assets.tar", tar("README.md", Buffer.from("ordinary documentation"))],
  ] as [string, string | Buffer][])("keeps ordinary %s", async (name, content) => {
    const dest = await acceptedSnapshot(name, content);
    expect(readFileSync(join(dest, name))).toEqual(Buffer.from(content));
  });

  it.each([
    ["duplicate.json", `{"password":"${password}","password":""}`],
    ["duplicate.yaml", `password: ${password}\npassword: ''\n`],
    ["auth.json", '{"auths":{"registry.acme.net":{"auth":"opaque-login"}}}'],
    ["auth.yaml", 'auths:\n  registry.acme.net:\n    auth: opaque-login\n'],
    ["jwk.json", JSON.stringify({ kty: jwk.kty, note: "n".repeat(1200), ...jwk })],
    ["jwk.yaml", Object.entries(jwk).map(([k, v]) => `${k}: ${v}`).join("\n")],
    [".npmrc", '_auth=opaque-login\n'],
    ["binary.yaml", 'password: !!binary U3ludGhldGljOXF2TTI=\n'],
  ])("preserves the field helper contract for %s", (name, text) => {
    expect(findSecretFields(name!, text!)).not.toEqual([]);
  });

  it("preserves the pattern and encoded-content helper contracts", () => {
    expect(findCredentials(JSON.stringify(jwk))).toContain("private JWK");
    expect(findEncodedCredentials(b64(der))).not.toEqual([]);
    const shifted = `+${Buffer.from(pem, "utf16le").swap16().toString("base64").replace(/=+$/, "")}-`;
    expect(scanViews(Buffer.from(shifted)).includes(pem)).toBe(true);
  });

  it("honors reviewed fixtures for nested containers", async () => {
    const dest = await acceptedSnapshot("fixture.gz", gzipSync(pem), true);
    expect(existsSync(join(dest, "fixture.gz"))).toBe(true);
  });

  it("bounds nested wrappers and expanded bytes, and refuses encrypted ZIP members", async () => {
    let nested = Buffer.from("ordinary documentation");
    for (let i = 0; i < 12; i++) nested = gzipSync(nested);
    await expect(snapshot("nested.gz", nested)).rejects.toThrow(/limit|depth/i);
    await expect(snapshot("large.gz", gzipSync(Buffer.alloc(17 * 1024 * 1024, 33)))).rejects.toThrow(/limit|large/i);
    await expect(snapshot("encrypted.zip", zip("note.txt", Buffer.from("ordinary documentation"), true))).rejects.toThrow(/encrypted|review/i);
  });
});
