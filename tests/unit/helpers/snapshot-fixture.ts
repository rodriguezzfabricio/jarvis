// Shared setup for the snapshot tests (tests/unit/snapshot-1..3.test.ts): each file gets its own folder
// (this module is evaluated once per test file) and removes it in its own afterAll. The encoded-credential
// cases are split across snapshot-2 and snapshot-3: in one file they ran past AGENTS.md's ~25 s.
import { execFileSync } from "node:child_process";
import type { KeyPairKeyObjectResult } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { shortTmp } from "../../helpers.ts";
import { FAKE_NPM_TOKEN } from "./fake-tokens.ts";

export const root = shortTmp("jts-");
export const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();

export function sourceRepo(): { repo: string; base: string; fix: string } {
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

/** Codex review 6 and later: credentials encoded by their containing format, and credential-named fields. */
export function encodedCases(edKey: KeyPairKeyObjectResult): [string, string][] {
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
    "npm-token.ts": `const token = "${FAKE_NPM_TOKEN}";\n`,
    "auth-field.yaml": "headers:\n  authorization: Synthetic9qvM2\n",
    "kubeconfig-literal.yaml": "users:\n  - user:\n      client-key-data: Synthetic9qvM2\n",
    "alias-bomb.yaml": `a: &a [${Array(10).fill("x").join(",")}]\nb: &b [${Array(10).fill("*a").join(",")}]\nc: &c [${Array(10).fill("*b").join(",")}]\nd: [${Array(10).fill("*c").join(",")}]\n`,
  };
  return Object.entries(cases);
}

/**
 * Snapshots each case's file in its own repository, four at a time, each in its own worker thread
 * (snapshot-case-worker.mjs): createSnapshot and git block the thread, so only threads overlap them.
 * Resolves with each case's refusal message ("" if the snapshot was accepted), in order.
 */
export async function snapshotErrors(entries: [string, string][]): Promise<string[]> {
  const runCase = (name: string, content: string) =>
    new Promise<string>((resolve, reject) => {
      const w = new Worker(new URL("../snapshot-case-worker.mjs", import.meta.url), { workerData: { root, name, content } });
      w.once("message", resolve);
      w.once("error", reject);
      w.once("exit", (code) => reject(new Error(`case ${name}: worker exited ${code} without a result`)));
    });
  const errs: string[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < entries.length) {
        const i = next++;
        const [name, content] = entries[i]!;
        errs[i] = await runCase(name, content);
      }
    }),
  );
  return errs;
}
