// Floating panel for editing a PDF sidecar's four metadata fields
// (id / coconote / title / tag). pdf.md §Metadata panel: opened via
// the `pdfMetadataPanel` shortcut (default Cmd / Ctrl + Shift + M)
// while the PDF viewer is open.

import { useEffect, useRef, useState } from "preact/hooks";
import { AlwaysShownModal, Button } from "../components/basic_modals.tsx";
import { loadSidecar, saveMetadata } from "./notes_client.ts";
import type { PdfSidecar } from "./notes_client.ts";

type Props = {
  pdfPath: string;
  onClose(): void;
  onSaved?(): void;
};

export function PdfMetadataPanel({ pdfPath, onClose, onSaved }: Props) {
  const [sidecar, setSidecar] = useState<PdfSidecar | null>(null);
  const [id, setId] = useState("");
  const [coconoteText, setCoconoteText] = useState("true");
  const [title, setTitle] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const sc = await loadSidecar(pdfPath);
        if (cancelled) return;
        setSidecar(sc);
        setId(sc.metadata.id ?? "");
        setCoconoteText((sc.metadata.coconote ?? true) ? "true" : "false");
        setTitle(sc.metadata.title ?? "");
        setTagsText((sc.metadata.tag ?? []).join(", "));
      } catch (e) {
        if (cancelled) return;
        setError(`Load failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdfPath]);

  useEffect(() => {
    if (sidecar) idInputRef.current?.focus();
  }, [sidecar]);

  const onSave = async () => {
    if (!sidecar || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Match file.md "only true is included": anything other than the
      // literal "true" is treated as excluded.
      const coconote = coconoteText.trim().toLowerCase() === "true";
      await saveMetadata(pdfPath, {
        id: id.trim(),
        coconote,
        title: title.trim(),
        tag: tagsText
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      });
      onSaved?.();
      onClose();
    } catch (e) {
      setError(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
      setBusy(false);
    }
  };

  return (
    <AlwaysShownModal onCancel={onClose}>
      <div className="coconote-prompt coconote-pdf-meta">
        <div className="coconote-pdf-meta-title">PDF metadata</div>
        {/* Outside the loaded-branch so a LOAD failure is visible too
            (otherwise the panel shows "Loading…" forever). */}
        {error && <div className="coconote-error">{error}</div>}
        {!sidecar
          ? !error && <div>Loading…</div>
          : (
            <>
              <div className="coconote-pdf-meta-row">
                <label htmlFor="pdf-meta-id">id</label>
                <input
                  id="pdf-meta-id"
                  ref={idInputRef}
                  type="text"
                  value={id}
                  onInput={(e) =>
                    setId((e.target as HTMLInputElement).value)}
                />
              </div>
              <div className="coconote-pdf-meta-row">
                <label htmlFor="pdf-meta-coconote">coconote</label>
                <input
                  id="pdf-meta-coconote"
                  type="text"
                  value={coconoteText}
                  onInput={(e) =>
                    setCoconoteText((e.target as HTMLInputElement).value)}
                />
              </div>
              <div className="coconote-pdf-meta-row">
                <label htmlFor="pdf-meta-title">title</label>
                <input
                  id="pdf-meta-title"
                  type="text"
                  value={title}
                  onInput={(e) =>
                    setTitle((e.target as HTMLInputElement).value)}
                />
              </div>
              <div className="coconote-pdf-meta-row">
                <label htmlFor="pdf-meta-tag">tag</label>
                <input
                  id="pdf-meta-tag"
                  type="text"
                  value={tagsText}
                  onInput={(e) =>
                    setTagsText((e.target as HTMLInputElement).value)}
                />
              </div>
              <div className="coconote-prompt-buttons">
                <Button primary onActivate={onSave}>
                  {busy ? "Saving…" : "Save"}
                </Button>
                <Button onActivate={onClose}>Cancel</Button>
              </div>
            </>
          )}
      </div>
    </AlwaysShownModal>
  );
}
