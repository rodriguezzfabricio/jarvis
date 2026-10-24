import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createSnapshot, findCredentials, redactEnvText } from "../../packages/cli/src/eval/snapshot.ts";
import { shortTmp } from "../helpers.ts";

const root = shortTmp("jts-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();

function sourceRepo(): { repo: string; base: string; fix: string } {
  const repo = join(root, "src");
  mkdirSync(join(repo, "ext"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "remote", "add", "origin", "https://example.invalid/upstream.git");
  writeFileSync(join(repo, "app.go"), "package app\n// buggy\n");
  writeFileSync(join(repo, "ext", ".env.production"), "WXT_HIRE_ORIGIN=https://example.invalid\nWXT_GA_API_SECRET=abc123notreal\nDB_PASSWORD=\n# API_KEY=commented\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base commit with ANSWER-IN-HISTORY");
  const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "app.go"), "package app\n// fixed\n");
  git(repo, "commit", "-qam", "the fix");
  const fix = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "untracked.env"), "SECRET=x\n");
  return { repo, base, fix };
}

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
  });

  it("undoes a planted fix in the files, with no trace of it in git", async () => {
    const dest = join(root, "snap2");
    const m = await createSnapshot({ sourceRepo: repo, rev: fix, dest, revert: [fix] });
    expect(readFileSync(join(dest, "app.go"), "utf8")).toContain("// buggy");
    expect(git(dest, "log", "--all", "--format=%B")).not.toContain("the fix");
    expect(m.reverted).toEqual([fix]);
  });

  it("makes an empty starting folder for new products", async () => {
    const dest = join(root, "snap3");
    const m = await createSnapshot({ dest });
    expect(git(dest, "rev-list", "--count", "HEAD")).toBe("1");
    expect(git(dest, "ls-files")).toBe("");
    expect(m.sourceRev).toBeNull();
  });

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
  });

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
  });

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
  });

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
  });

  // Codex review 6, high: credentials encoded by their containing format, and credential-named fields.
  it("refuses credentials hidden by JSON, YAML or percent encoding, and literal credential fields", async () => {
    const edKey = generateKeyPairSync("ed25519");
    const cases: Record<string, string> = {
      "slash-escaped.json": '{"db": "postgres:\\/\\/svc:Synthetic9qvM2@db.prod.acme.net\\/app"}\n',
      "unicode-escaped.json": '{"db": "postgres:\\u002F\\u002Fsvc:Synthetic9qvM2\\u0040db.prod.acme.net/app"}\n',
      "escaped.yaml": 'db: "postgres:\\x2F\\x2Fsvc:Synthetic9qvM2@db.prod.acme.net/app"\n',
      "escaped-token.json": '{"k": "\\u0067hp_abcdefghijklmnopqrstuvwxyz0123456789"}\n',
      "percent.yaml": "db: postgres%3A%2F%2Fsvc%3ASynthetic9qvM2%40db.prod.acme.net/app\n",
      "password-field.json": '{"database": {"host": "db.prod.acme.net", "password": "Synthetic9qvM2"}}\n',
      "camel-secret.json": '{"oauth": {"clientSecret": "q8Zr2vLm0Tx"}}\n',
      "token-field.yaml": "slack:\n  bot_token: 9f8e7d6c5b4a\n",
      "api-key.toml": '[service]\napi_key = "Synthetic9qvM2"\n',
      "jsonc-password.json": '// comments make this JSONC\n{\n  "password": "Synthetic9qvM2",\n}\n',
      "settings.ini": "[db]\npassword=Synthetic9qvM2\n",
      ".npmrc": "//registry.npmjs.org/:_authToken=Synthetic9qvM2abc\n",
      ".netrc": "machine api.acme.net login svc password Synthetic9qvM2\n",
      "compose-default.yml": "services:\n  app:\n    environment:\n      JWT_SECRET: \"${JWT_SECRET:-Synthetic9qvM2}\"\n",
      "master-key.yml": "search:\n  MEILI_MASTER_KEY: q8Zr2vLm0Tx\n",
      // Codex review 7: structure the line reader missed, and a quoted numeric password.
      "block-scalar.yaml": "database:\n  password: |\n    Synthetic9qvM2\n",
      "folded.yaml": "database:\n  password: >-\n    Synthetic9qvM2\n",
      "flow.yaml": "database: {host: db.prod.acme.net, password: Synthetic9qvM2}\n",
      "anchor.yaml": "base: &creds\n  password: Synthetic9qvM2\nprod:\n  <<: *creds\n",
      "compact.jsonc": '{"db":{/* prod */"password":"Synthetic9qvM2",},}\n',
      "numeric.json": '{"password": "9372165408"}\n',
      "numeric-bare.yaml": "pin_password: 9372165408\n",
      "inline.toml": 'db = { host = "db.prod.acme.net", password = "Synthetic9qvM2" }\n',
      "Info.plist": '<?xml version="1.0"?>\n<plist><dict><key>APIToken</key><string>q8Zr2vLm0Tx</string></dict></plist>\n',
      "settings.xml": "<settings><server><id>x</id><password>Synthetic9qvM2</password></server></settings>\n",
      "attr.xml": '<datasource url="jdbc:x" password="Synthetic9qvM2"/>\n',
      "cdata.xml": "<cfg><secret><![CDATA[Synthetic9qvM2]]></secret></cfg>\n",
      "broken.yaml": "database:\n  password: Synthetic9qvM2\n bad: [unclosed\n",
      "utf16.json": Buffer.from('\ufeff{"password": "Synthetic9qvM2"}', "utf16le").toString("latin1"),
      // Codex review 8: assignments in environment lists, duplicate fields, binary scalars, nesting.
      "compose.yml": 'services:\n  app:\n    environment: ["API_KEY=Synthetic9qvM2"]\n',
      "compose-list.yaml": "services:\n  app:\n    environment:\n      - DB_PASSWORD=Synthetic9qvM2\n",
      "env-array.json": '{"containerDefinitions": [{"command": ["run"], "env": ["GITHUB_TOKEN=Synthetic9qvM2"]}]}\n',
      "duplicate.json": '{"password":"Synthetic9qvM2","password":""}\n',
      "duplicate-parent.json": '{"db": {"password": "Synthetic9qvM2"}, "db": {}}\n',
      "duplicate.yaml": "password: Synthetic9qvM2\npassword: ''\n",
      "binary.yaml": "password: !!binary U3ludGhldGljOXF2TTI=\n",
      "k8s-env.yaml": "spec:\n  containers:\n    - env:\n        - name: DB_PASSWORD\n          value: Synthetic9qvM2\n",
      "ecs-env.json": '{"environment": [{"name": "STRIPE_SECRET", "value": "Synthetic9qvM2"}]}\n',
      "alias-scalar.yaml": "plain: &p Synthetic9qvM2\npassword: *p\n",
      // Codex review 9: env entries whose value is an alias, repeated or typed; npm and Yarn auth.
      "env-alias.yaml": "pw: &p Synthetic9qvM2\nenv:\n  - name: DB_PASSWORD\n    value: *p\n",
      "env-alias-name.yaml": "n: &n DB_PASSWORD\nenv:\n  - name: *n\n    value: Synthetic9qvM2\n",
      "env-duplicate.yaml": "env:\n  - name: DB_PASSWORD\n    value: ''\n    value: Synthetic9qvM2\n",
      "env-duplicate.json": '{"env": [{"name": "DB_PASSWORD", "value": "", "value": "Synthetic9qvM2"}]}\n',
      "env-binary.yaml": "env:\n  - name: DB_PASSWORD\n    value: !!binary U3ludGhldGljOXF2TTI=\n",
      "alias-key.yaml": "k: &k password\nconfig:\n  *k : Synthetic9qvM2\n",
      "auth/.npmrc": "//registry.npmjs.org/:_auth=c3ZjOlN5bnRoZXRpYzlxdk0y\n",
      "auth-unscoped/.npmrc": "_auth=c3ZjOlN5bnRoZXRpYzlxdk0y\n",
      ".yarnrc.yml": 'npmAuthIdent: "svc:Synthetic9qvM2"\n',
      ".yarnrc": '"//registry.npmjs.org/:_authToken" Synthetic9qvM2abc\n',
      // Codex review 10: Docker registry auth, base64 user:password anywhere, and YAML merges.
      ".docker/config.json": '{"auths": {"https://index.docker.io/v1/": {"auth": "c3ZjOlN5bnRoZXRpYzlxdk0y"}}}\n',
      "docker-token.json": '{"auths": {"ghcr.io": {"identitytoken": "Synthetic9qvM2"}}}\n',
      "basic-header.ts": 'const headers = { Authorization: "Basic c3ZjOlN5bnRoZXRpYzlxdk0y" };\n',
      "merge-name.yaml": "base: &base\n  name: DB_PASSWORD\nenv:\n  - <<: *base\n    value: Synthetic9qvM2\n",
      "merge-value.yaml": "v: &v\n  value: Synthetic9qvM2\nenv:\n  - name: DB_PASSWORD\n    <<: *v\n",
      "merge-seq.yaml": "a: &a {x: 1}\nb: &b {name: DB_PASSWORD}\nenv:\n  - <<: [*a, *b]\n    value: Synthetic9qvM2\n",
      // Codex review 11: Docker auths.*.auth by structure, whatever the credential's length or characters.
      "docker-short/config.json": '{"auths": {"r.example.net": {"auth": "dTo4azJa"}}}\n',
      "docker-long/config.json": '{"auths": {"r.example.net": {"auth": "c3ZjOnE4WnIydkxtMFR4cThacjJ2TG0wVHhxOFpyMnZMbTBUeHE4WnIydkxtMFR4cThacjJ2TG0wVHhxOFpyMnZMbTBUeHE4WnIydkxtMFR4cThacjJ2TG0wVHhxOFpyMnZMbTBUeHE4WnIydkxtMFR4cThacjJ2TG0wVHhxOFpyMnZMbTBUeHE4WnIydkxtMFR4cThacjJ2TG0wVHhxOFpyMnZMbTBUeHE4WnIydkxtMFR4cThacjJ2TG0wVHhxOFpyMnZMbTBUeHE4WnIydkxtMFR4cThacjJ2TG0wVHhxOFpyMnZMbTBUeHE4WnIydkxtMFR4cThacjJ2TG0wVHhxOFpyMnZMbTBUeHE4WnIydkxtMFR4cThacjJ2TG0wVHhxOFpyMnZMbTBUeHE4WnIydkxtMFR4cThacjJ2TG0wVHhxOFpyMnZMbTBUeHE4WnIydkxtMFR4cThacjJ2TG0wVHhxOFpyMnZMbTBUeHE4WnIydkxtMFR4cThacjJ2TG0wVHhxOFpyMnZMbTBUeHE4WnIydkxtMFR4"}}}\n',
      "docker-utf8/config.json": '{"auths": {"r.example.net": {"auth": "c3ZjOlN5w7F0aGV0aWM5cXZNMg=="}}}\n',
      "podman-auth.yaml": "auths:\n  r.example.net:\n    auth: dTo4azJa\n",
      // Codex review 12: XML name/value structures, carrying the name to the value.
      "spring.xml": '<beans><bean id="ds"><property name="password" value="Synthetic9qvM2"/></bean></beans>\n',
      "spring-reversed.xml": "<bean><property value='Synthetic9qvM2' name='db.password'/></bean>\n",
      "spring-value.xml": '<bean><property name="password"><value>Synthetic9qvM2</value></property></bean>\n',
      "props.xml": '<properties><entry key="db.password">Synthetic9qvM2</entry></properties>\n',
      "escaped-props.xml": '<properties><entry key="db.password">Synth&#101;tic9qvM2</entry></properties>\n',
      "cdata-param.xml": '<params><param name="secret"><![CDATA[Synthetic9qvM2]]></param></params>\n',
      "nuget.config": '<configuration><packageSourceCredentials><feed><add key="ClearTextPassword" value="Synthetic9qvM2" /></feed></packageSourceCredentials></configuration>\n',
      "web.config": '<configuration><appSettings><add key="ApiKey" value="Synthetic9qvM2" /></appSettings></configuration>\n',
      // Codex review 13: Authorization headers by structure, and credentials hidden inside base64.
      "request.json": '{"headers": {"Authorization": "Bearer Synthetic9qvM2"}}\n',
      "api.ts": 'fetch(u, { headers: { Authorization: "Basic dTo4azJa" } });\n',
      "proxy.ts": `const h = { "Proxy-Authorization": "Basic ${Buffer.from("svc:Syñthetic9qvM2").toString("base64")}" };\n`,
      "long-basic.ts": `const h = { Authorization: "Basic ${Buffer.from(`svc:${"q8Zr2vLm0Tx".repeat(37)}`).toString("base64")}" };\n`,
      "req.http": "GET https://api.acme.net/v1/me\nAuthorization: Bearer Synthetic9qvM2\n",
      "kubeconfig.yaml": `users:\n  - name: admin\n    user:\n      client-key-data: ${Buffer.from(edKey.privateKey.export({ type: "pkcs8", format: "pem" }) as string).toString("base64")}\n`,
      "embedded-der.json": `{"blob": "${(edKey.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).toString("base64")}"}\n`,
      "secret.yaml": `kind: Secret\ndata:\n  url: ${Buffer.from("postgres://svc:Synthetic9qvM2@db.prod.acme.net/app").toString("base64")}\n`,
      "creds.ts": 'export const registryLogin = "c3ZjOlN5bnRoZXRpYzlxdk0y";\n',
      // Codex review 14: lowercase opaque tokens, and private JSON Web Keys.
      "lower-token.json": '{"headers": {"Authorization": "Bearer qzmtvknpwsrjlfcx"}}\n',
      "lower-token.ts": 'const h = { Authorization: "Bearer qzmt-vknp_wsrj.lfcx" };\n',
      "private.jwk.json": `${JSON.stringify(edKey.privateKey.export({ format: "jwk" }))}\n`,
      "jwks.yaml": `keys:\n  - ${JSON.stringify(edKey.privateKey.export({ format: "jwk" }))}\n`,
      // Structure alone: block YAML (unquoted values), and kty far from d.
      "jwk-block.yaml": `${Object.entries(edKey.privateKey.export({ format: "jwk" })).map(([k, v]) => `${k}: ${v}`).join("\n")}\n`,
      "jwk-gap.json": `${JSON.stringify({ kty: "OKP", crv: "Ed25519", note: "n".repeat(1200), ...edKey.privateKey.export({ format: "jwk" }) })}\n`,
      "oct.jwk.json": '{"kty": "oct", "k": "GawgguFyGrWKav7AX4VKUg", "alg": "HS256"}\n',
      "jwk.ts": `export const key = ${JSON.stringify(edKey.privateKey.export({ format: "jwk" }))};\n`,
      // Codex review 15: INI continuation lines, and extensionless credential stores.
      "continuation.ini": "[database]\npassword =\n    Synthetic9qvM2\n",
      "continuation.cfg": "[db]\n  token =\n  \tSynthetic9qvM2\n",
      ".aws/credentials": "[default]\naws_access_key_id = ASIAQ7ZR2VLM0TXK4PNB\naws_secret_access_key = q8Zr2vLm0Tx/Synthetic9qvM2+abcdefghij\naws_session_token = Synthetic9qvM2\n",
      "aws-id.ts": 'const id = "ASIAQ7ZR2VLM0TXK4PNB";\n',
      ".s3cfg": "[default]\nsecret_key = Synthetic9qvM2\n",
      "Dockerfile": "FROM node:24\nENV API_TOKEN=Synthetic9qvM2\n",
      // Decision 79: credentials for the eval allowlist's one write-capable host stay fully covered.
      // Review 16 B7 (still high under decision 79: npm is on the eval allowlist): text after a closing quote.
      "suffix/.npmrc": '//registry.npmjs.org/:_authToken="${TOKEN}"Synthetic9qvM2\n',
      "npm-token.ts": 'const token = "npm_q8Zr2vLm0TxSynthetic9qvM2abcdefghijZ";\n',
      "auth-field.yaml": "headers:\n  authorization: Synthetic9qvM2\n",
      "kubeconfig-literal.yaml": "users:\n  - user:\n      client-key-data: Synthetic9qvM2\n",
      "alias-bomb.yaml": `a: &a [${Array(10).fill("x").join(",")}]\nb: &b [${Array(10).fill("*a").join(",")}]\nc: &c [${Array(10).fill("*b").join(",")}]\nd: [${Array(10).fill("*c").join(",")}]\n`,
    };
    for (const [name, content] of Object.entries(cases)) {
      const slug = name.replaceAll("/", "_");
      const repo = join(root, `srcE-${slug}`);
      mkdirSync(dirname(join(repo, name)), { recursive: true });
      git(repo, "init", "-q", "-b", "main");
      git(repo, "config", "user.email", "t@t");
      git(repo, "config", "user.name", "t");
      writeFileSync(join(repo, name), name === "utf16.json" ? Buffer.from(content, "latin1") : content);
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "c");
      const err = await createSnapshot({ sourceRepo: repo, rev: "HEAD", dest: join(root, `snapE-${slug}`) }).then(() => "", (e: Error) => e.message);
      expect(err, name).toContain(name);
    }
  }, 120_000); // ~60 cases, each its own repo and snapshot

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
  });

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
  });

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
  });

  it("refuses a destination that isn't empty", async () => {
    const dest = join(root, "snap4");
    mkdirSync(dest);
    writeFileSync(join(dest, "x"), "x");
    await expect(createSnapshot({ dest })).rejects.toThrow(/empty/);
  });
});
