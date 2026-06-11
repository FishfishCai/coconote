// Inline remove-confirm for the Local/Remote settings lists: a minus
// button that arms into an in-place "Remove?" Yes/No prompt (markup
// keeps the `coconote-pages-remove*` classes). Caller owns `active`.
// Inner clicks stop propagating: the Local root head is itself clickable.

type Props = {
  /** Whether this row's confirm prompt is currently showing. */
  active: boolean;
  /** Tooltip for the minus button (e.g. "Remove this root"). */
  title: string;
  /** Prompt label shown when armed (e.g. "Remove?"). */
  prompt: string;
  /** Arm the prompt (caller flips `active` to true). */
  onRequest(): void;
  onConfirm(): void;
  /** Dismiss the prompt without removing. */
  onCancel(): void;
};

export function InlineConfirm(
  { active, title, prompt, onRequest, onConfirm, onCancel }: Props,
) {
  if (!active) {
    return (
      <button
        type="button"
        className="coconote-pages-remove"
        title={title}
        onClick={(e) => {
          e.stopPropagation();
          onRequest();
        }}
      >
        −
      </button>
    );
  }
  return (
    <span
      className="coconote-pages-remove-confirm"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="coconote-pages-remove-prompt">{prompt}</span>
      <button type="button" className="danger" onClick={() => onConfirm()}>
        Yes
      </button>
      <button type="button" onClick={() => onCancel()}>
        No
      </button>
    </span>
  );
}
