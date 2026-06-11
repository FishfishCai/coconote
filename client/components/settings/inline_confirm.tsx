// The inline remove-confirm control shared by the Local and Remote
// settings lists: a `−` button that, when armed, swaps in place for a
// "Remove?" prompt with Yes/No buttons. Extracted byte-for-byte so the
// existing `coconote-pages-remove*` CSS applies unchanged to both.
//
// `active` is owned by the caller (it tracks which row is currently
// armed), so this stays a pure render of one of the two states. Click
// propagation is stopped on the inner controls because in the Local
// list the surrounding root head is itself clickable (expand/collapse).

type Props = {
  /** Whether this row's confirm prompt is currently showing. */
  active: boolean;
  /** Tooltip for the `−` button (e.g. "Remove this root"). */
  title: string;
  /** Prompt label shown when armed (e.g. "Remove?"). */
  prompt: string;
  /** Arm the prompt (caller flips `active` to true). */
  onRequest(): void;
  /** Confirm the removal. */
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
