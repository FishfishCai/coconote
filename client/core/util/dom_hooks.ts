// Tiny Preact hooks + small DOM utilities. Extracted from per-
// component duplications so a single fix lands everywhere.

import { useEffect, useRef } from "preact/hooks";

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
