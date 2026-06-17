// Browser save boundary: saveBlobAs uses the OS save dialog (File System
// Access API) when available, falling back to a plain download.

/** Hand `blob` to the browser as a file download named `filename`. */
function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the download has started so large blobs are not truncated.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// Minimal typing for the File System Access API save dialog: absent
// from TypeScript's DOM lib, and at runtime from Safari and Firefox.
type SaveFilePicker = (options: {
  suggestedName: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileSystemFileHandle>;

/** Save `blob` as `filename`, letting the user pick the destination via
 *  the OS save dialog when the browser has one. A cancelled dialog
 *  (AbortError) saves nothing. Any other picker failure, and browsers
 *  without the API, fall back to downloadBlob. */
export async function saveBlobAs(filename: string, blob: Blob): Promise<void> {
  const picker = (window as { showSaveFilePicker?: SaveFilePicker })
    .showSaveFilePicker;
  if (!picker) return downloadBlob(filename, blob);
  const dot = filename.lastIndexOf(".");
  const ext = dot > 0 ? filename.slice(dot) : null;
  try {
    const handle = await picker({
      suggestedName: filename,
      types: blob.type && ext
        ? [{ description: `${ext.slice(1)} file`, accept: { [blob.type]: [ext] } }]
        : undefined,
    });
    const w = await handle.createWritable();
    await w.write(blob);
    await w.close();
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return;
    downloadBlob(filename, blob);
  }
}
