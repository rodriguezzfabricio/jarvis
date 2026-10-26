import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { createSnapshot, findCredentials, findSnapshotCredentials, isBase64UserPassword } from "../../packages/cli/src/eval/snapshot.ts";
import { isCredentialShaped } from "../../packages/cli/src/eval/snapshot-literals.ts";
import { shortTmp } from "../helpers.ts";
import { FAKE_NPM_TOKEN } from "./helpers/fake-tokens.ts";

/**
 * Decision 79: the scanner is hygiene and must not refuse ordinary files. Every negative here is a line
 * (or the shape of a file) from FreeHire at 486c357 that the backlog 50–64 scanner refused; every positive
 * is the closest real-credential form, which must still be refused.
 */

const scan = (name: string, content: string | Buffer) => findSnapshotCredentials(name, Buffer.from(content));
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
const noise = (seed: string, n: number) => {
  const out: Buffer[] = [];
  let h = Buffer.from(seed);
  while (out.length * 32 < n) out.push((h = createHash("sha256").update(h).digest()));
  return Buffer.concat(out).subarray(0, n);
};
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pem = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }) as string;

const root = shortTmp("jts-fp-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let next = 0;
async function snapshot(files: Record<string, string | Buffer>): Promise<string> {
  const repo = join(root, `src-${next}`);
  const dest = join(root, `dest-${next++}`);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(repo, name, ".."), { recursive: true });
    writeFileSync(join(repo, name), content);
  }
  safeGit(repo, ["init", "-q", "-b", "main"], { home: root });
  safeGit(repo, ["add", "-A"], { home: root });
  safeGit(repo, ["commit", "-qm", "fixture"], { home: root });
  await createSnapshot({ sourceRepo: repo, rev: "HEAD", dest });
  return dest;
}

describe("base64 decoding applies only to plausibly encoded runs", () => {
  it.each([
    ["README.md", "catalog row. Only when a company runs on an ATS we don't cover yet does it need a\n"],
    ["Dockerfile", "# parallel. Cold-cache: 26s -> 17s locally, 72s -> ~50s on a CI runner. Only the\n"],
    ["check-contributors-token.sh", "echo '  Repository access ....... Only select repositories, including this one'\n"],
    ["main.go", "\t\tOldName:  r.oldName,\n// Only blocker.go — the evaluator inputs/logic are server-only.\n"],
    ["AGENTS.md", "- **Per-source figures:** `GET /api/v1/sources` and the public `/sources` page read ONE snapshot, `source_stats`, rebuilt by a pass inside `cmd/rollup-stats`\n"],
    ["identifiers.go", "func (q *Queries) GetGmailRefreshToken(ctx context.Context, userID int64) (string, error) {\n\tInstrumentationScope string\n"],
  ])("keeps %s", (name, text) => {
    expect(scan(name, text)).toEqual([]);
  });

  it("does not decode words as user:password", () => {
    expect(isBase64UserPassword("Only")).toBe(false);
    expect(findCredentials("Only when")).toEqual([]);
    // Dictionary words that do decode to "k:'j" and "k:1ɩⲉ^": one character class, so not encoded.
    expect(isBase64UserPassword("azonal")).toBe(false);
    expect(isBase64UserPassword("azoxyanisole")).toBe(false);
  });

  it("does not inflate short fragments, word columns or identifier bytes as containers", () => {
    // A truncated zlib-in-base64 fragment, as a log line or wrapped into a column of short words.
    expect(scan("notes.md", "Truncated in the log: eJzLSM3JyQcA\n")).toEqual([]);
    expect(scan("notes.md", "eJzL\nSM3J\nyQcA\n")).toEqual([]);
    // A long mixed-class run whose bytes happen to start with a weak zlib header: random data, not text or DER.
    expect(scan("notes.md", "id: SA3//v38+/r5+Pf2\n")).toEqual([]);
  });

  it("requires a username, and printable decoded text", () => {
    expect(isBase64UserPassword(b64(":Synthetic9qvM2"))).toBe(false);
    expect(isBase64UserPassword(b64("svc:\u0085\u0086\u0087\u0088x"))).toBe(false);
    expect(isBase64UserPassword(b64("svc:8k2Z"))).toBe(true);
    expect(isBase64UserPassword(b64("svc:Syñthetic9qvM2"))).toBe(true);
  });

  it("still refuses Basic credentials and base64 logins in ordinary files", () => {
    expect(scan("creds.ts", `export const registryLogin = "${b64("svc:Synthetic9qvM2")}";\n`)).toContain("base64 user:password");
    expect(scan("credential.txt", b64("svc:8k2Z"))).toContain("base64 user:password");
    expect(scan("notes.md", `Use ${b64("deploy:q8Zr2vLm0Tx")} for the registry.\n`)).toContain("base64 user:password");
  });
});

