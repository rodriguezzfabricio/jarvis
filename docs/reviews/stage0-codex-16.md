# Stage 0 review 16: Codex, four parallel lanes (decision 77)

Oct 24, 2026 · codex-cli, `gpt-6.1-sol`, `--sandbox read-only`, reasoning effort high, isolated `CODEX_HOME` and `HOME` (decision 66).
- **Reviewed revision:** `e9121d421f408d462341c637e6473bd89eae5b44`, plus the stage 1 modules.
- **Raw verdicts:** `stage0-codex-16-{A,B,C,D}.json`.
- **Evidence:** typecheck, unit tests, live probe, doctor --live all exit 0; 106 of 106 mutations caught.

## Verdict: FAIL (every lane)

| Lane | Verdict | Critical | High | Medium | Low |
|---|---|---|---|---|---|
| A, full review | FAIL | 0 | 2 | 0 | 0 |
| B, structured configuration | FAIL | 0 | 29 | 0 | 0 |
| C, encodings and other files | FAIL | 0 | 12 | 1 | 0 |
| D, safety boundary | FAIL | 0 | 2 | 5 | 1 |

## Lane A, full review

Reviewed e9121d421f408d462341c637e6473bd89eae5b44. Two high credential-exposure findings block both stage 0's revised proof, excluding baselines, and stage 1's safety proof, excluding the desktop-app check.

Prior critical/high findings, by original numbering: all 37 original concrete reproductions have code fixes and regression assertions that would fail if the relevant protection were removed. This establishes those specific fixes; review 15 #1 remains incomplete for valid INI continuations described below.

Review 1: #1 Restricted mode and explicit tools exclude project hooks, guarded by args/probe tests and the live malicious-hook negative control. #2 Settings restrict outside reads, snapshot export removes escaping links, and baseline caches are private; settings/probe/snapshot/baseline tests cover these boundaries. #3 Web tools are excluded and denied, guarded by args/settings tests. #4 Baselines require preflight before workspace creation or session launch, guarded by baseline.test.ts. #5 Original multiline dotenv, credential-URL and private-key cases are fixed and snapshot-tested. #6 Network proof requires connectivity, blocked-host 000 and policy-denial evidence, guarded by probe tests and live negative controls.

Review 2: #1 Dotenv quote/comment parsing has escaping and unterminated-value regressions. #2 Size/NUL skips and JSON-URL omissions are fixed, with size-boundary, UTF-16 and binary regressions. #3 Per-run caches have distinct-path, absent cross-run marker and cleanup assertions. #4 Ordinary connectivity failures cannot satisfy the required denial evidence, guarded by probe tests.

Review 3: #1 Whole-value placeholder classification covers the reported short, encoded and punctuated passwords, with helper and snapshot regressions. #2 DER private-key detection and container refusal have generated-key snapshot regressions.

Review 4: #1 Private-key envelopes cover short and encrypted PEM keys, with generated-key regressions. #2 Password-only URLs have detection/redaction and tracked-dotenv snapshot regressions.

Review 5: #1 Apostrophes in URL userinfo have snapshot/dotenv regressions. #2 The sandbox library preserves process outcomes; gate tests reject SIGTERM/SIGINT cases. #3 Verified pack-transport cloning rejects substituted objects, guarded by the swapped-blob test. #4 Complete-write loops protect ledger entries and heads, with short-write and zero-progress tests. #5 Instance-specific reclaim markers prevent the reported replacement-unlink race, with live-marker and competing-writer tests.

Review 6: #1 Atomic claims under Ledger.transact prevent duplicate concurrent executions, with call/socket/instance/process regressions. #2 Encoded URLs and literal configuration fields are inspected and snapshot-tested. #3 Runner-captured observations and isolated assertions reject premature successful exits, guarded by checks.test.ts.

Review 7: #1 Candidate-written files cannot replace runner-captured observations, guarded by the planted-observation regression. #2 Original YAML block/flow, JSONC, plist and quoted-numeric cases have snapshot regressions.

Review 8: #1 Environment lists, duplicate fields and binary scalars have node-aware inspection and snapshot regressions.

Review 9: #1 Aliased/duplicate environment values retain sensitive-name context, with snapshot regressions. #2 Scoped/unscoped npm _auth fields are inspected and snapshot-tested.

Review 10: #1 Docker authentication is inspected structurally, with snapshot regressions. #2 Bounded YAML merge expansion preserves environment-entry context, with merged-name/value/sequence regressions.

Review 11: #1 Short, long and non-ASCII Docker authentication values have structural inspection and snapshot regressions.

Review 12: #1 XML name/key context reaches associated values and text, with escaped-value and related snapshot regressions.

Review 13: #1 Literal Authorization credentials have header/field inspection and opaque Bearer plus short/long/non-ASCII Basic regressions. #2 Embedded Kubernetes keys have key-field and decoded-base64 inspection, with generated PEM/DER regressions.

Review 14: #1 Arbitrary lowercase Authorization credentials are no longer exempt, with JSON/TypeScript regressions. #2 Private/symmetric JWK material has structural/pattern inspection and generated-key, JWKS, YAML, distant-field and public-key controls.

Review 15: #1 Immediately adjacent INI continuation values are inspected and snapshot-tested; blank/comment interruptions remain vulnerable. #2 Extensionless credential stores and ASIA access-key IDs are inspected, with AWS/.s3cfg snapshot regressions.

I established no new broker approval bypass, protected-gate forgery, concurrent-writer ledger corruption or loss of an acknowledged ledger entry. Broker claims are serialized; ledger entries and heads receive complete writes and fsync before acknowledgment; lagging-head repair precedes extension. Fault tests cover killed writers, competing writers and a killed reclaimer. Current action adapters remain local outbox stubs. The credential leaks below still violate the no-secret workspace boundary.

Supplied revision-linked logs report successful typecheck, 187 passing unit/fault tests, four passing live tests, successful doctor --live and all 106 mutations caught. I independently passed typecheck under Node 24.21.0 and reproduced both findings through the actual createSnapshot routine with filesystem/Git operations substituted in memory. A credential-bearing JSON control was correctly refused. Python ConfigParser independently confirmed the INI continuation semantics. Filesystem-writing and live suites were not rerun in this read-only checkout; tests-first development order is not established by the supplied logs.

