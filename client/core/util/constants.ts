export const offlineError: Error = new Error("Offline");
export const notFoundError: Error = new Error("Not found");
export const notAuthenticatedError: Error = new Error("Unauthenticated");
export const pingTimeout: number = 2000;

/** Narrow an `unknown` caught value to a printable message. */
export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

// Browser-specific offline error messages vary (Firefox "NetworkError",
// Safari "Load failed", Chrome "Failed to fetch") - match all of them.
export function isNetworkError(e: unknown): boolean {
  const msg = errMessage(e).toLowerCase();
  return (
    msg.includes("fetch") ||
    msg.includes("load failed") ||
    msg.includes("networkerror") ||
    msg.includes("unavailable")
  );
}
