// History contract: `navigate` pushes history then loadPage (no synthetic
// popstate). Browser back/forward fires native popstate -> loadPage. The
// leaving page's scroll/cursor is captured so the destination can restore it.
//
// Addressing is by id. A wiki target's title is resolved to an id by the
// caller (lifecycle / wiki_link / recent list); the navigator loads by id,
// records the open in the recent list, and routes md -> editor / pdf ->
// reader. The browser URL is `/<id>` plus an optional `#<header>` hash; the
// full position details live in history.state (a JS object), so within-
// session back/forward restores callout / pdf anchors too.

import type { Ref } from "../capabilities/links/index.ts";
import type { EditorCtx } from "../core/ctx/editor.ts";
import type { SpaceCtx } from "../core/ctx/space.ts";
import type { NavigationCtx } from "../core/ctx/navigation.ts";
import type { UICtx } from "../core/ctx/ui.ts";
type Client = EditorCtx & SpaceCtx & NavigationCtx & UICtx;
import type { EditorView } from "@codemirror/view";
import { detachCollab } from "../features/md-editor";
import { pageById } from "../capabilities/links/index.ts";
import { patchConfig } from "../core/config/index.ts";
import { errMessage, notFoundError } from "../core/util";

/** A resolved navigation target: the file id plus an optional in-file
 *  position and the title the link used (for display / re-record). */
export type NavTarget = {
  id: string;
  title?: string;
  details?: Ref["details"];
  /** Known on-disk path of the target, when the caller has it (an OS open,
   *  a recent-list row). Threaded so the recent record carries a real path
   *  hint: the server rejects an empty-path recent entry, and the page
   *  index can't supply one until recent has bootstrapped, so without this
   *  the very first open could never be recorded. */
  path?: string;
};

export type LocationState = NavTarget & {
  scrollTop?: number;
  /** Doc position nearest viewport top (survives heightMap shuffle on return). */
  scrollAnchorPos?: number;
  selection?: { anchor: number; head?: number };
};

export type OpenLocations = Map<string, LocationState>;

/** Initial-load intent parsed from the URL: a known id (+ optional header
 *  detail), a loopback OS path to resolve to an id, or null (root). */
export type OnLoad =
  | { kind: "id"; id: string; details?: Ref["details"] }
  | { kind: "path"; path: string }
  | null;

const ID_RE = /^[a-z0-9]{16}$/;

/** Parse the URL after the app base into an OnLoad intent. */
export function parseOnLoad(): OnLoad {
  const raw = decodeURIComponent(
    location.href.substring(document.baseURI.length),
  );
  // Strip a query string left by an external launcher.
  const noQuery = raw.split("?")[0];
  const path = noQuery.split("#")[0];
  if (!path) return null;
  if (ID_RE.test(path)) {
    const hash = location.hash ? decodeURIComponent(location.hash.slice(1)) : "";
    const details: Ref["details"] | undefined = hash
      ? { type: "header", header: hash }
      : undefined;
    return { kind: "id", id: path, details };
  }
  // Anything else is treated as a loopback OS path to resolve.
  return { kind: "path", path };
}

function captureEditorPosition(
  view: EditorView,
): Pick<LocationState, "scrollTop" | "scrollAnchorPos" | "selection"> {
  const sc = view.scrollDOM;
  const main = view.state.selection.main;
  const cmRect = sc.getBoundingClientRect();
  const anchorPos = view.posAtCoords(
    { x: cmRect.left + 20, y: cmRect.top + 5 },
    false,
  );
  return {
    scrollTop: sc.scrollTop,
    scrollAnchorPos: anchorPos ?? undefined,
    selection: { head: main.head, anchor: main.anchor },
  };
}

export async function navigate(
  client: Client,
  target: NavTarget | null,
  replaceState = false,
): Promise<void> {
  if (!target?.id) {
    // No id -> open the recent list (recent + pin).
    client.ui.hidePdfViewer();
    client.ui.hideSettings();
    client.ui.showRecent();
    return;
  }
  await doLoad(client, target, /*viaPopstate=*/ false, replaceState);
  client.focus();
}

export function openUrl(url: string) {
  const win = globalThis.open(url, "_blank");
  if (win) win.focus();
}

/** setting.md L96: open a file the OS handed us - a double-click in the file
 *  manager (forwarded by the electron main process) or a file dropped into
 *  the window. Resolve the absolute path to an id via the loopback
 *  `GET /.resolve?path=` endpoint, then navigate (which records it in recent
 *  and routes md -> editor / pdf -> reader, same as any other open). */
export async function openOsPath(client: Client, path: string): Promise<void> {
  if (!path) return;
  try {
    const id = await client.httpSpacePrimitives.resolvePath(path);
    await navigate(client, { id, path });
  } catch (e: unknown) {
    console.error(`Could not open ${path}: ${errMessage(e)}`);
  }
}

// Record a successfully opened file into the MRU recent list (SPEC: opened
// files are recorded in the config yaml). Fire and forget, deduped against
// the last recorded id so reloads and back/forward do not spam PATCH. After
// the server moves it to the front, refresh the known-page index.
let lastRecorded: string | null = null;
function recordOpen(client: Client, id: string, path: string | undefined): void {
  if (!id || id === lastRecorded) return;
  lastRecorded = id;
  void patchConfig({ addRecent: { id, path: path ?? "" } })
    .then(() => client.updatePageListCache())
    .catch((e: unknown) =>
      console.error(`Record recent failed: ${errMessage(e)}`)
    );
}