### Remaining for stage 0

- Close both credential leaks with snapshot-level regressions and mutation coverage.
- Capture fresh revision-linked verification evidence, obtain a passing independent review, and save the review under docs/reviews/.
- After approval, record at least one valid baseline each for tasks 1, 2 and 11; decision 71 permits second repeats during stage 1.
- Stage 1 separately still requires the user-assisted desktop-app plugin check.

### Findings

#### A1. [high] Blank and comment lines break INI credential continuation inspection

`packages/cli/src/eval/snapshot.ts:558`

**Scenario.** The continuation loop stops at blank or comment lines and discards the sensitive key's context. A tracked settings.ini containing '[database]\npassword =\n    # comment\n    Synthetic9qvM2\n' passes every scanner. A blank line instead of the comment also bypasses inspection. Python ConfigParser retains the continuation as the password value. I reproduced createSnapshot accepting and retaining both files unchanged without allowSecretsIn. Review 15's regression covers only immediately adjacent continuation lines, so a task can still recover a literal credential from a supposedly sanitized snapshot.

**Fix.** Parse supported INI continuation semantics while preserving sensitive-key context across comments and permitted blank lines, or refuse ambiguous sensitive values. Add snapshot regressions for both interruptions and mutation coverage.

#### A2. [high] Source and script files bypass credential-field inspection

`packages/cli/src/eval/snapshot.ts:420`

**Scenario.** findSecretFields returns immediately for ordinary source/script extensions. A tracked config.ts containing 'export const config = { smtp: { password: "Synthetic9qvM2" } };', settings.py containing 'SMTP_PASSWORD = "Synthetic9qvM2"', or settings.sh containing 'SMTP_PASSWORD="Synthetic9qvM2"' matches no remaining token/URL pattern. I reproduced createSnapshot accepting and retaining all three unchanged without allowSecretsIn. These are ordinary literal credential representations; task sessions can read them despite the broker-only credential boundary.

**Fix.** Inspect credential-bearing literal assignments and object fields in source/script files without executing them, or require explicit review for credential-looking literals that cannot be inspected safely. Add snapshot regressions for TypeScript object fields and Python/shell assignments, plus mutation coverage.

## Lane B, structured configuration

Reviewed e9121d421f408d462341c637e6473bd89eae5b44 in lane B. The original configuration-related reproductions are fixed and guarded by assertions in tests/unit/snapshot.test.ts: R1 #5; R2 #1–2; R3 #1; R4 #2; R5 #1; R6 #2; R7 #2; R8 #1; R9 #1–2; R10 #1–2; R11 #1; R12 #1; R13 #1–2; R14 #1–2; R15 #1–2. This confirms those specific fixes, not complete credential protection. The review 15 continuation and extensionless-file fixes remain incomplete for other valid representations identified below.

Every reported reproduction was accepted by the actual createSnapshot function without allowSecretsIn and retained its credential bytes, using filesystem and Git substitutions in memory. INI, XML, plist and escaped JavaScript-key semantics were additionally checked with independent parsers. Typecheck passed independently. Supplied evidence reports 187 passing unit/fault tests, four passing live tests, successful doctor --live and all 106 mutations caught. Filesystem-writing and live suites were not independently rerun in this read-only checkout.

Within this lane, stage 0 does not meet decision 71's proof even excluding baselines, and stage 1 does not meet its no-secret safety proof even excluding the desktop plugin check. No conclusion about ledger concurrency or other lanes is claimed.

### Remaining for stage 0

- Close the configuration credential bypasses below with snapshot-level regressions and mutation coverage.
- Capture fresh revision-linked evidence and obtain passing independent reviews for every decision 77 lane.
- Save this review under docs/reviews/; the review checkout is read-only.
- After approval, record at least one valid baseline each for tasks 1, 2 and 11.

### Findings

#### B1. [high] Common configuration extensions bypass field inspection entirely

`packages/cli/src/eval/snapshot.ts:268`

**Scenario.** Track production.env containing 'DB_PASSWORD=Synthetic9qvM2\n', .my.cnf containing '[client]\npassword=Synthetic9qvM2\n', main.tf containing 'provider "example" {\n api_key = "Synthetic9qvM2"\n}\n', or terraform.tfstate containing '{"resources":[{"instances":[{"attributes":{"password":"Synthetic9qvM2"}}]}]}'. Each passes unchanged. CONFIG_FILE excludes these extensions, and their basenames are not extensionless. Dockerfile.prod with an ordinary ENV API_TOKEN assignment also passes.

**Fix.** Recognize conventional configuration paths and dialects independently of the current extension list. Parse their actual format or require explicit review when credential-bearing configuration cannot be inspected. Add separate snapshot regressions for env files, MySQL configuration, Terraform configuration/state and suffixed container build files.

#### B2. [high] Extensionless structured configurations are treated only as assignment lines

`packages/cli/src/eval/snapshot.ts:422`

**Scenario.** Track .kube/config containing '{"apiVersion":"v1","kind":"Config","users":[{"name":"prod","user":{"token":"Synthetic9qvM2"}}]}'. It passes unchanged because extensionless files never enter structured parsing. A valid compact YAML kubeconfig 'users: [{name: prod, user: {token: Synthetic9qvM2}}]' and .gem/credentials containing '---\n:rubygems_api_key: Synthetic9qvM2\n' also pass.

**Fix.** Infer structured formats for conventional extensionless files and inspect their parsed nodes. Refuse credential-store formats that cannot be inspected. Extend the review 15 regression beyond INI-shaped AWS credentials.

#### B3. [high] Non-XML config and plist dialects silently receive XML-only inspection

`packages/cli/src/eval/snapshot.ts:520`

**Scenario.** Track app.config containing '{"password":"Synthetic9qvM2"}' or '[db]\npassword=Synthetic9qvM2\n'. Both pass because .config returns after XML regex inspection. An OpenStep-format settings.plist containing '{ password = Synthetic9qvM2; }' also passes.

**Fix.** Detect the actual configuration dialect rather than equating these extensions with XML. Parse supported JSON, INI and OpenStep representations, or refuse uninspectable credential-bearing files.

#### B4. [high] Dotenv files skip credential names recognized by the structured scanner

`packages/cli/src/eval/snapshot.ts:678`

