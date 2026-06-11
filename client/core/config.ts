// Tiny key-value store backed by `coconote.yaml`. `get` / `set` accept
// dotted keys or string arrays.
type Json = Record<string, unknown>;

export class Config {
  constructor(public values: Json = {}) {}

  public clear() {
    this.values = {};
  }

  get<T = unknown>(key: string | string[], def?: T): T {
    const path = typeof key === "string" ? key.split(".") : key;
    let cur: unknown = this.values;
    for (const k of path) {
      if (cur == null || typeof cur !== "object") return def as T;
      cur = (cur as Json)[k];
    }
    return (cur === undefined ? def : cur) as T;
  }

  set(key: string | string[], value: unknown): void {
    const path = typeof key === "string" ? key.split(".") : key;
    if (path.length === 0) return;
    let cur: Json = this.values;
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i];
      const next = cur[k];
      if (next == null || typeof next !== "object") cur[k] = {};
      cur = cur[k] as Json;
    }
    cur[path[path.length - 1]] = value;
  }
}
