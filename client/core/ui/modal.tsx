// The single modal base for the whole app, built on native <dialog>:
// top-layer rendering, dimmed ::backdrop, Esc-to-close and focus trap
// for free (no overlay divs or z-index juggling). `title` renders an
// immediate header so async content fills in, `loading` a placeholder.

import { useEffect, useRef } from "preact/hooks";
import type { ComponentChildren } from "preact";

export type ModalSize = "small" | "default" | "large" | "wide";

export function Modal({
  title,
  onClose,
  loading = false,
  size = "default",
  className,
  children,
}: {
  /** Header content. Omit for a chrome-less box (Prompt / Confirm). */
  title?: ComponentChildren;
  onClose: () => void;
  loading?: boolean;
  size?: ModalSize;
  /** Extra class on the dialog box for per-popup tweaks. */
  className?: string;
  children?: ComponentChildren;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      class={`coconote-modal coconote-modal-${size}${className ? ` ${className}` : ""}`}
      // Esc fires the native cancel event.
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // A click landing on the dialog element itself is a backdrop click
      // (the body fills the box, so content clicks target inner nodes).
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      // Keep editor / global shortcuts from firing while a modal is open.
      onKeyDown={(e) => e.stopPropagation()}
    >
      {title !== undefined && (
        <header class="coconote-modal-header">
          <span class="coconote-modal-title">{title}</span>
          <button
            type="button"
            class="coconote-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>
      )}
      <div class="coconote-modal-body">
        {loading ? <div class="coconote-modal-loading">Loading…</div> : children}
      </div>
    </dialog>
  );
}