**Scenario.** Track .env containing 'DB_PWD=Synthetic9qvM2\n' or .env.production containing 'DB_PASS=Synthetic9qvM2\n'. redactEnvText's SECRET_KEY recognizes neither name, and createSnapshot explicitly skips findSecretFields for dotenv files. Both credentials survive unchanged, although the general field classifier recognizes these names.

**Fix.** Use consistent credential-name classification for dotenv redaction and subsequent validation. Inspect remaining dotenv assignments after redaction rather than exempting the entire file from field inspection.

#### B5. [high] INI colon delimiters without following whitespace evade inspection

`packages/cli/src/eval/snapshot.ts:552`

**Scenario.** Track pip.conf containing '[global]\npassword:Synthetic9qvM2\n'. Python ConfigParser parses password as Synthetic9qvM2, but the scanner requires whitespace, a quote or end-of-line after ':'. createSnapshot accepts the file unchanged.

**Fix.** Implement the supported INI dialect's delimiter semantics, including colon assignments without whitespace. Add a snapshot regression verified against ConfigParser.

#### B6. [high] INI comment stripping discards literal password characters

`packages/cli/src/eval/snapshot.ts:555`

**Scenario.** Track settings.ini containing '[db]\npassword = #Synthetic9qvM2\n' or '[db]\npassword = dummy #Synthetic9qvM2\n'. Default ConfigParser returns the complete values '#Synthetic9qvM2' and 'dummy #Synthetic9qvM2'; inline comments are disabled by default. The scanner skips the first value and truncates the second to the exempt placeholder dummy. Both snapshots pass. A value beginning ';Synthetic9qvM2' also passes.

**Fix.** Do not impose inline-comment semantics across INI/properties dialects that retain these characters. Preserve literal values or inspect every plausible interpretation when the consuming dialect is unknown.

#### B7. [high] INI quote handling drops credential suffixes

`packages/cli/src/eval/snapshot.ts:560`

**Scenario.** Track settings.ini containing '[db]\npassword=""Synthetic9qvM2\n'. ConfigParser returns the literal value '""Synthetic9qvM2'. The scanner keeps only the text between the first and last quote, treats it as empty, and accepts the unchanged file. .npmrc with '_authToken="${TOKEN}"Synthetic9qvM2' also passes the scanner.

**Fix.** Apply format-specific quoting rules and never discard non-comment suffixes after a closing quote. Refuse ambiguous syntax rather than classifying only a convenient substring.

#### B8. [high] Blank lines and comments interrupt INI credential continuation inspection

`packages/cli/src/eval/snapshot.ts:558`

**Scenario.** Track settings.ini containing '[db]\npassword =\n # ignored comment\n Synthetic9qvM2\n', or place a blank line between the assignment and its indented continuation. Default ConfigParser retains the continuation as part of password. The scanner stops at the comment or blank line, judges the initial assignment empty and never associates the later literal with password.

**Fix.** Preserve sensitive-key context across comments and permitted blank lines according to INI continuation semantics. Add regressions extending the review 15 cases with both interruptions.

#### B9. [high] Java-properties key syntax bypasses credential classification

`packages/cli/src/eval/snapshot.ts:552`

**Scenario.** Track application.properties containing 'db.password Synthetic9qvM2\n', 'db.pass\u0077ord=Synthetic9qvM2\n', or 'db.pass\\\nword=Synthetic9qvM2\n'. These use valid properties whitespace separation, Unicode escapes and logical-line continuation respectively. All pass unchanged because the scanner neither parses those separators nor reconstructs and decodes property keys.

**Fix.** Parse Java-properties logical lines, separators and key escapes before inspecting names and values. Add snapshot regressions for each representation.

#### B10. [high] JSON5 fallback does not implement JSON5 key escapes

`packages/cli/src/eval/snapshot.ts:381`

**Scenario.** Track settings.json5 containing '{pass\u0077ord: "Synthetic9qvM2"}', "{'pass\u0077ord':'Synthetic9qvM2'}", or a single-quoted key split with a backslash-newline between pass and word. These decode to a password key under JavaScript/JSON5 semantics. The JSON/YAML fallback either preserves the escape literally or fails without recognizing the fragmented credential name, and createSnapshot accepts each unchanged.

**Fix.** Use a JSON5 parser that exposes decoded keys and preserves duplicates, or reject unsupported JSON5 syntax before accepting the file. Do not treat a YAML parse or a raw-word search as equivalent JSON5 inspection.

#### B11. [high] JSONC trailing-comma removal changes string values before classification

`packages/cli/src/eval/snapshot.ts:326`

**Scenario.** Track config.jsonc containing '{"password":"${TOKEN,}",}'. The final comma requires JSONC normalization. stripJsonc also removes the comma inside the password string, turning the inspected value into the exempt reference '${TOKEN}'. The original literal password '${TOKEN,}' remains on disk and the snapshot passes.

**Fix.** Remove trailing commas through a string-aware tokenizer or a real JSONC parser. Add a regression asserting that normalization never changes string contents.

#### B12. [high] XML mixed text and comments hide password element contents

`packages/cli/src/eval/snapshot.ts:522`

**Scenario.** Track settings.xml containing '<settings><password>Synth<!--comment-->etic9qvM2</password></settings>' or '<settings><password>Synth<![CDATA[etic9qvM2]]></password></settings>'. An XML parser obtains Synthetic9qvM2 in both cases. Neither the plain-text regex nor the CDATA-only regex matches the complete password element, so both snapshots pass.

**Fix.** Inspect parsed XML element text with comments removed and text/CDATA nodes concatenated. Add snapshot regressions for mixed content and comments adjacent to CDATA.

#### B13. [high] Valid XML-plist key and value representations evade the regex scanner

`packages/cli/src/eval/snapshot.ts:521`

**Scenario.** Accepted Info.plist reproductions include '<plist><dict><key>pass&#119;ord</key><string>Synthetic9qvM2</string></dict></plist>', a comment between <key>password</key> and its string value, whitespace in '<key >' and '<string >' tags, a CDATA password key, and '<key>password</key><integer>9372165408</integer>'. Python plistlib recovers a password entry from every example. The scanner misses each.

**Fix.** Parse plist dictionaries and associate decoded keys with their actual typed values. Inspect all credential-bearing value types and permit normal XML whitespace, comments and entity/CDATA representations.

