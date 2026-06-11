// Authorization-injecting fetch wrapper for code paths outside
// HttpSpacePrimitives (PdfViewer, HistoryPanel, RemoteVaults probe,
// settings). Token is set once at boot (client/core/client.ts) and
// held in module state — no per-fetch storage hit.

let authToken: string | undefined;

export function setAuthToken(token: string | undefined): void {
  authToken = token;
}

export function getAuthToken(): string | undefined {
  return authToken;
}

/**
 * `fetch` with Authorization injection. Caller-supplied Authorization
 * headers are RESPECTED (not overwritten) so the rare case of a
 * per-request token still works.
 */
export async function authedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (!authToken) return fetch(input, init);
  const h = new Headers(init?.headers ?? {});
  if (!h.has("Authorization")) {
    h.set("Authorization", `Bearer ${authToken}`);
  }
  return fetch(input, { ...init, headers: h });
}
