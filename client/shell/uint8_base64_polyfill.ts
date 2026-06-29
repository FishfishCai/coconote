// TC39 Stage-3 polyfills pdf.js v6 depends on. Electron 36 / Chromium 136
// ships without some, killing PDF open ("a.toHex is not a function").
// Each shim guards on `typeof !== "function"` so native wins where it
// exists. Proposals: tc39/proposal-arraybuffer-base64, tc39/proposal-upsert.

declare global {
  interface Uint8Array {
    toHex(): string;
    toBase64(options?: { alphabet?: "base64" | "base64url" }): string;
  }
  interface Uint8ArrayConstructor {
    fromHex(hex: string): Uint8Array;
    fromBase64(
      base64: string,
      options?: { alphabet?: "base64" | "base64url" },
    ): Uint8Array;
  }
  interface Map<K, V> {
    getOrInsert(key: K, defaultValue: V): V;
    getOrInsertComputed(key: K, callbackfn: (key: K) => V): V;
  }
  interface WeakMap<K extends WeakKey, V> {
    getOrInsert(key: K, defaultValue: V): V;
    getOrInsertComputed(key: K, callbackfn: (key: K) => V): V;
  }
  interface Math {
    sumPrecise(iterable: Iterable<number>): number;
  }
}

const proto = Uint8Array.prototype as unknown as Record<string, unknown>;
const ctor = Uint8Array as unknown as Record<string, unknown>;

if (typeof proto.toHex !== "function") {
  proto.toHex = function toHex(this: Uint8Array): string {
    let out = "";
    for (let i = 0; i < this.length; i++) {
      const b = this[i];
      out += (b < 16 ? "0" : "") + b.toString(16);
    }
    return out;
  };
}

if (typeof ctor.fromHex !== "function") {
  ctor.fromHex = function fromHex(hex: string): Uint8Array {
    if (hex.length % 2 !== 0) {
      throw new SyntaxError("Uint8Array.fromHex: input length must be even");
    }
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      const v = parseInt(hex.substr(i * 2, 2), 16);
      if (Number.isNaN(v)) {
        throw new SyntaxError("Uint8Array.fromHex: non-hex character");
      }
      out[i] = v;
    }
    return out;
  };
}

if (typeof proto.toBase64 !== "function") {
  proto.toBase64 = function toBase64(
    this: Uint8Array,
    options?: { alphabet?: "base64" | "base64url" },
  ): string {
    // btoa wants a binary string - chunk to avoid String.fromCharCode
    // stack-overflowing on large buffers.
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < this.length; i += CHUNK) {
      bin += String.fromCharCode(...this.subarray(i, i + CHUNK));
    }
    const b64 = btoa(bin);
    if (options?.alphabet === "base64url") {
      return b64.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    }
    return b64;
  };
}

if (typeof ctor.fromBase64 !== "function") {
  ctor.fromBase64 = function fromBase64(
    input: string,
    options?: { alphabet?: "base64" | "base64url" },
  ): Uint8Array {
    let s = input;
    if (options?.alphabet === "base64url") {
      s = s.replaceAll("-", "+").replaceAll("_", "/");
      while (s.length % 4) s += "=";
    }
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
}

// Map / WeakMap upsert helpers. Same shape for both - guard each
// separately to handle engines that ship one method but not the other.
const mapProto = Map.prototype as unknown as Record<string, unknown>;
const weakMapProto = WeakMap.prototype as unknown as Record<string, unknown>;

function patchUpsert(proto: Record<string, unknown>) {
  if (typeof proto.getOrInsert !== "function") {
    proto.getOrInsert = function getOrInsert(
      this: Map<unknown, unknown>,
      key: unknown,
      defaultValue: unknown,
    ): unknown {
      if (this.has(key)) return this.get(key);
      this.set(key, defaultValue);
      return defaultValue;
    };
  }
  if (typeof proto.getOrInsertComputed !== "function") {
    proto.getOrInsertComputed = function getOrInsertComputed(
      this: Map<unknown, unknown>,
      key: unknown,
      callbackfn: (key: unknown) => unknown,
    ): unknown {
      if (this.has(key)) return this.get(key);
      const value = callbackfn(key);
      this.set(key, value);
      return value;
    };
  }
}
patchUpsert(mapProto);
patchUpsert(weakMapProto);

// Math.sumPrecise - TC39 Stage 3, accurate summation of an iterable of
// numbers (kahan-style, the spec mandates no rounding error).
const mathObj = Math as unknown as Record<string, unknown>;
if (typeof mathObj.sumPrecise !== "function") {
  // Neumaier compensated summation - gives the spec-mandated
  // double-precision result for typical inputs. pdf.js uses this to
  // sum glyph widths, so a tiny imprecision is benign.
  mathObj.sumPrecise = function sumPrecise(iterable: Iterable<number>): number {
    let sum = 0;
    let c = 0;
    for (const v of iterable) {
      const num = Number(v);
      const t = sum + num;
      if (Math.abs(sum) >= Math.abs(num)) {
        c += sum - t + num;
      } else {
        c += num - t + sum;
      }
      sum = t;
    }
    return sum + c;
  };
}

export {};