#### B14. [high] XML property names in child elements do not reach their values

`packages/cli/src/eval/snapshot.ts:531`

**Scenario.** Track config.xml containing '<configuration><property><name>db.password</name><value>Synthetic9qvM2</value></property></configuration>'. This conventional Hadoop-style property structure passes unchanged. The scanner transfers context only from name/key attributes, leaving child <name> and <value> elements unrelated.

**Fix.** Recognize supported XML property structures with child name/key and value elements, using parsed XML. Add a snapshot regression for this sibling-element representation.

#### B15. [high] Nested maps discard sensitive parent-field context

`packages/cli/src/eval/snapshot.ts:466`

**Scenario.** Track config.json containing '{"credentials":{"production":"Synthetic9qvM2"}}', config.yaml containing 'password: {value: Synthetic9qvM2}', or config.toml containing '[password]\nproduction = "Synthetic9qvM2"\n'. Each passes. The walkers replace credential-bearing parent context with the ordinary child key, exposing the literal value.

**Fix.** Preserve credential context through credential containers and value wrappers. Distinguish explicitly recognized schema-description structures from actual credential containers instead of resetting context for every map.

#### B16. [high] Kubernetes Secret objects are not recognized as credential containers

`packages/cli/src/eval/snapshot.ts:494`

**Scenario.** Track secret.yaml containing 'apiVersion: v1\nkind: Secret\nstringData:\n  arbitrary: Synthetic9qvM2\n'. It passes unchanged. Using 'data:\n  arbitrary: U3ludGhldGljOXF2TTI=' also passes and decodes directly to the credential. Secret objects nested in kind: List pass as well. Kubernetes permits arbitrary keys here, so checking only password-like leaf names is insufficient.

**Fix.** Recognize Kubernetes Secret structure and inspect or refuse literal data/stringData entries independently of their names. Decode data values and preserve this treatment through lists, aliases and merges.

#### B17. [high] Legacy Docker registry credential maps lack structural protection

`packages/cli/src/eval/snapshot.ts:465`

**Scenario.** Track .dockercfg, or the same content in legacy-docker.json, containing '{"r.acme.net":{"auth":"dTo4azJa","email":"svc@acme.net"}}'. Both pass unchanged. The auth value decodes to u:8k2Z. Legacy Docker configuration has registry entries at the root rather than beneath auths, so the structural safeguard never runs; the generic base64 detector skips this short encoding.

**Fix.** Recognize legacy Docker credential-store paths and root registry/auth maps. Apply credential treatment independently of base64 length, as already done for modern auths entries.

#### B18. [high] Connection-string containers and non-URL DSNs expose embedded passwords

`packages/cli/src/eval/snapshot.ts:432`

**Scenario.** Track appsettings.json containing '{"ConnectionStrings":{"DefaultConnection":"Server=db.prod.acme.net;User Id=svc;Password=Synthetic9qvM2;Database=app"}}'. It passes unchanged. So does '{"database":"host=db.prod.acme.net user=svc password=Synthetic9qvM2 dbname=app"}'. Neither representation is a credential URL or a complete NAME=value line, and the conventional connection-string context is lost.

**Fix.** Recognize connection-string containers and inspect supported semicolon/key-value DSN grammars for literal authentication material. Add ASP.NET and PostgreSQL keyword-DSN snapshot regressions.

#### B19. [high] Serialized credential objects inside configuration strings are not inspected

`packages/cli/src/eval/snapshot.ts:432`

**Scenario.** Track ci.yml containing a step with 'uses: azure/login@v2' and 'with:\n  creds: \'{"clientId":"client","clientSecret":"Synthetic9qvM2","tenantId":"tenant","subscriptionId":"sub"}\''. The YAML scalar contains a complete literal service-principal credential object, but its inner fields are never parsed and creds is not recognized as sensitive. The snapshot passes unchanged.

**Fix.** Inspect conventional serialized credential payloads, including Azure login creds, and parse supported nested configuration strings with bounded recursion. Refuse literal credential containers that cannot be inspected.

#### B20. [high] Reference exemptions accept expressions containing literal credentials

`packages/cli/src/eval/snapshot.ts:296`

**Scenario.** Track ci.yml containing "env:\n  DB_PASSWORD: ${{ 'Synthetic9qvM2' }}\n". The expression evaluates to the literal password, but every expression with this wrapper is exempted. config.json with '{"password":"$(printf Synthetic9qvM2)"}' also passes. Even malformed 'env(Synthetic9qvM2' and a quoted YAML value '"!Sub Synthetic9qvM2"' are accepted as references.

**Fix.** Recognize complete references to external values rather than arbitrary expression wrappers or prefixes. Inspect embedded literals/defaults, and reject malformed or uninspectable expressions under sensitive fields.

#### B21. [high] URL placeholder decoding is incorrectly applied to ordinary configuration passwords

`packages/cli/src/eval/snapshot.ts:299`

**Scenario.** Track config.json containing '{"password":"%24%7BDB_PASSWORD%7D"}'. It passes unchanged because isPlaceholderPassword percent-decodes the ordinary JSON string into '${DB_PASSWORD}' and treats it as a reference. A JSON consumer receives the literal password '%24%7BDB_PASSWORD%7D'; JSON does not perform URL decoding. The same issue accepts '%74est' as the placeholder test.

**Fix.** Make placeholder classification encoding-aware. Percent-decode only actual URL components or formats whose consumers perform that decoding; classify ordinary configuration strings literally.

#### B22. [high] Short numeric and untyped boolean spellings are exempted as credential values

`packages/cli/src/eval/snapshot.ts:441`

**Scenario.** Track config.json containing '{"password":123}' or config.toml containing 'password = 123'. Both pass despite consumers being able to use their text representation as a password/PIN. Separately, settings.ini containing '[db]\npassword=false\n' or 'password=off' passes because isInertUntyped treats the value as a switch; ConfigParser returns these as literal strings.

**Fix.** Do not exempt sensitive scalar values solely because they contain fewer than four digits or resemble booleans in an untyped format. Base exemptions on the consuming format's actual types and explicit non-credential schema.

#### B23. [high] Tool-specific directive grammars bypass assignment-only scanning

`packages/cli/src/eval/snapshot.ts:552`

