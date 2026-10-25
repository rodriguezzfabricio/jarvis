/** Task policies name exact hosts. Local services need runner ownership, which no task runner supplies yet. */
export function assertTaskDomains(domains: unknown): asserts domains is readonly string[] {
  if (!Array.isArray(domains)) throw new Error("invalid allowed domains: expected an array");
  for (const domain of domains) {
    const fail = () => { throw new Error(`invalid allowed domain: ${String(domain)}; use an exact public host (local services require runner ownership)`); };
    if (typeof domain !== "string" || domain.includes("*")) fail();
    const match = /^([a-z0-9.-]+)(?::([0-9]+))?$/i.exec(domain);
    if (!match) fail();
    const host = match![1]!;
    const port = match![2];
    if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) fail();
    if (host.length > 253 || host.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) fail();
    // URL canonicalizes integer, hex, octal and abbreviated IPv4 spellings before the local check.
    let canonical: string;
    try {
      canonical = new URL(`http://${domain}`).hostname.toLowerCase();
    } catch {
      fail();
      return;
    }
    if (isLocalHost(canonical)) fail();
  }
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host === "localhost.localdomain"
    || host === "ip6-localhost" || host === "ip6-loopback" || host.startsWith("127.") || host === "0.0.0.0";
}
