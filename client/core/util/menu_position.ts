// Clamp a context-menu's (x, y) to the viewport. The menu is
// position:fixed and laid out from its top-left corner, so a click
// near the right edge would put the menu off-screen. After mount we
// measure the menu's bounding box and shift it left / up as needed.

import { useLayoutEffect, useRef, useState } from "preact/hooks";

const MARGIN = 6; // breathing room from the viewport edge.

/** Returns a ref to attach to the menu element + a clamped {x, y}. */
export function useMenuPosition(rawX: number, rawY: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number }>({
    x: rawX,
    y: rawY,
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const recompute = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // Clamp to viewport edge when the menu would overflow.
      let x = rawX;
      if (x + w + MARGIN > vw) x = Math.max(MARGIN, vw - w - MARGIN);
      let y = rawY;
      if (y + h + MARGIN > vh) y = Math.max(MARGIN, vh - h - MARGIN);
      setPos((prev) => (prev.x === x && prev.y === y ? prev : { x, y }));
    };
    recompute();
    // Reclamp when children mount async / fonts swap / window resizes.
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rawX, rawY]);

  return { ref, x: pos.x, y: pos.y };
}