describe("credential names without a credential-looking value", () => {
  it.each([
    // cmd/server/main.go and friends: config fields copied from a config struct.
    ["main.go", "\tstore, err := blobstore.New(ctx, blobstore.Config{\n\t\tAccessKey: cfg.S3AccessKey,\n\t\tSecretKey: cfg.S3SecretKey,\n\t})\n"],
    ["main.go", "\t\tSigningKey:      &cfg.InngestSigningKey,\n\t\tJWTSecret:                   cfg.JWTSecret,\n\t\tAdminPassword: cfg.LLMAdminPassword,\n"],
    ["main.go", "\t\ttoken = rec.JobPortalURL\n\t\tToken: token,\n\t\tapiKey = alias\n\t\tencToken:     enc,\n\t\th.telegramWebhookSecret = webhookSecret\n"],
    ["config.go", "type Config struct {\n\tAccessKey string\n\tSecretKey string `env:\"S3_SECRET_KEY\"`\n}\n"],
    ["config.go", "\tSecretKey: os.Getenv(\"S3_SECRET_KEY\"),\n\tkey := os.Getenv(\"S3_SECRET_KEY\")\n"],
    ["config.ts", "export const token = process.env.API_TOKEN;\nconst apiKey = import.meta.env.VITE_API_KEY;\n"],
    // extension/lib/analytics.ts: a storage key and a fetch option.
    ["analytics.ts", "const SESSION_KEY = 'gaSession';\nconst res = await fetch(url, {\n  credentials: 'omit',\n});\n"],
    // A Prometheus label and Markdown prose with inline code.
    ["metrics_test.go", '\t\t`freehire_chronic_boards{pass="unreachable"} 94`,\n\t\t`freehire_chronic_boards{pass="empty_feed"} 1`,\n'],
    ["notes.md", "would catch one. Arbitrary *variants* pass: `[&_tr]:border-b` is a selector, not a value.\n- `/link` with a valid token: `discord_links` row created/updated.\n"],
    // sqlc-generated query text under a *Token name.
    ["push_tokens.sql.go", "const deletePushToken = `-- name: DeletePushToken :execrows\nDELETE FROM user_push_tokens WHERE user_id = $1 AND token = $2\n`\n"],
    // Test and documentation fixtures: words, short values and elisions.
    ["auth_test.go", '\tRegister(app, Config{Pool: pool, FrontendOrigin: "http://localhost", JWTSecret: "test-secret", JWTTTL: time.Hour})\n'],
    ["billing_test.go", '\tconst billingSecret = "whsec_integration"\n\t\tAPIKey:        "sk_test",\n\tconst prefsSecret = "email-prefs-integration-secret-32b"\n'],
    ["renew_test.go", '\t\tAccessToken: "AQV", ExpiresAt: at(40 * day), RefreshToken: "AQW", RefreshExpiresAt: at(300 * day),\n\t\tClientSecret: "shh",\n\t\tBotToken:     "bot-token",\n'],
    ["register_test.go", '\tpostJSON(t, app, "/register", `{"email":"a@b.com","password":"validpassword123"}`)\n\t`{"email":"forgetful@example.test","password":"original-pw"}`\n'],
    ["API.md", "curl -X POST https://freehire.dev/api/v1/auth/login -d '{\"email\":\"me@example.com\",\"password\":\"hunter2hunter2\"}'\n"],
    ["API.md", "`Authorization: Bearer <jwt>` and `{\"pageSize\":50,\"nextPageToken\":\"...\"}` → paginated\n-d '{\"current_password\":\"…\",\"new_password\":\"…\"}'\n"],
    ["sentry_test.go", '\t\tDsn:       "https://public@o0.ingest.sentry.io/0",\n'],
    ["vc-portfolio-sources.md", "| **USV** | usv.com/portfolio | Next.js on **Sanity CMS**. The public GROQ API works without a token: `https://2r1amp8c.apicdn.sanity.io/v2021-10-21/data/query/production` |\n"],
    ["README.md", "password: aws-sm:arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db-AbCdEf\n"],
    ["api-reference.openapi.json", `${JSON.stringify({ example: '{\n  "data": [ { "token": "ExponentPushToken[...]", "platform": "ios" } ]\n}' })}\n`],
  ])("keeps %s", (name, text) => {
    expect(scan(name, text)).toEqual([]);
  });

  it.each([
    ["main.go", "\t\tAccessKey: q8Zr2vLm0TxK,\n"],
    ["main.go", '\t\tSecretKey: "q8Zr2vLm0Tx/Synthetic9qvM2+abc",\n'],
    ["creds.ts", 'export const password = "Synthetic9qvM2";\n'],
    ["auth_test.go", '\tconst jwtSecret = "e7Kq2mVx9PzR4tLw"\n'],
    ["README.md", "password = Synthetic9qvM2\n"],
    ["request.http", "X-API-Key: Synthetic9qvM2\n"],
  ])("still refuses %s with a credential-looking value", (name, text) => {
    expect(scan(name, text).some((h) => h.startsWith("credential literal"))).toBe(true);
  });

  it("judges value shape: random-looking, not words, numbers, references or repeats", () => {
    for (const v of ["Synthetic9qvM2", "q8Zr2vLm0TxK", "e7Kq2mVx9PzR4tLw", "550e8400-e29b-41d4-a716-446655440000", "xKqZmPwRtV"]) expect(isCredentialShaped(v), v).toBe(true);
    for (const v of ["gaSession", "omit", "test-secret", "orchestrator-secret-value", "password123", "hunter2hunter2", "AQV", "ExponentPushToken[http-flow]", "replacement-pw-%d", "correct horse battery staple", "JobPortalURL", "0001"]) expect(isCredentialShaped(v), v).toBe(false);
  });
});

