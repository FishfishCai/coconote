// One source of UUIDs so a fallback (e.g. for `file://` contexts where
// `crypto.randomUUID` is undefined) lands in one place.
export function newUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Math.random fallback - only collision-safe enough for per-user note
  // ids, not for security tokens. Same shape as randomUUID for v4.
  const hex = (n: number) => Math.floor(Math.random() * n).toString(16);
  const part = (n: number) => Array.from({ length: n }, () => hex(16)).join("");
  return `${part(8)}-${part(4)}-4${part(3)}-${["8","9","a","b"][Math.floor(Math.random()*4)]}${part(3)}-${part(12)}`;
}
