// Shared "Cancel + primary action" modal footer. Several modals (sync
// push/pull, the merge view, and the PDF comment/anchor dialogs) all
// render the same two-button bar: a neutral Cancel on the left and a
// single primary action on the right. This component centralizes that
// markup while keeping the rendered DOM and CSS classes identical to
// each call site, so existing stylesheets keep matching.
//
// Most sites use the `coconote-modal-actions` / `coconote-modal-primary`
// classes. The PDF dialogs use a different class family
// (`coconote-pdf-comment-actions` / `-cancel` / `-save`); the `variant`
// prop selects that family without changing any rendered class.

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
   *  "Pushing…"). */
  confirmLabel: JSX.Element | string;
  /** Disables the Cancel button (used while a request is in flight). */
  busy?: boolean;
  /** Disables the primary button. */
  disabled?: boolean;
  /** Optional tooltip for the primary button. */
  confirmTitle?: string;
  /** Which class family to emit. `modal` is the default
   *  `coconote-modal-*` bar; `pdf` emits the `coconote-pdf-comment-*`
   *  bar used by the PDF dialogs. */
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