**Scenario.** Accepted unchanged reproductions include Dockerfile with 'ENV API_TOKEN Synthetic9qvM2', Dockerfile with 'ENV A=1 API_TOKEN=Synthetic9qvM2', redis.conf with 'requirepass Synthetic9qvM2', .curlrc with 'oauth2-bearer = "Synthetic9qvM2"' or 'user = "svc:Synthetic9qvM2"', and .authinfo with 'machine api.acme.net login svc password Synthetic9qvM2'. Each carries a literal authentication value through a conventional tool grammar that the generic line matcher does not understand.

**Fix.** Implement inspection for supported directive-based credential formats, including every assignment in multi-assignment directives, or refuse conventional credential stores pending explicit review. Add independent regressions for Docker, Redis, curl and authinfo.

#### B24. [high] Compact HCL and HOCON objects hide credential assignments inside ordinary values

`packages/cli/src/eval/snapshot.ts:552`

**Scenario.** Track terraform.tfvars containing 'service = { api_key = "Synthetic9qvM2" }\n' or application.conf containing 'database { host = db.prod.acme.net, password = Synthetic9qvM2 }\n'. Both pass unchanged. These extensions reach the scanner, but the line matcher inspects only the first assignment/name and never parses the nested credential field.

**Fix.** Parse supported HCL/HOCON object syntax recursively, or refuse credential-bearing syntax that cannot be inspected. Add compact and multiline object regressions rather than relying on standalone assignment tests.

#### B25. [high] Conventional credential field names remain outside classification

`packages/cli/src/eval/snapshot.ts:274`

**Scenario.** Accepted config.json reproductions include '{"passphrase":"Synthetic9qvM2"}', '{"authKey":"Synthetic9qvM2"}', '{"AccountKey":"Synthetic9qvM2"}', and '{"apiKeys":["Synthetic9qvM2"],"passwords":["Synthetic9qvM2"]}'. These cover passphrases, authentication keys, account keys and plural credential lists. Nested '{"api":{"key":"Synthetic9qvM2"}}' also passes because parent context is discarded.

**Fix.** Cover conventional credential names and plural collections, and use contextual path classification where a generic leaf such as key becomes sensitive. Add snapshot regressions for these concrete names and paths.

#### B26. [high] Literal authentication cookies survive structured request configuration

`packages/cli/src/eval/snapshot.ts:274`

**Scenario.** Track http.json containing '{"headers":{"Cookie":"session=Synthetic9qvM2"}}'. It passes unchanged. A literal session authentication cookie is sufficient to authenticate without a password, but Cookie/Set-Cookie structures receive neither sensitive-field inspection nor cookie-value inspection.

**Fix.** Inspect authentication-bearing cookie configuration, or require explicit review for literal cookie headers. Preserve reference-only forms and add snapshot regressions for session-cookie credentials.

#### B27. [high] Tuple-form HTTP headers lose sensitive-name context

`packages/cli/src/eval/snapshot.ts:460`

**Scenario.** Track request.json containing '{"headers":[["X-Api-Key","Synthetic9qvM2"]]}'. This valid header-pair representation passes unchanged. The array walker treats the header name and value as unrelated scalar elements, although object-form X-Api-Key is correctly rejected.

**Fix.** Recognize supported header name/value tuples and apply credential classification to their associated values. Add tuple-form regressions alongside object-form header tests.

#### B28. [high] Credentials embedded in command-valued configuration are missed

`packages/cli/src/eval/snapshot.ts:435`

**Scenario.** Track ci.yaml containing 'run: "cd app && API_KEY=Synthetic9qvM2 npm run build"\n'. It passes because ENV_ASSIGNMENT only matches an assignment at the beginning of the scalar. A Kubernetes manifest with 'args: ["--password", "Synthetic9qvM2"]' also passes because adjacent credential arguments are never associated.

**Fix.** Inspect supported command/argument representations for literal credential assignments and credential-bearing flags, including assignments after command separators. Refuse ambiguous credential-bearing command syntax rather than assuming it contains references.

#### B29. [high] Commented credential assignments are discarded before structural inspection

`packages/cli/src/eval/snapshot.ts:424`

**Scenario.** Track settings.yaml containing '# password: Synthetic9qvM2\nsettings: true\n', settings.toml containing '# password = "Synthetic9qvM2"\nhost = "prod.acme.net"\n', or settings.jsonc containing a commented password assignment. Each passes unchanged. A still-valid production credential left in a commented alternative configuration remains readable by the task, while parsing discards its credential-name context and generic token patterns do not recognize the opaque value.

**Fix.** Inspect credential-named assignments retained in configuration comments, or require explicit review for ambiguous literal credential examples. Add snapshot regressions proving that commenting out a credential does not make its bytes safe to expose.

## Lane C, encodings and other files

Lane C reviewed revision e9121d421f408d462341c637e6473bd89eae5b44. Twelve high credential-exposure findings block approval; one medium false refusal should enter the backlog.

Prior findings relevant to this lane have fixes and regression assertions for their original concrete reproductions: review 1 #5 (multiline dotenv, URLs, PEM); review 2 #1–2 (comments, size/NUL skips, UTF-16 and JSON URLs); review 3 #1–2 (password exemptions and DER); review 4 #1–2 (short/encrypted PEM and password-only URLs); review 5 #1 (apostrophes); review 6 #2 (escaped configuration credentials); review 13 #1–2 (Authorization and embedded keys); review 14 #1–2 (lowercase Authorization and private JWK). I verified these against snapshot.ts and snapshot.test.ts. Their original cases are guarded, but the broader encoding and non-configuration protections remain incomplete below. Configuration-only and other safety findings belong to the other lanes.

Supplied revision-linked evidence reports successful typecheck, 187 passing unit/fault tests, four passing live tests, successful doctor --live and all 106 mutations caught. I independently passed typecheck and exercised the actual snapshot/scanning logic with filesystem and Git operations substituted in memory. Every exposure below was accepted unchanged without allowSecretsIn. Recovered generated keys successfully signed and verified a challenge. Raw PEM, DER, JWK and standard base64 DER controls were refused. Filesystem-writing and live suites were not rerun in this read-only checkout.

Within this lane, stage 0 does not meet decision 71's proof, excluding baselines. Stage 1's no-secret safety proof also remains incomplete, excluding the user-assisted desktop-app check.

### Remaining for stage 0

