// Tiny Preact hooks + small DOM utilities. Extracted from per-
// component duplications so a single fix lands everywhere.

import { useEffect, useRef, useState } from "preact/hooks";

/** Close-on-outside-click + Escape. Wires listeners on the next
 *  tick so the event that opened the overlay doesn't immediately
 *  fire as the dismissal click. A ref forwards each render's onClose
 *  so callers can pass a fresh closure without resubscribing. */
export function useDismissOnOutside(onClose: () => void): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const off = () => onCloseRef.current();
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    const id = window.setTimeout(() => {
      document.addEventListener("click", off);
      document.addEventListener("contextmenu", off);
      window.addEventListener("keydown", onEsc);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("click", off);
      document.removeEventListener("contextmenu", off);
      window.removeEventListener("keydown", onEsc);
    };
  }, []);
}

/** Serialiser for `useLocalStorageState`. Defaults to JSON; supply
 *  a custom pair when storing a non-JSON-native shape (e.g. Set).
 *  parse returns undefined on bad input so the caller falls back
 *  to `initial`. */
export type Codec<T> = {
  parse: (raw: string) => T | undefined;
  stringify: (value: T) => string;
};

const jsonCodec: Codec<unknown> = {
  parse: (raw) => {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  },
  stringify: (v) => JSON.stringify(v),
};

/** Built-in Set<string> codec. JSON.stringify(Set) emits "{}", so a
 *  caller storing Sets must opt in here. */
export const stringSetCodec: Codec<Set<string>> = {
  parse: (raw) => {
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? new Set<string>(arr) : undefined;
    } catch {
      return undefined;
    }
  },
  stringify: (s) => JSON.stringify([...s]),
};

/** localStorage-backed useState. Lazy initial so each mount parses
 *  once; quota / disabled storage fail silently. */
export function useLocalStorageState<T>(
  key: string,
  initial: () => T,
  codec: Codec<T> = jsonCodec as Codec<T>,
): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return initial();
      const parsed = codec.parse(raw);
      return parsed === undefined ? initial() : parsed;
    } catch {
      return initial();
    }
  });
  const update = (next: T | ((prev: T) => T)) => {
    setValue((prev) => {
      const v = typeof next === "function"
        ? (next as (p: T) => T)(prev)
        : next;
      try {
        localStorage.setItem(key, codec.stringify(v));
      } catch { /* quota / disabled */ }
      return v;
    });
  };
  return [value, update];
}
