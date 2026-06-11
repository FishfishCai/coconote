import type { EditorView } from "@codemirror/view";
import { authedFetch } from "../../lib/authed_fetch.ts";
import { encodePathSegments } from "../../lib/path_url.ts";
import type { ClientContext as Client } from "../../core/context.ts";

/** file.md: "Images pasted or dropped into the editor are
 *  automatically saved into that folder." Generates a stable name with
 *  an extension derived from the MIME type, PUTs it under the page's
 *  `.<name>.assets/` (basename without `.md`), then inserts
 *  `![[<asset-name>]]` at the cursor. */
export async function handleImagePaste(
  client: Client,
  view: EditorView,
  file: File,
): Promise<void> {
  const fullPath = client.currentPath();
  if (!fullPath || !fullPath.endsWith(".md")) return;
  const slash = fullPath.lastIndexOf("/");
  const dir = slash >= 0 ? fullPath.slice(0, slash + 1) : "";
  const base = slash >= 0 ? fullPath.slice(slash + 1) : fullPath;
  const pageStem = base.replace(/\.md$/i, "");
  const ext = pickExt(file.type, file.name);
  // Date-based stems collide when two pastes land in the same
  // millisecond or the same file is dropped twice; append 6 random
  // chars for within-vault uniqueness.
  const rnd = Math.floor(Math.random() * 0x7fffffff).toString(36);
  const assetStem = `pasted-${Date.now().toString(36)}-${rnd}`;
  const name = `${assetStem}${ext}`;
  const target = `${dir}.${pageStem}.assets/${name}`;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const r = await authedFetch(`/.file/${encodePathSegments(target)}`, {
      method: "PUT",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: bytes,
    });
    if (!r.ok) {
      console.error(`Image paste failed: PUT ${r.status}`);
      return;
    }
    const sel = view.state.selection.main;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: `![[${name}]]` },
      selection: { anchor: sel.from + `![[${name}]]`.length },
    });
  } catch (e) {
    console.error(`Image paste failed: ${e}`);
  }
}

function pickExt(mime: string, fallbackName: string): string {
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/svg+xml") return ".svg";
  const m = /\.[A-Za-z0-9]+$/.exec(fallbackName);
  return m ? m[0] : ".bin";
}