- Close the credential exposures below with snapshot-level regressions and mutation coverage, while preserving ordinary non-secret repository content.
- Record the medium false refusal in docs/backlog.md under decision 74.
- Capture fresh revision-linked evidence and obtain passing reviews from all lanes; save the reviews under docs/reviews/.
- After approval, record the required baselines for tasks 1, 2 and 11.

### Findings

#### C1. [high] Literal credentials in source, documentation and notebooks bypass field inspection

`packages/cli/src/eval/snapshot.ts:420`

**Scenario.** findSecretFields returns immediately for ordinary non-configuration extensions. Reproductions accepted unchanged include creds.ts containing `export const password = "Synthetic9qvM2";`, README.md containing `password = Synthetic9qvM2`, generated.py containing `PASSWORD = 'Synthetic9qvM2'`, and a valid analysis.ipynb with that Python assignment in a code cell. A request.http fixture containing `X-API-Key: Synthetic9qvM2` also passes. These literal credentials lack a recognized vendor prefix, URL userinfo or Authorization scheme, so the remaining scanners never identify them.

**Fix.** Inspect explicit credential assignments and fields in supported source, documentation, HTTP fixtures and notebook cells. Preserve language and field context; require targeted review for ambiguous literals rather than exempting entire file classes. Add regressions for each representation.

#### C2. [high] Credential-bearing URL query parameters survive in lockfiles and source

`packages/cli/src/eval/snapshot.ts:190`

**Scenario.** URL inspection recognizes password-bearing userinfo only. A valid yarn.lock with a resolved URL of `https://registry.acme.net/pkg.tgz?token=Synthetic9qvM2` was accepted unchanged; URL.searchParams recovered the token. request.ts containing `fetch("https://api.acme.net/download?api_key=Synthetic9qvM2")` also passed. Services that authenticate downloads or API calls with these query parameters expose their credential to the task.

**Fix.** Inspect literal credential-bearing URL query parameters across file types, including lockfile download URLs. Apply narrow placeholder/reference handling and add snapshot regressions for token, access_token and api_key parameters.

#### C3. [high] Base64url and short wrapped base64 private keys evade decoding

`packages/cli/src/eval/snapshot.ts:206`

**Scenario.** BASE64_BLOB accepts only the standard alphabet and requires an initial run of at least 24 characters. I generated Ed25519 PKCS#8 DER containing '-' or '_' when encoded as base64url; blob.txt containing that encoding was accepted. Standard base64 DER wrapped at 16 characters per line was also accepted. Decoding either retained file and importing it with createPrivateKey produced a working signing key.

**Fix.** Support base64url and valid whitespace-wrapped base64 with bounded decoding independent of the current initial-run requirement. Add generated-key snapshot regressions for URL-safe characters, padding variants and short wrapping.

#### C4. [high] Bare base64 login credentials retain length and ASCII exemptions

`packages/cli/src/eval/snapshot.ts:154`

**Scenario.** Outside structurally recognized Docker/npm/header fields, BASE64_RUN and isBase64UserPassword still miss valid credentials. credential.txt containing base64 of `svc:8k2Z`, `svc:Syñthetic9qvM2`, or `svc:` followed by `q8Zr2vLm0Tx` repeated 37 times was accepted unchanged in separate reproductions. Each retained value decoded to the complete login. The structural fixes for earlier configuration findings do not cover these standalone or embedded non-configuration values.

**Fix.** Remove unjustified length and printable-ASCII exemptions from credential decoding, using credential context and valid text decoding to control false positives. Add short, long and Unicode snapshot regressions outside recognized configuration structures.

#### C5. [high] Decoded base64 content does not receive the complete inspection pipeline

`packages/cli/src/eval/snapshot.ts:217`

**Scenario.** Decoded bytes receive only a DER check or findCredentials over latin1 text. They do not receive recursive decoding, scanViews or field inspection. Separate accepted reproductions were double-base64 PKCS#8 DER, base64 of UTF-16LE PEM, and base64 of `{"password":"Synthetic9qvM2"}`. Both keys remained usable after decoding; the JSON password was recovered exactly. Standard single-layer base64 DER was correctly refused as a control.

**Fix.** Apply one bounded inspection pipeline to decoded payloads, including text encodings, structured credential fields and nested wrappers. Enforce depth and expanded-byte limits. Add snapshot regressions for all three compositions.

#### C6. [high] Hex, base32 and source byte arrays expose private keys

`packages/cli/src/eval/snapshot.ts:677`

**Scenario.** There is no decoding path for these common key representations. A generated Ed25519 PKCS#8 DER key survived unchanged as hexadecimal in blob.txt, RFC 4648 base32 in private.txt, and `const key = Buffer.from([48,...]);` in key.js. Decoding the retained text or evaluating the byte-array initializer recovered a private key that successfully signed and verified a challenge.

**Fix.** Inspect recognizable hex/base32 payloads and supported source byte-array initializers with bounded decoding and private-key detection. Add generated-key regressions and non-secret hash/data controls.

#### C7. [high] Percent decoding is incorrectly conditional on URL punctuation

`packages/cli/src/eval/snapshot.ts:263`

**Scenario.** decodedViews percent-decodes only when the file contains %3a, %2f or %40. notes.md containing every character of `ghp_abcdefghijklmnopqrstuvwxyz0123456789` percent-encoded was accepted unchanged because it contains none of those delimiters. decodeURIComponent recovered the complete recognized token. Thus percent encoding alone defeats a token pattern that otherwise refuses the plaintext.

**Fix.** Inspect valid percent-encoded runs independently of URL delimiters, with bounded decoding and appropriate malformed-input handling. Add a snapshot regression for fully encoded credential prefixes and values.

#### C8. [high] Source literal decoding misses valid escapes and loses authentication context

`packages/cli/src/eval/snapshot.ts:258`

**Scenario.** Separate accepted source reproductions included a JavaScript template literal containing `\x67hp_abcdefghijklmnopqrstuvwxyz0123456789`, a quoted token split using JavaScript backslash-newline continuation, and a Python string expressing the token entirely with octal escapes. I verified the JavaScript values evaluate to the original token. Also, `const h = { Authorization: "\x42earer Synthetic9qvM2" };` passes: decodedViews extracts `Bearer Synthetic9qvM2` without its Authorization field name, so neither view matches the header detector. Evaluation recovered the complete Bearer credential.

