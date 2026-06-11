// Floating panel for editing a PDF sidecar's four metadata fields
// (id / coconote / title / tag). pdf.md: opened via the pdfMetadataPanel
// shortcut (default Cmd / Ctrl + Shift + M) while the PDF reader is open.
// It joins the same live sidecar session the viewer uses, so edits sync
// and persist through collab just like the annotations.

import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../components/basic_modals.tsx";
import { Modal } from "../components/modal.tsx";
import { openSidecarSession, updateSidecarSession } from "./notes_client.ts";

type Props = {
  pdfPath: string;
  onClose(): void;
  onSaved?(): void;
};

export function PdfMetadataPanel({ pdfPath, onClose, onSaved }: Props) {
  const [ready, setReady] = useState(false);
  const [id, setId] = useState("");
  const [coconoteText, setCoconoteText] = useState("true");
  const [title, setTitle] = useState("");
  const [tagsText, setTagsText] = useState("");
  const idInputRef = useRef<HTMLInputElement>(null);

  // Join the live sidecar session. The first callback fires synchronously
  // with the current state, so the fields fill in immediately. Later
  // (remote) callbacks are ignored so they can't clobber in-progress edits.
  useEffect(() => {
    let seeded = false;
    const { release } = openSidecarSession(pdfPath, (sc) => {
      if (seeded) return;
      seeded = true;
      setId(sc.metadata.id ?? "");
      setCoconoteText((sc.metadata.coconote ?? true) ? "true" : "false");
      setTitle(sc.metadata.title ?? "");
      setTagsText((sc.metadata.tag ?? []).join(", "));
      setReady(true);
    });
    return release;
  }, [pdfPath]);

  useEffect(() => {
    if (ready) idInputRef.current?.focus();
  }, [ready]);

  const onSave = () => {
    // file.md "only true is included": anything but the literal "true"
    // counts as excluded.
    const coconote = coconoteText.trim().toLowerCase() === "true";
    updateSidecarSession(pdfPath, (s) => ({
      ...s,
      metadata: {
        id: id.trim(),
        coconote,
        title: title.trim(),
        tag: tagsText.split(",").map((t) => t.trim()).filter(Boolean),
      },
    }));
    onSaved?.();
    onClose();
  };

  return (
    <Modal title="PDF metadata" size="default" onClose={onClose} loading={!ready}>
      <div className="coconote-prompt coconote-pdf-meta">
        <div className="coconote-pdf-meta-row">
          <label htmlFor="pdf-meta-id">id</label>
          <input
            id="pdf-meta-id"
            ref={idInputRef}
            type="text"
            value={id}
            onInput={(e) => setId((e.target as HTMLInputElement).value)}
          />
        </div>
        <div className="coconote-pdf-meta-row">
          <label htmlFor="pdf-meta-coconote">coconote</label>
          <input
            id="pdf-meta-coconote"
            type="text"
            value={coconoteText}
            onInput={(e) => setCoconoteText((e.target as HTMLInputElement).value)}
          />
        </div>
        <div className="coconote-pdf-meta-row">
          <label htmlFor="pdf-meta-title">title</label>
          <input
            id="pdf-meta-title"
            type="text"
            value={title}
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
          />
        </div>
        <div className="coconote-pdf-meta-row">
          <label htmlFor="pdf-meta-tag">tag</label>
          <input
            id="pdf-meta-tag"
            type="text"
            value={tagsText}
            onInput={(e) => setTagsText((e.target as HTMLInputElement).value)}
          />
        </div>
        <div className="coconote-prompt-buttons">
          <Button primary onActivate={onSave}>Save</Button>
          <Button onActivate={onClose}>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}