describe("URL query parameters", () => {
  it.each([
    ["pageRead.test.ts", 'const url = "https://jobs.example.test/apply?token=s3cr3t";\n'],
    ["postingurl_test.go", '\t{"https://job-boards.greenhouse.io/embed/job_app?for=stripe&jr_id=6a2444ad757ade085b6affd5&token=7826765", true},\n'],
    ["board_test.go", '\turl := "https://job-boards.greenhouse.io/embed/job_app?token=1"\n'],
  ])("keeps %s (documentation host or a numeric id)", (name, text) => {
    expect(scan(name, text)).toEqual([]);
  });

  it("still refuses a credential in a real host's query", () => {
    expect(scan("request.ts", 'fetch("https://api.acme.net/download?api_key=Synthetic9qvM2")')).toContain("credential URL query");
    expect(scan("notes.md", "https://api.acme.net/?access_token=q8Zr2vLm0Tx")).toContain("credential URL query");
  });
});

describe("images and fonts", () => {
  const media: [string, Buffer][] = [
    ["screenshot.png", Buffer.concat([PNG, noise("png", 400_000)])],
    ["freehire.gif", Buffer.concat([Buffer.from("GIF89a"), noise("gif", 400_000)])],
    ["photo.jpg", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), noise("jpg", 200_000)])],
    ["Carlito-Bold.ttf", Buffer.concat([Buffer.from([0, 1, 0, 0]), noise("ttf", 400_000)])],
    ["font.woff2", Buffer.concat([Buffer.from("wOF2"), noise("woff2", 100_000)])],
  ];
  it.each(media)("keeps %s as data", (name, bytes) => {
    expect(scan(name, bytes)).toEqual([]);
  });

  it("keeps binary data whose first bytes pass the zlib checksum but name no valid window", () => {
    // 0xf8 0x00: method 8 and (0xf800 % 31) === 0, but window 15 is past zlib's maximum of 7.
    expect(scan("blob.bin", Buffer.from([0xf8, 0x00, 0xff, 0xfe, 0x80, 0x81, 0x00, 0xc3]))).toEqual([]);
  });

  it("decodes an image's XMP like any text: a base64 JPEG thumbnail is an image, not a refusal", () => {
    // Codex review: XMP is text, so it goes through the decoding pipeline. A broken zlib field there needs
    // review exactly as it would in a text file; a real thumbnail decodes to a JPEG and passes.
    const thumbnail = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), noise("thumb", 2048), Buffer.from([0xff, 0xd9])]).toString("base64");
    expect(scan("screenshot.png", Buffer.concat([PNG, noise("xmp", 4096), Buffer.from(`<x:xmpmeta><xmpGImg:image>${thumbnail}</xmpGImg:image></x:xmpmeta>`), noise("xmp2", 4096)]))).toEqual([]);
  });

  it("still refuses a private key appended to an image", () => {
    expect(scan("screenshot.png", Buffer.concat([PNG, noise("png", 4096), Buffer.from(pem)]))).toContain("private key");
  });

  it("scans text in disguise: an image name or magic on UTF-8 text", () => {
    expect(scan("logo.png", "password = Synthetic9qvM2\n").length).toBeGreaterThan(0);
    expect(scan("anim.gif", "GIF89a\npassword = Synthetic9qvM2\n").length).toBeGreaterThan(0);
  });

  it("snapshots a FreeHire-shaped tree end to end", async () => {
    const files = {
      "README.md": "catalog row. Only when a company runs on an ATS we don't cover yet does it need a\n",
      "cmd/server/main.go": "package main\n\nfunc run() {\n\tstore, _ := blobstore.New(ctx, blobstore.Config{\n\t\tAccessKey: cfg.S3AccessKey,\n\t\tSecretKey: cfg.S3SecretKey,\n\t})\n}\n",
      "docs/assets/screenshot.png": Buffer.concat([PNG, noise("tree", 200_000)]),
    };
    const dest = await snapshot(files);
    expect(readFileSync(join(dest, "cmd/server/main.go"), "utf8")).toBe(files["cmd/server/main.go"]);
  }, 60_000);
});

// Two older rules that the backlog 50–64 literal checks masked (their mutations survived since 58ea864):
// each case here is refused only by the rule named.
describe("rules the literal checks used to mask", () => {
  it("refuses an npm access token outside any assignment", () => {
    expect(scan("notes.md", `Publish with ${FAKE_NPM_TOKEN} from CI.\n`)).toEqual(["npm token"]);
  });

  it("refuses an unparseable configuration that names a credential field", () => {
    expect(scan("broken.yaml", "database:\n  password: ${DB_PASSWORD}\n bad: [unclosed\n")).toEqual(["unparseable configuration with credential-named fields"]);
  });
});
