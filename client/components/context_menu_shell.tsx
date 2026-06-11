// Shared wrapper for the content-browser context menus: dismiss on
// outside click / Escape, clamp the (x, y) anchor to the viewport so
// edge right-clicks don't push the menu off-screen, swallow clicks /
// native context-menu inside the box. (PDF menus still hand-roll this.)

import type { ComponentChildren } from "preact";
import { useMenuPosition } from "../lib/menu_position.ts";
import { useDismissOnOutside } from "../lib/dom_hooks.ts";

type Props = {
  x: number;
  y: number;
  onClose(): void;
  children: ComponentChildren;
};

export function ContextMenuShell({ x, y, onClose, children }: Props) {
  useDismissOnOutside(onClose);
  const { ref, x: mx, y: my } = useMenuPosition(x, y);
  return (
    <div
      ref={ref}
      className="coconote-context-menu"
      style={{ left: `${mx}px`, top: `${my}px` }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>
  );
}