**Fix.** Decode supported source literal syntax, including templates, continuations and octal escapes, while retaining surrounding field/assignment context. Add snapshot regressions for each case rather than scanning isolated decoded literals only.

#### C9. [high] Other text encodings are silently treated as clean

`packages/cli/src/eval/snapshot.ts:223`

**Scenario.** scanViews covers UTF-8 and selected NUL-based views only. A generated PEM private key encoded with Python's cp037 EBCDIC codec was accepted unchanged as private.txt; decoding it recovered a working key. A UTF-7 shifted representation, constructed from UTF-16BE base64 between '+' and '-', also passed and recovered the same usable PEM. Neither unsupported encoding triggers review.

**Fix.** Recognize supported additional encodings and refuse identifiable unsupported encoded text that cannot be inspected safely. Feed decoded text through the complete scanner, with regressions for EBCDIC and UTF-7 and controls for ordinary binary assets.

#### C10. [high] Compression and archive members are never inspected

`packages/cli/src/eval/snapshot.ts:675`

**Scenario.** The scanner searches container bytes without unpacking them. Generated-key reproductions accepted unchanged were gzip PEM in blob.gz, zlib DER in blob.bin, Brotli PEM in blob.br, a valid deflated ZIP containing secret.pem, and a valid tar containing secret.der. Decompression or member extraction recovered working signing keys in every case. The tar case also shows that an uncompressed DER member bypasses the top-level-only DER check.

**Fix.** Identify compression/archive formats by content and inspect bounded decompressed members through the full pipeline. Require targeted review for unsupported or encrypted containers. Add regressions covering these formats, nesting limits and harmless archives.

#### C11. [high] Credential containers are protected by suffix rather than content

`packages/cli/src/eval/snapshot.ts:652`

**Scenario.** CREDENTIAL_CONTAINERS applies only to selected filename extensions, while isDerPrivateKey recognizes unencrypted standalone keys only. I reproduced acceptance of a valid unencrypted PuTTY v2 Ed25519 key named identity.txt and an OpenSSL-generated PKCS#12 RSA key container with an empty password named identity.bin. Both yielded working signing keys. Encrypted PKCS#8 DER under key.bin or base64 in key.b64 also passed; supplying the known build passphrase recovered the key.

**Fix.** Recognize private-key/container formats from their content, including PuTTY, PKCS#12 and encrypted PKCS#8, independently of filenames. Require review when encrypted material cannot be inspected. Add genuine generated-container regressions under arbitrary suffixes.

#### C12. [high] Private JWK detection in source depends on quoting and a 1000-character gap

`packages/cli/src/eval/snapshot.ts:131`

**Scenario.** Structural JWK inspection is limited to configuration extensions; source relies on bounded regular expressions. key.ts containing a valid exported Ed25519 JWK with a 1200-character note between kty and d was accepted unchanged. A compact identity.ts object with its d value in a JavaScript template literal also passed because the pattern requires single or double quotes. Importing each retained object as a JWK produced a working signing key. Existing distant-field coverage tests JSON configuration, not source.

**Fix.** Inspect supported source object literals for private/symmetric JWK members without proximity or quote-style assumptions. Add generated-key regressions for distant fields and template literals, retaining public-key controls.

#### C13. [medium] Ordinary base64-encoded public URLs are refused as passwords

`packages/cli/src/eval/snapshot.ts:162`

**Scenario.** isBase64UserPassword interprets any printable `name:rest` as a login. A source file containing the base64 encoding of `https://example.com/guide` was refused with `base64 user:password`: it interprets https as the username and //example.com/guide as the password. This is ordinary public URL data and unnecessarily forces a file-wide allowSecretsIn exception.

**Fix.** Use decoded-content and usage context to distinguish public URI data from authentication material. Add a public-URL acceptance regression alongside the real Basic-auth rejection cases.

## Lane D, safety boundary

Lane D: two high findings block approval: sandbox wrapping reintroduces runner environment secrets, and shared temporary storage permits interference with protected assertions.

1. Prior findings: all 14 original critical/high reproductions in this lane have corresponding fixes and regression assertions. Review 1 #1 is guarded by restricted-mode/tool-list tests and the live malicious-hook negative control; #2 by settings/probe outside-read tests; #3 by web-tool exclusion and denial tests; #4 by baseline preflight rejection tests; #6 by network positive controls, denial-record assertions and live negative controls. Review 2 #3 has private-cache isolation/deletion tests; #4 has host-specific failure regressions. Review 5 #2 has signal-outcome tests; #3 has the substituted-object regression; #4 has short-write/zero-progress tests; #5 has reclamation and competing-writer tests. Review 6 #1 has concurrent broker call/socket/instance/process tests; #3 and review 7 #1 have early-exit and fabricated-observation regressions. Removing the corresponding protections would fail those assertions. Scanner findings belong to the other lanes.

2. I established no concurrent-writer ledger corruption or loss of an acknowledged entry. Complete writes, fsync, serialized transactions and head repair support those guarantees. A new recovery-availability defect remains below. Existing broker adapters are local outbox stubs.

3. The examined stage 0 Claude envelope has fixes and evidence for its original findings, but the combined review cannot pass. Stage 1 does not meet its safety proof because candidate code can receive runner secrets and can interfere with verifier scratch files. Baselines and the user-assisted desktop check remain outside this assessment.

Evidence: supplied logs report successful typecheck, 187 passing unit/fault tests, four passing live tests and all 106 mutations caught. I independently passed typecheck using Node 24.21.0 and performed read-only wrapper and in-memory reproductions. Filesystem-writing/live suites and the complete shared-temporary-file gate exploit were not rerun in this read-only checkout. The logs do not establish tests-first development order.

### Remaining for stage 0

- Fix both high findings, add regressions and mutation coverage, and capture fresh revision-linked evidence before approval.
- Record the medium and low findings in docs/backlog.md under decision 74.
- Save this lane's review and obtain passing verdicts from every review lane.
- After approval, record the required baselines for tasks 1, 2 and 11. Stage 1 separately requires the user-assisted desktop plugin check.

### Findings

#### D1. [high] Sandbox wrapping restores runner secrets omitted from the clean environment

`packages/cli/src/sandbox/srt.ts:46`

