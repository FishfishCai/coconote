// Shared "Cancel + primary action" modal footer (sync push/pull, merge
// view, PDF comment/anchor dialogs). Rendered DOM and CSS classes stay
// identical to the original call sites so existing stylesheets keep
// matching: `variant` picks the modal or pdf class family.

import type { JSX } from "preact";

type Variant = "modal" | "pdf";

const VARIANTS: Record<
  Variant,
  { wrapper: string; cancel?: string; primary: string }
> = {
  modal: { wrapper: "coconote-modal-actions", primary: "coconote-modal-primary" },
  pdf: {
    wrapper: "coconote-pdf-comment-actions",
    cancel: "coconote-pdf-comment-cancel",
    primary: "coconote-pdf-comment-save",
  },
};

export function ModalActions({
  onCancel,
  cancelLabel = "Cancel",
  onConfirm,
  confirmLabel,
  busy = false,
  disabled = false,
  confirmTitle,
  variant = "modal",
}: {
  onCancel(): void;
  cancelLabel?: string;
  onConfirm(): void;
  /** Primary button label (already includes any busy copy, e.g.
   *  "Pushing..."). */
  confirmLabel: JSX.Element | string;
  /** Disables the Cancel button (used while a request is in flight). */
  busy?: boolean;
  /** Disables the primary button. */
  disabled?: boolean;
  /** Optional tooltip for the primary button. */
  confirmTitle?: string;
  /** Class family: `modal` (default) emits the `coconote-modal-*` bar,
   *  `pdf` the `coconote-pdf-comment-*` bar used by the PDF dialogs. */
  variant?: Variant;
}) {
  const v = VARIANTS[variant];
  return (
    <div className={v.wrapper}>
      <button
        type="button"
        className={v.cancel}
        onClick={onCancel}
        disabled={busy}
      >
        {cancelLabel}
      </button>
      <button
        type="button"
        className={v.primary}
        disabled={disabled}
        onClick={onConfirm}
        title={confirmTitle}
      >
        {confirmLabel}
      </button>
    </div>
  );
}
