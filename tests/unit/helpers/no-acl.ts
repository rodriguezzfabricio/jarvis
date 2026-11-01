// The ACL listing of a path that has no ACL, in the shape `/bin/ls -lde` prints it: one line, owner first.
// It goes in the `acl` seam (SetupDeps.acl, TrustOptions.acl) of tests that are not about ACLs. Without it,
// every trusted-folder check starts a real /bin/ls (about 5 ms of CPU each), and the setup tests did about
// 7,000 of them. What the real listing does with a real ACL stays covered by setup-acl.test.ts, which feeds
// the check every ACL shape and has a live test of /bin/ls itself.
export const noAcl = (path: string): string => `drwx------  2 tester  staff  64 Jan  1 00:00 ${path}\n`;
