// Panel for the PDF sidecar's frontmatter fields (id / title / tags /
// backrefs - a pdf has no refs). pdf.md: opened via the pdfMetadataPanel
// shortcut (default Cmd/Ctrl+Shift+M) while the reader is open. Joins the
// viewer's sidecar session so edits persist with the annotations.

import { useEffect, useRef, useState } from "preact/hooks";
import { Modal, ModalActions } from "../../core/ui";
import type { SpaceCtx } from "../../core/ctx/space.ts";
import { openSidecarSession, updateSidecarSession } from "./sidecar/session.ts";

type Props = {
  client: SpaceCtx;
  pdfId: string;
  onClose(): void;
  onSaved(): void;
};

const splitList = (s: string) =>
  s.split(",").map((t) => t.trim()).filter(Boolean);

export function PdfMetadataPanel(
  { client, pdfId, onClose, onSaved }: Props,
) {
  const [ready, setReady] = useState(false);
  const [id, setId] = useState("");
  const [title, setTitle] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [backrefsText, setBackrefsText] = useState("");
  const titleInputRef = useRef<HTMLInputElement>(null);

  // The first session callback fires synchronously and seeds the fields.
  // Later callbacks are ignored so they can't clobber edits.
  useEffect(() => {
    let seeded = false;
    const { release } = openSidecarSession(
      client.httpSpacePrimitives,
      pdfId,
      (sc) => {
        if (seeded && sc.metadata.title === "" && !sc.metadata.id) return;
        if (seeded) return;
        seeded = true;
        setId(sc.metadata.id ?? pdfId);
        setTitle(sc.metadata.title ?? "");
        setTagsText((sc.metadata.tags ?? []).join(", "));
        setBackrefsText((sc.metadata.backrefs ?? []).join(", "));
        setReady(true);
      },
    );
    return release;
  }, [pdfId]);

  useEffect(() => {
    if (ready) titleInputRef.current?.focus();
  }, [ready]);

  const onSave = () => {
    updateSidecarSession(pdfId, (s) => ({
      ...s,
      metadata: {
        // spec L153: id is editable. Persist the edited value (falling back
        // to the existing id, then the addressing id, if cleared). On a
        // remote write the server keeps the on-disk id; loopback honors it.
        id: id.trim() || s.metadata.id || pdfId,
        title: title.trim(),
        tags: splitList(tagsText),
        backrefs: splitList(backrefsText),
      },
    }));
    onSaved();
    onClose();
  };

  return (
    <Modal title="PDF metadata" size="default" onClose={onClose} loading={!ready}>
      <div className="coconote-prompt coconote-pdf-meta">
        <div className="coconote-pdf-meta-row">
          <label htmlFor="pdf-meta-id">id</label>
          <input
            id="pdf-meta-id"
            type="text"
            value={id}
            spellcheck={false}
            onInput={(e) => setId((e.target as HTMLInputElement).value)}
          />
        </div>
        <div className="coconote-pdf-meta-row">
          <label htmlFor="pdf-meta-title">title</label>
          <input
            id="pdf-meta-title"
            ref={titleInputRef}
            type="text"
            value={title}
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
          />
        </div>
        <div className="coconote-pdf-meta-row">
          <label htmlFor="pdf-meta-tags">tags</label>
          <input
            id="pdf-meta-tags"
            type="text"
            value={tagsText}
            onInput={(e) => setTagsText((e.target as HTMLInputElement).value)}
          />
        </div>
        <div className="coconote-pdf-meta-row">
          <label htmlFor="pdf-meta-backrefs">backrefs</label>
          <input
            id="pdf-meta-backrefs"
            type="text"
            value={backrefsText}
            onInput={(e) => setBackrefsText((e.target as HTMLInputElement).value)}
          />
        </div>
        <ModalActions
          onCancel={onClose}
          onConfirm={onSave}
          confirmLabel="Save"
        />
      </div>
    </Modal>
  );
}