/** Decide whether `id` is a pdf (reader) or md (editor). Uses the page
 *  index when known, else a HEAD probe of the file content type. */
async function resolveKind(
  client: Client,
  id: string,
): Promise<"md" | "pdf"> {
  const known = pageById(id, client.ui.viewState.allPages);
  if (known) return known.kind;
  try {
    const meta = await client.httpSpacePrimitives.getFileMeta({ id });
    return /pdf/i.test(meta.contentType) ? "pdf" : "md";
  } catch {
    return "md";
  }
}

async function doLoad(
  client: Client,
  target: NavTarget,
  viaPopstate: boolean,
  replaceState: boolean,
): Promise<void> {
  const leavingId = client.currentId();
  const leavingDifferent = !!leavingId && leavingId !== target.id;
  if (leavingDifferent && client.editorView && !client.ui.viewState.pdfViewer) {
    client.openLocations.set(leavingId, {
      id: leavingId,
      ...captureEditorPosition(client.editorView),
    });
  }

  // Skip push/replace on popstate (URL already correct).
  if (!viaPopstate) {
    const hash = target.details?.type === "header"
      ? `#${encodeURIComponent(target.details.header)}`
      : "";
    const url = `${document.baseURI}${encodeURIComponent(target.id)}${hash}`;
    if (replaceState) {
      history.replaceState(target, "", url);
    } else {
      history.pushState(target, "", url);
    }
  }

  // Flush the leaving page BEFORE detaching collab.
  if (leavingDifferent && client.editorView && !client.ui.viewState.pdfViewer) {
    try {
      await client.contentManager.save(true);
    } catch (e: unknown) {
      console.error(`Save on leave failed: ${errMessage(e)}`);
    }
  }
  // Leaving a live collab session -> drop it. Next loadPage spawns a
  // fresh one if the destination wants collab.
  if (client.collabHandle && client.collabHandle.id !== target.id) {
    detachCollab(client);
  }

  const kind = await resolveKind(client, target.id);
  // Prefer a path the caller threaded in (OS open / recent row) over the
  // page index, which is empty until recent has at least one entry.
  const pathHint = target.path ||
    pageById(target.id, client.ui.viewState.allPages)?.path;
  if (kind === "pdf") {
    const anchor = target.details?.type === "pdfAnchor"
      ? target.details.anchor
      : undefined;
    client.ui.showPdfViewer(target.id, pathHint, anchor);
    recordOpen(client, target.id, pathHint);
    return;
  }
  client.ui.hidePdfViewer();
  client.ui.hideSettings();
  client.ui.hideRecent();

  const state: LocationState = { ...target };
  const saved = client.openLocations.get(target.id);
  if (saved) {
    state.scrollTop = saved.scrollTop;
    state.scrollAnchorPos = saved.scrollAnchorPos;
    state.selection = saved.selection;
  }

  try {
    await client.contentManager.loadPage(state, pathHint);
    recordOpen(client, target.id, pathHint);
  } catch (e: unknown) {
    if (errMessage(e) !== notFoundError.message) {
      console.error(`Failed to navigate: ${errMessage(e)}`);
    }
    if (!viaPopstate && !replaceState) history.go(-1);
  }
}

export async function initNavigator(client: Client): Promise<void> {
  globalThis.addEventListener("popstate", (event: PopStateEvent) => {
    const state = event.state;
    // Trust history state only when it looks like a NavTarget.
    const stateTarget = state && typeof state === "object" &&
        typeof (state as NavTarget).id === "string"
      ? state as NavTarget
      : null;
    if (stateTarget) {
      void doLoad(client, stateTarget, /*viaPopstate=*/ true, false);
      return;
    }
    void loadFromUrl(client, /*viaPopstate=*/ true, false);
  });

  await loadFromUrl(client, /*viaPopstate=*/ false, /*replaceState=*/ true);
  client.focus();
}

/** Resolve the URL's OnLoad intent to an id and load it, or open recent. */
async function loadFromUrl(
  client: Client,
  viaPopstate: boolean,
  replaceState: boolean,
): Promise<void> {
  const onLoad = parseOnLoad();
  if (!onLoad) {
    // Nothing to open (app launch / navigated to root): land on the quiet
    // empty state, not the recent panel. The user opens recent with the
    // shortcut (Cmd/Ctrl+P) shown there.
    return;
  }
  if (onLoad.kind === "id") {
    await doLoad(
      client,
      { id: onLoad.id, details: onLoad.details },
      viaPopstate,
      replaceState,
    );
    return;
  }
  // A loopback OS path: resolve to an id, then load by id (threading the
  // path so the launch file is recorded into recent with a real hint).
  try {
    const id = await client.httpSpacePrimitives.resolvePath(onLoad.path);
    await doLoad(client, { id, path: onLoad.path }, viaPopstate, replaceState);
  } catch (e: unknown) {
    console.error(`Could not open ${onLoad.path}: ${errMessage(e)}`);
    client.ui.showRecent();
  }
}
