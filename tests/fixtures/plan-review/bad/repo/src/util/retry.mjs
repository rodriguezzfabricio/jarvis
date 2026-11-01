// Retries an async operation with exponential backoff: 3 attempts, 50 ms base.
export async function retry(operation, attempts = 3, baseMs = 50) {
  let error;
  for (let i = 0; i < attempts; i++) {
    try { return await operation(); }
    catch (caught) { error = caught; await new Promise((resolve) => setTimeout(resolve, baseMs * 2 ** i)); }
  }
  throw error;
}
