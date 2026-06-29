/** JSON.parse that returns undefined instead of throwing on bad input.
 *  The single home for the "parse or fall back" idiom scattered across
 *  localStorage / config readers. */
export function safeJsonParse<T = unknown>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
