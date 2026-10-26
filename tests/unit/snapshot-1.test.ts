import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createSnapshot, findCredentials, redactEnvText } from "../../packages/cli/src/eval/snapshot.ts";
import { git, root, sourceRepo } from "./helpers/snapshot-fixture.ts";
import { FAKE_NPM_TOKEN } from "./helpers/fake-tokens.ts";

// Removing ~100 repositories and snapshots can take longer than the default 10 s hook limit under a
// loaded full run (a file-level "Hook timed out" error in mutation controls).
afterAll(() => rmSync(root, { recursive: true, force: true }), 120_000);

describe("sanitized snapshots (golden tasks: how every task runs)", () => {
  const { repo, fix } = sourceRepo();

  it("redacts secret-looking values and keeps everything else", () => {
    const r = redactEnvText("A=1\nMY_API_KEY=xyz\nJWT_SECRET=s3\nEMPTY_TOKEN=\n# PASSWORD=c\nURL=https://x\n");
    expect(r.text).toBe("A=1\nMY_API_KEY=\nJWT_SECRET=\nEMPTY_TOKEN=\n# PASSWORD=c\nURL=https://x\n");
    expect(r.keys).toEqual(["MY_API_KEY", "JWT_SECRET"]);
  });

  it("exports one commit with no history and no remotes, secrets redacted", async () => {
    const dest = join(root, "snap1");
    const m = await createSnapshot({ sourceRepo: repo, rev: fix, dest });
    expect(git(dest, "rev-list", "--count", "HEAD")).toBe("1");
    expect(git(dest, "remote")).toBe("");
    expect(git(dest, "log", "--format=%s")).toBe("snapshot");
    expect(git(dest, "log", "--all", "--format=%B")).not.toContain("ANSWER-IN-HISTORY");
    expect(readFileSync(join(dest, "ext", ".env.production"), "utf8")).toContain("WXT_GA_API_SECRET=\n");
    expect(readFileSync(join(dest, "ext", ".env.production"), "utf8")).toContain("WXT_HIRE_ORIGIN=https://example.invalid");
    expect(() => readFileSync(join(dest, "untracked.env"))).toThrow();
    expect(m.redactions).toEqual([{ file: "ext/.env.production", keys: ["WXT_GA_API_SECRET"] }]);
    expect(m.commit).toMatch(/^[0-9a-f]{40}$/);
  }, 60_000);

  it("undoes a planted fix in the files, with no trace of it in git", async () => {
    const dest = join(root, "snap2");
    const m = await createSnapshot({ sourceRepo: repo, rev: fix, dest, revert: [fix] });
    expect(readFileSync(join(dest, "app.go"), "utf8")).toContain("// buggy");
    expect(git(dest, "log", "--all", "--format=%B")).not.toContain("the fix");
    expect(m.reverted).toEqual([fix]);
  }, 60_000);

  it("makes an empty starting folder for new products", async () => {
    const dest = join(root, "snap3");
    const m = await createSnapshot({ dest });
    expect(git(dest, "rev-list", "--count", "HEAD")).toBe("1");
    expect(git(dest, "ls-files")).toBe("");
    expect(m.sourceRev).toBeNull();
  }, 60_000);

  // Codex review 1, high: multi-line values, credential URLs and real keys must not survive.
  it("redacts quoted multi-line secrets entirely", () => {
    const r = redactEnvText('A=1\nPRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nmorekeymaterial\n-----END PRIVATE KEY-----"\nB=2\n');
    expect(r.text).toBe("A=1\nPRIVATE_KEY=\nB=2\n");
    expect(r.text).not.toContain("MIIE");
  });

  // Codex review 2, high: inline comments, escapes and unterminated quotes.
  it("redacts a secret that follows a quoted value with an inline comment", () => {
    const r = redactEnvText('PUBLIC_NAME="hello" # comment\nAPI_TOKEN=synthetic-sensitive-value\n');
    expect(r.text).toBe('PUBLIC_NAME="hello" # comment\nAPI_TOKEN=\n');
    expect(r.keys).toEqual(["API_TOKEN"]);
  });

  it("handles escaped quotes and unquoted inline comments", () => {
    const r = redactEnvText('GREETING="say \\"hi\\" # not a comment"\nDB_PASSWORD=hunter2 # prod\nNEXT=1\n');
    expect(r.text).toBe('GREETING="say \\"hi\\" # not a comment"\nDB_PASSWORD= # prod\nNEXT=1\n');
  });

  it("refuses an unterminated quoted value instead of guessing", () => {
    expect(() => redactEnvText('A="never closed\nAPI_TOKEN=secret\n')).toThrow(/unterminated/);
  });

  it("redacts password-only credential URLs (redis://:password@host)", () => {
    const r = redactEnvText("REDIS_URL=redis://:Synthetic9qvM2@cache.prod.acme.net:6379/0\n");
    expect(r.text).toBe("REDIS_URL=redis://REDACTED:REDACTED@cache.prod.acme.net:6379/0\n");
    expect(r.keys).toEqual(["REDIS_URL"]);
  });

  it("strips user:password from non-local credential URLs and keeps local dev defaults", () => {
    const r = redactEnvText("DATABASE_URL=postgres://admin:hunter2@prod.db.example.com:5432/app\nDEV_URL=postgres://hire:hire@localhost:5432/hire\n");
    expect(r.text).toContain("postgres://REDACTED:REDACTED@prod.db.example.com:5432/app");
    expect(r.text).toContain("postgres://hire:hire@localhost:5432/hire");
    expect(r.keys).toEqual(["DATABASE_URL"]);
  });

  it("recognizes credentials, including any private-key envelope", () => {
    const realKey = `-----BEGIN PRIVATE KEY-----\n${"A".repeat(120)}\n-----END PRIVATE KEY-----`;
    expect(findCredentials(realKey)).toEqual(["private key"]);
    // Dummy envelopes count too: a person must allowlist them (Codex review 4).
    expect(findCredentials("-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----")).toEqual(["private key"]);
    expect(findCredentials("redis://:Synthetic9qvM2@cache.prod.acme.net:6379/0")).toEqual(["credential URL"]);
    expect(findCredentials(`token: ghp_${"a".repeat(36)}`)).toEqual(["GitHub token"]);
    // Only the npm rule sees a bare token in prose (a generated fake, never a real one).
    expect(findCredentials(`Publish with ${FAKE_NPM_TOKEN} from CI.`)).toEqual(["npm token"]);
    expect(findCredentials("nothing here")).toEqual([]);
    expect(findCredentials('{"db": "postgres://admin:hunter2@prod.db.example.net:5432/app"}')).toEqual(["credential URL"]);
    expect(findCredentials("url: postgres://hire:hire@localhost:5432/hire and http://user:pass@proxy.example:8080")).toEqual([]);
    expect(findCredentials("postgres://REDACTED:REDACTED@prod.db.example.net/app")).toEqual([]);
    // Narrow placeholder forms seen in FreeHire's docs:
    for (const p of ["http://user:pass@host", "postgres://%s:%s@%s", "http://<user>-rotate:<pass>@p.webshare.io", "postgres://app:${DB_PASSWORD}@prod.acme.net/app", "postgres://app:{password}@prod.acme.net"]) {
      expect(findCredentials(p)).toEqual([]);
    }
    // Codex review 3, high: real passwords that the old rule exempted.
    for (const p of [
      "http://scraper:Zq8vT2mWx91@p.webshare.io:80",
      '{"db": "postgres://svc:N7q4%40QmV8n2Lp9@prod.acme.net/app"}',
      "postgres://svc:Pa$$w0rd!x9@prod.acme.net/app",
      "postgres://svc:8k2Z@prod.acme.net/app",
      "http://u:p@1.2.3.4",
    ]) {
      expect(findCredentials(p)).toEqual(["credential URL"]);
    }
  });

  it("fails closed on a credential anywhere in the tree, unless a person allowlisted that file", async () => {
    const repo2 = join(root, "src2");
    mkdirSync(repo2, { recursive: true });
    git(repo2, "init", "-q", "-b", "main");
    git(repo2, "config", "user.email", "t@t");
    git(repo2, "config", "user.name", "t");
    writeFileSync(join(repo2, "deploy.yaml"), `aws_key: AKIA${"ABCDEFGHIJKLMNOP"}\n`);
    git(repo2, "add", "-A");
    git(repo2, "commit", "-qm", "c");
    await expect(createSnapshot({ sourceRepo: repo2, rev: "HEAD", dest: join(root, "snapF") })).rejects.toThrow(/deploy.yaml \(AWS access key\)/);
    expect(existsSync(join(root, "snapF"))).toBe(false);
    const m = await createSnapshot({ sourceRepo: repo2, rev: "HEAD", dest: join(root, "snapG"), allowSecretsIn: ["deploy.yaml"] });
    expect(m.commit).toMatch(/^[0-9a-f]{40}$/);
  }, 60_000);

  it("fails closed on credentials hidden in UTF-16, binary or unterminated env files", async () => {
    const repo4 = join(root, "src4");
    mkdirSync(repo4, { recursive: true });
    git(repo4, "init", "-q", "-b", "main");
    git(repo4, "config", "user.email", "t@t");
    git(repo4, "config", "user.name", "t");
    writeFileSync(join(repo4, "notes.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`key=ghp_${"b".repeat(36)}`, "utf16le")]));
    writeFileSync(join(repo4, "blob.bin"), Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(`AKIA${"QRSTUVWXYZABCDEF"}`), Buffer.from([0, 0])]));
    writeFileSync(join(repo4, ".env"), 'A="open\nTOKEN=x\n');
    git(repo4, "add", "-A");
    git(repo4, "commit", "-qm", "c");
    const err = await createSnapshot({ sourceRepo: repo4, rev: "HEAD", dest: join(root, "snapU") }).then(() => "", (e: Error) => e.message);
    expect(err).toContain("notes.txt (GitHub token)");
    expect(err).toContain("blob.bin (AWS access key)");
    expect(err).toContain(".env (unterminated");
  }, 60_000);

  // Codex review 3, high: binary credentials, and the size boundary.
  it("refuses binary private keys and credential containers, and files over the size limit", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const repo5 = join(root, "src5");
    mkdirSync(repo5, { recursive: true });
    git(repo5, "init", "-q", "-b", "main");
    git(repo5, "config", "user.email", "t@t");
    git(repo5, "config", "user.name", "t");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(join(repo5, "signing.bin"), privateKey.export({ format: "der", type: "pkcs8" }));
    writeFileSync(join(repo5, "release.p12"), Buffer.from([0x30, 0x82, 0x01, 0x00, 0x02, 0x01, 0x03]));
    writeFileSync(join(repo5, "just-under.txt"), "a".repeat(2000));
    writeFileSync(join(repo5, "just-over.txt"), "a".repeat(2001));
    git(repo5, "add", "-A");
    git(repo5, "commit", "-qm", "c");
    const err = await createSnapshot({ sourceRepo: repo5, rev: "HEAD", dest: join(root, "snapK"), maxScanBytes: 2000 }).then(() => "", (e: Error) => e.message);
    expect(err).toContain("signing.bin (binary private key)");
    expect(err).toContain("release.p12 (credential container");
    expect(err).toContain("just-over.txt (too large to scan)");
    expect(err).not.toContain("just-under.txt");
    const ok = await createSnapshot({ sourceRepo: repo5, rev: "HEAD", dest: join(root, "snapK2"), maxScanBytes: 2000, allowSecretsIn: ["signing.bin", "release.p12", "just-over.txt"] });
    expect(ok.commit).toMatch(/^[0-9a-f]{40}$/);
  }, 60_000);

  // Codex reviews 3 and 4: snapshot-level regressions, not just the helper.
  it("refuses snapshots carrying real keys or passwords in any of these forms", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const cases: Record<string, string> = {
      "ed25519.pem": generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      "x25519.pem": generateKeyPairSync("x25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      "rsa-enc.key": generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ format: "pem", type: "pkcs1", cipher: "aes-256-cbc", passphrase: "pw" }).toString(),
      "config.json": '{"db": "postgres://svc:N7q4%40QmV8n2Lp9@prod.acme.net/app"}\n',
      "short.yaml": "db: postgres://svc:8k2Z@prod.acme.net/app\n",
      "punct.yaml": "db: postgres://svc:Pa$$w0rd!x9@prod.acme.net/app\n",
      "redis.json": '{"cache": "redis://:Synthetic9qvM2@cache.prod.acme.net:6379/0"}\n',
      "apostrophe.json": '{"db": "postgres://svc:N7q\'4QmV8@db.prod.acme.net/app"}\n',
      "apostrophe-user.yaml": "db: postgres://o'brien:Zq8vT2mWx91@db.prod.acme.net/app\n",
      "apostrophe-redis.json": '{"cache": "rediss://:Syn\'thetic9qvM2@cache.prod.acme.net:6380/0"}\n',
    };
    for (const [name, content] of Object.entries(cases)) {
      const repo = join(root, `srcX-${name}`);
      mkdirSync(repo, { recursive: true });
      git(repo, "init", "-q", "-b", "main");
      git(repo, "config", "user.email", "t@t");
      git(repo, "config", "user.name", "t");
      writeFileSync(join(repo, name), content);
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "c");
      const err = await createSnapshot({ sourceRepo: repo, rev: "HEAD", dest: join(root, `snapX-${name}`) }).then(() => "", (e: Error) => e.message);
      expect(err, name).toContain(name);
    }
  }, 60_000);

  it("keeps configuration whose credential fields are empty, references or placeholders", async () => {
    const repo = join(root, "srcInert");
    mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "package.json"), '{"name": "app", "author": "Fabricio", "scripts": {"test": "vitest"}, "max_tokens": 400}\n');
    writeFileSync(join(repo, "config.json"), '{"auth": true, "password": "", "token": null, "apiKey": "${API_KEY}", "clientSecret": "${CLIENT_SECRET:-}", "secret": "<secret>", "passwordMinLength": 8, "url": "https:\\/\\/example.com\\/x"}\n');
    writeFileSync(join(repo, ".github", "workflows", "ci.yml"), "jobs:\n  t:\n    env:\n      token: ${{ secrets.GITHUB_TOKEN }}\n      password: changeme\n");
    writeFileSync(join(repo, "app.toml"), 'password = ""\ntoken = "{{ vault_token }}"\n');
    writeFileSync(join(repo, "tsconfig.json"), '{\n  // comments are fine\n  "compilerOptions": { "strict": true, },\n}\n');
    writeFileSync(join(repo, "settings.xml"), "<settings><server><password>${env.REPO_PASSWORD}</password></server></settings>\n");
    writeFileSync(join(repo, "client.ts"), 'const h = { Authorization: `Bearer ${token}`, "X-Other": "Bearer " + key };\nconst doc = "Send Authorization: Bearer <token>";\n// Authorization: Bearer fhk_…\n// Authorization: Bearer &lt;key&gt;\n');
    writeFileSync(join(repo, "Makefile"), "test:\n\tgo test ./...\n");
    writeFileSync(join(repo, ".gitconfig"), "[user]\n\tname = x\n\temail = x@example.com\n");
    writeFileSync(join(repo, "Dockerfile"), "FROM node:24\nARG NPM_TOKEN\nENV NPM_TOKEN=${NPM_TOKEN}\n");
    writeFileSync(join(repo, "run"), '#!/bin/sh\nTOKEN="$1"\nPASSWORD=$(cat /run/secrets/db)\nexport API_KEY="${2}"\n');
    writeFileSync(join(repo, "settings.ini"), "[db]\npassword =\nhost = db.internal\n");
    writeFileSync(join(repo, "public.jwk.json"), `${JSON.stringify(generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }))}\n`);
    writeFileSync(join(repo, "request.json"), '{"headers": {"Authorization": "Bearer ${API_TOKEN}", "Accept": "application/json"}}\n');
    writeFileSync(join(repo, "kubeconfig.yaml"), `clusters:\n  - cluster:\n      certificate-authority-data: ${Buffer.from(generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }) as string).toString("base64")}\nusers:\n  - name: admin\n    user:\n      exec: {command: aws}\n`);
    writeFileSync(join(repo, "beans.xml"), '<beans><property name="password" value="${DB_PASSWORD}"/><property name="secret" ref="secretBean"/><property name="url" value="jdbc:postgresql://db/app"/><entry key="db.password"></entry></beans>\n');
    writeFileSync(join(repo, "app.config"), '<configuration><appSettings><add key="ApiKey" value="" /><add key="Theme" value="dark" /></appSettings></configuration>\n');
    writeFileSync(join(repo, "limits.yaml"), "password_min_length: 12\ntoken_ttl: 3600\nauth: true\n");
    writeFileSync(join(repo, "compose.yml"), 'services:\n  app:\n    environment: ["NODE_ENV=production", "API_KEY=${API_KEY}", "DB_PASSWORD="]\n    command: ["serve", "--port=3000"]\n');
    writeFileSync(join(repo, "repeat.yaml"), "name: a\nname: b\npassword: ''\n");
    writeFileSync(join(repo, "openapi.json"), '{"components": {"schemas": {"Login": {"properties": {"password": {"type": "string", "format": "password", "description": "At least 12 characters"}}}}}}\n');
    writeFileSync(join(repo, ".npmrc"), "registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_auth=${NPM_AUTH}\nauth-type=legacy\n");
    writeFileSync(join(repo, ".yarnrc"), '"//registry.npmjs.org/:_authToken" "${NPM_TOKEN}"\nyarn-offline-mirror "./mirror"\n');
    mkdirSync(join(repo, ".docker"), { recursive: true });
    writeFileSync(join(repo, ".docker", "config.json"), '{"auths": {"ghcr.io": {}, "quay.io": {"auth": ""}}, "credsStore": "desktop", "credHelpers": {"gcr.io": "gcloud"}}\n');
    writeFileSync(join(repo, "preview.html"), '<div data-view="eyJjIjotMTQ2NDQ3NzE0MywicCI6MzkxLCJ0IjoxNzgxMjY5Mjg4LCJoIjoiYmY5ZDM1N2MxZWVhM2M5YWNkIn0"></div>\n');
    writeFileSync(join(repo, "integrity.json"), '{"integrity": "sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==", "id": "AbCdEfGhIjKlMnOp"}\n');
    writeFileSync(join(repo, "deploy.yaml"), "env:\n  - name: DB_PASSWORD\n    valueFrom: {secretKeyRef: {name: db, key: password}}\n  - name: LOG_LEVEL\n    value: debug\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "c");
    await expect(createSnapshot({ sourceRepo: repo, rev: "HEAD", dest: join(root, "snapInert") })).resolves.toMatchObject({ redactions: [] });
  }, 60_000);

  it("redacts URLs whose password contains an apostrophe, in .env files", () => {
    const r = redactEnvText("CONNECTION_URL=rediss://:Syn'thetic9qvM2@cache.prod.acme.net:6380/0\nDB=postgres://svc:N7q'4QmV8@db.prod.acme.net/app\n");
    expect(r.text).not.toContain("thetic9qvM2");
    expect(r.text).not.toContain("N7q'4QmV8");
    expect(r.keys).toEqual(["CONNECTION_URL", "DB"]);
  });

  it("redacts a password-only Redis URL in a tracked .env file", async () => {
    const repo = join(root, "srcR");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, ".env"), "REDIS_URL=redis://:Synthetic9qvM2@cache.prod.acme.net:6379/0\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "c");
    await createSnapshot({ sourceRepo: repo, rev: "HEAD", dest: join(root, "snapR") });
    expect(readFileSync(join(root, "snapR", ".env"), "utf8")).not.toContain("Synthetic9qvM2");
  }, 60_000);

  it("removes symlinks that point outside the snapshot", async () => {
    const repo3 = join(root, "src3");
    mkdirSync(repo3, { recursive: true });
    git(repo3, "init", "-q", "-b", "main");
    git(repo3, "config", "user.email", "t@t");
    git(repo3, "config", "user.name", "t");
    writeFileSync(join(repo3, "a.txt"), "a");
    symlinkSync("/etc/hosts", join(repo3, "out"));
    symlinkSync("a.txt", join(repo3, "in"));
    git(repo3, "add", "-A");
    git(repo3, "commit", "-qm", "c");
    const m = await createSnapshot({ sourceRepo: repo3, rev: "HEAD", dest: join(root, "snapL") });
    expect(m.removedSymlinks).toEqual(["out"]);
    expect(existsSync(join(root, "snapL", "in"))).toBe(true);
  }, 60_000);

  it("refuses a destination that isn't empty", async () => {
    const dest = join(root, "snap4");
    mkdirSync(dest);
    writeFileSync(join(dest, "x"), "x");
    await expect(createSnapshot({ dest })).rejects.toThrow(/empty/);
  }, 60_000);
});