**Scenario.** runSandboxed supplies r.env only after asking the library to construct its wrapper in the runner process. The pinned sandbox-runtime reads process.env.JAVA_TOOL_OPTIONS and embeds its value as an explicit environment assignment in that wrapper. I set a synthetic parent value of -Djavax.net.ssl.keyStorePassword=ReviewSyntheticSecret and reproduced the generated command containing that complete secret. Candidate code can run printenv JAVA_TOOL_OPTIONS even though r.env omits the variable. Both gate phases use this path, bypassing decision 58's environment allowlist and the broker-only credential boundary.

**Fix.** Construct sandbox wrappers in a helper process with an explicitly sanitized environment, or use a verified library credential policy that prevents inherited values from being restored. Test the effective sandbox child environment with a synthetic secret in the runner's JAVA_TOOL_OPTIONS, and mutation-test removal of the protection.

#### D2. [high] Shared temporary storage lets surviving candidate code alter verifier assertions

`packages/cli/src/sandbox/srt.ts:23`

**Scenario.** The library adds /tmp/claude and /private/tmp/claude to writable roots and overrides the private TMPDIR values supplied by runGate with TMPDIR=/tmp/claude. I reproduced those defaults for both candidate and verifier policies. A concrete gate reproduction is: candidate output is value=41, while it launches a detached daemon with redirected stdio that watches this shared directory and replaces assertion scratch files with value=42. The protected verifier uses mktemp "$TMPDIR/assert.XXXXXXXX", copies main/stdout there, then checks that temporary file after further work. The daemon survives the documented process-group cleanup limitation and can rewrite that file; the trusted verifier then passes and prints the genuine completion nonce. Thus backlog #13's claim that such a daemon cannot forge a pass does not hold.

**Fix.** Give each phase genuinely separate temporary storage, prevent the wrapper from overriding it, and explicitly deny candidate access to verifier temporary storage and shared library defaults. Add a full gate regression using a surviving daemon and verifier scratch files; incorrect recorded output must fail.

#### D3. [medium] Starting another broker replaces an active project's socket

`packages/cli/src/broker/server.ts:7`

**Scenario.** Start brokers for projects A and B at the CLI's shared default socket. B unconditionally unlinks A's active socket and binds the same pathname. A's existing task sandbox permits that pathname, so its next request reaches B and is evaluated using B's ledger, grants and adapters. An in-memory reproduction using the actual server and broker code returned succeeded under B's production grant for a request sent to A's original socket. Closing A also removes B's socket at line 45. Current adapters limit the immediate impact to incorrect outbox actions and availability.

**Fix.** Use project/run-specific socket paths and refuse to replace a live listener. Reclaim only verified stale sockets, and unlink on close only if the pathname still identifies that server's socket. Add simultaneous-project and stale-close regressions.

#### D4. [medium] Later approval answers override the first decision

`packages/cli/src/broker/broker.ts:118`

**Scenario.** decide always appends another answer for an existing request, and claim uses the last answer. Using the actual Broker with an in-memory ledger, I rejected a request, observed rejected, then approved the same approvalId and observed succeeded with one adapter execution. This contradicts decision 50's first-valid-answer policy and permits a delayed contradictory answer to reverse the settled decision. The check and decision write are also separate operations.

**Fix.** Resolve pending approvals atomically under Ledger.transact and ignore or reject subsequent answers. Provide an explicit separate operation for intentional decision changes if needed. Test contradictory sequential and concurrent answers.

#### D5. [medium] Nested reclamation markers eventually exceed the filename limit

`packages/cli/src/ledger/ledger.ts:347`

**Scenario.** Each recursive marker appends .reclaim. plus a generated 24-character nonce to the same filename. A dead lock with seven stranded nested markers has a longest basename of 242 bytes; recovering the deepest marker attempts a 275-byte basename, exceeding macOS's 255-byte component limit. I reproduced ENAMETOOLONG through the actual Ledger using an in-memory filesystem enforcing that limit. Every subsequent append encounters the same state and fails, requiring manual recovery. Acknowledged entries remain intact.

**Fix.** Use bounded-length marker names while preserving ownership and instance binding, or adopt a crash-released locking primitive. Add repeated-reclaimer-crash tests using production-length nonces through the filesystem component limit.

#### D6. [medium] Filtered mutation runs falsely report complete coverage

`scripts/mutation-check.mjs:225`

**Scenario.** The loop filters mutations using JARVIS_MUTATIONS, but the final success message always uses mutations.length. With JARVIS_MUTATIONS=^no-such-mutation$, a clean control run executes no mutations yet prints all 106 mutations caught and exits 0. I reproduced this by evaluating the actual script with filesystem/process operations substituted in memory. A retained debugging filter can therefore produce misleading proof. The supplied full log contains individual catches and is not invalidated by this defect.

**Fix.** Track selected, executed and caught counts; reject an empty selection and clearly mark partial runs. Allow a complete-proof result only when every declared mutation executed and was caught. Add zero-match and subset regressions.

#### D7. [medium] Observation limits are checked after unbounded capture, hashing and copying

`packages/cli/src/checks/gate.ts:154`

**Scenario.** Candidate stdout/stderr are captured without a byte limit, then read entirely into memory by sha. The gate subsequently copies all observations before checking the 16 MiB cap, and still launches verification when over the cap. A case emitting hundreds of megabytes or gigabytes before its timeout can therefore force large runner allocations and duplicate disk consumption instead of being stopped near the advertised limit.

**Fix.** Enforce aggregate byte limits while capturing output, terminate the process on overflow, and record an explicit failed gate. Check sizes before hashing or copying and skip verification after overflow. Add a bounded oversized-output regression.

#### D8. [low] Doctor accepts missing or empty plugin hook registrations

`packages/cli/src/doctor/foundation.ts:64`

**Scenario.** With the manifest and tripwire file present, hooks.json containing only {"hooks":{"PreToolUse":[]}} satisfies this condition. Doctor reports that tripwire and SessionStart hooks are present even though neither hook is registered and session-start.mjs need not exist. Removing SessionStart from the current plugin likewise leaves this check passing.

**Fix.** Validate nonempty hook registrations, their expected commands and required script files. Add regressions for missing SessionStart and empty PreToolUse registrations.

## Builder response

See `stage0-codex-16-response.md`.
