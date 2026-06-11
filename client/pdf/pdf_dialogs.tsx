// Presentational PDF-viewer dialogs: highlight right-click menu and the
// comment / anchor input modals. Themed shells instead of
// window.prompt/alert: Electron no-ops window.prompt, so prompt-based
// flows would silently fail in the desktop build.

import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { useMenuPosition } from "../lib/menu_position.ts";
import { useDismissOnOutside } from "../lib/dom_hooks.ts";
import { ModalActions } from "../components/modal_actions.tsx";
import { Modal } from "../components/modal.tsx";
import { type Color, HIGHLIGHT_COLORS } from "./notes_client.ts";

/** Title + Cancel/Save on the unified Modal base. Cmd/Ctrl+Enter submits,
 *  Esc=cancel is handled by Modal. */
function ModalShell(
  { title, submitLabel, onCancel, onSubmit, children }: {
    title: string;
    submitLabel: string;
    onCancel(): void;
    onSubmit(): void;
    children: ComponentChildren;
  },
) {
  return (
    <Modal title={title} size="small" onClose={onCancel}>
      <div
        class="coconote-pdf-comment"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSubmit();
          }
        }}
      >
        {children}
        <ModalActions
          variant="pdf"
          onCancel={onCancel}
          onConfirm={onSubmit}
          confirmLabel={submitLabel}
        />
      </div>
    </Modal>
  );
}

export function CommentModal(
  { initial, onSubmit, onCancel }: {
    initial: string;
    onSubmit(body: string): void;
    onCancel(): void;
  },
) {
  const [body, setBody] = useState(initial);
  return (
    <ModalShell
      title={initial !== "" ? "Edit comment" : "Add comment"}
      submitLabel="Save"
      onCancel={onCancel}
      onSubmit={() => onSubmit(body)}
    >
      <textarea
        autoFocus
        value={body}
        spellcheck={false}
        placeholder="Comment text - leave empty + Save to delete."
        onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
      />
    </ModalShell>
  );
}

export function AnchorModal(
  { initial, editing, validate, onSubmit, onCancel }: {
    initial: string;
    editing: boolean;
    /** Returns an error message for an invalid name, or null if valid. */
    validate(name: string): string | null;
    onSubmit(name: string): void;
    onCancel(): void;
  },
) {
  const [name, setName] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  const submit = () => {
    const trimmed = name.trim();
    const e = validate(trimmed);
    if (e) {
      setErr(e);
      return;
    }
    onSubmit(trimmed);
  };
  return (
    <ModalShell
      title={editing ? "Rename anchor" : "Set anchor"}
      submitLabel="Save"
      onCancel={onCancel}
      onSubmit={submit}
    >
      <input
        autoFocus
        class="coconote-pdf-anchor-input"
        value={name}
        spellcheck={false}
        placeholder="anchor-name"
        onInput={(e) => {
          setName((e.target as HTMLInputElement).value);
          if (err) setErr(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
      />
      {err && <div class="coconote-pdf-anchor-error">{err}</div>}
    </ModalShell>
  );
}

export function HighlightContextMenu({
  x,
  y,
  hasAnchor,
  hasComment,
  onClose,
  onAnchor,
  onComment,
  onColor,
  onRemove,
}: {
  x: number;
  y: number;
  hasAnchor: boolean;
  hasComment: boolean;
  onClose(): void;
  onAnchor(): void;
  onComment(): void;
  onColor(c: Color): void;
  onRemove(): void;
}) {
  const { ref, x: mx, y: my } = useMenuPosition(x, y);
  // Outside click / right-click / Escape dismiss (shared hook). Inside
  // clicks are swallowed by stopPropagation so they don't self-dismiss.
  useDismissOnOutside(onClose);
  return (
    <div
      ref={ref}
      class="coconote-pdf-context-menu"
      style={{ left: `${mx}px`, top: `${my}px` }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button type="button" onClick={onAnchor}>
        {hasAnchor ? "Rename anchor" : "Set anchor"}
      </button>
      <button type="button" onClick={onComment}>
        {hasComment ? "Edit comment" : "Add comment"}
      </button>
      <div class="coconote-pdf-context-colors">
        {HIGHLIGHT_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            class={`coconote-pdf-color-btn coconote-pdf-color-${c}`}
            onClick={() => onColor(c)}
            title={`Change colour to ${c}`}
          />
        ))}
      </div>
      <button type="button" class="coconote-pdf-context-remove" onClick={onRemove}>
        Remove highlight
      </button>
    </div>
  );
}
