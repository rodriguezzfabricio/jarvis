/** HTTPS only, no redirects, bounded bytes and wall time, including a stalled response body. */
export async function requestRenderMarker(url: string, fetch: typeof globalThis.fetch = globalThis.fetch, timeoutMs = 10_000): Promise<{ status: number; hash: string | undefined }> {
  if (!/^https:\/\/[a-z0-9][a-z0-9-]*\.onrender\.com$/.test(url)) throw new Error("Render origin required");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    const response = await fetch(`${url}/.jarvis-build.json`, { redirect: "manual", signal: controller.signal, cache: "no-store" });
    if (response.status !== 200 || !response.body) { void response.body?.cancel().catch(() => {}); return { status: response.status, hash: undefined }; }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength; if (size > 4096) return { status: response.status, hash: undefined };
        chunks.push(part.value);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { manifestHash?: unknown };
      return { status: response.status, hash: typeof value?.manifestHash === "string" && /^[a-f0-9]{64}$/.test(value.manifestHash) ? value.manifestHash : undefined };
    } finally { void reader.cancel().catch(() => {}); }
  };
  try {
    return await Promise.race([read(), new Promise<{ status: number; hash: undefined }>(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ status: 0, hash: undefined }); }, timeoutMs); })]);
  } catch { return { status: 0, hash: undefined }; }
  finally { clearTimeout(timer); controller.abort(); }
}
export async function readRenderMarker(url: string, fetch: typeof globalThis.fetch = globalThis.fetch, timeoutMs = 10_000): Promise<string | undefined> {
  return (await requestRenderMarker(url, fetch, timeoutMs)).hash;
}
export async function waitForRender(url: string, hash: string, options: { fetch?: typeof globalThis.fetch; timeoutMs?: number; intervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): Promise<boolean> {
  const timeout = options.timeoutMs ?? 180_000, interval = options.intervalMs ?? 1000;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 600_000 || !Number.isFinite(interval) || interval <= 0 || interval > timeout) throw new Error("invalid Render readiness limits");
  const now = options.now ?? Date.now, sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + timeout;
  // The attempt cap also bounds a faulty injected clock.
  for (let attempt = 0; attempt <= Math.ceil(timeout / interval) && now() < deadline; attempt++) {
    if (await readRenderMarker(url, options.fetch, Math.min(10_000, deadline - now())) === hash) return true;
    if (now() < deadline) await sleep(Math.min(interval, deadline - now()));
  }
  return false;
}
