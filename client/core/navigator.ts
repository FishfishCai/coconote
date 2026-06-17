// History contract: `navigate` pushes history then loadPage (no synthetic
// popstate). Browser back/forward fires native popstate -> loadPage. The
// leaving page's scroll/cursor is captured so the destination can restore it.

import {
  encodePageURI,
  getNameFromPath,
  getPathExtension,
  isMarkdownPath,
  parseToRef,
  type Path,
  type Ref,
} from "coconote/lib/ref";
import type { EditorCtx } from "./ctx/editor.ts";
import type { SpaceCtx } from "./ctx/space.ts";
import type { NavigationCtx } from "./ctx/navigation.ts";
import type { UICtx } from "./ctx/ui.ts";
type Client = EditorCtx & SpaceCtx & NavigationCtx & UICtx;
import type { EditorView } from "@codemirror/view";
import { detachCollab } from "../collab/attach_to_editor.ts";
import { resolveWikiLinkPath } from "../markdown/wiki_link_resolver.ts";
import { absFsBase } from "../spaces/constants.ts";
import { errMessage } from "../lib/constants.ts";

// `path === ""` represents the root URL (`/`).
export type LocationState = Ref & {
  scrollTop?: number;
  /** Doc position nearest viewport top (survives heightMap shuffle on return). */
  scrollAnchorPos?: number;
  selection?: { anchor: number; head?: number };
};

const ROOT_REF: Ref = { path: "" as Path };

export type OpenLocations = Map<string, LocationState>;

/** content.md + setting.md: each panel owns a URL. */
export type SpecialRoute =
  | { kind: "content"; view: "path" | "tag" | "graph" }
  | { kind: "setting" };

function parseSpecialRoute(pathname: string): SpecialRoute | null {
  const trimmed = pathname.replace(/\/+$/, "");
  if (trimmed === "" || trimmed === "/.content" || trimmed === "/.content/path") {
    return trimmed === "" ? null : { kind: "content", view: "path" };
  }
  if (trimmed === "/.content/tag") return { kind: "content", view: "tag" };
  if (trimmed === "/.content/graph") return { kind: "content", view: "graph" };
  if (trimmed === "/.setting") return { kind: "setting" };
  return null;
}

function pathToURI(path: Path): string {
  return path === "" ? "" : encodePageURI(getNameFromPath(path));
}

export function parseRefFromURI(): Ref | null {
  // Callers check parseSpecialRoute() first - only real page URLs reach here.
  const locationRef = parseToRef(
    decodeURIComponent(
      location.href.substring(document.baseURI.length),
    ),
  );
  if (locationRef && location.hash) {
    locationRef.details = {
      type: "header",
      header: decodeURIComponent(location.hash.substring(1)),
    };
  }
  return locationRef;
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
  ref: Ref | null,
  replaceState = false,
): Promise<void> {
  if (!ref?.path) {
    // No path = the index (content.md's default route).
    navigateSpecialRoute(client, { kind: "content", view: "path" }, replaceState);
    return;
  }
  const resolved = resolveWikiLinkPath(
    ref.path,
    client.currentPath(),
    client.allKnownFiles,
  );
  if (resolved !== ref.path) {
    ref = { ...ref, path: resolved as typeof ref.path };
  }
  await doLoad(client, ref, /*viaPopstate=*/ false, replaceState);
  client.focus();
}

export function openUrl(url: string) {
  const win = globalThis.open(url, "_blank");
  if (win) win.focus();
}

async function doLoad(
  client: Client,
  ref: Ref,
  viaPopstate: boolean,
  replaceState: boolean,
): Promise<void> {
  const leavingPath = client.currentPath();
  const leavingDifferent = !!leavingPath && leavingPath !== ref.path;
  if (leavingDifferent && isMarkdownPath(leavingPath) && client.editorView) {
    client.openLocations.set(leavingPath, {
      path: leavingPath,
      ...captureEditorPosition(client.editorView),
    });
  }

  // Non-md/non-pdf refs open in a new tab. Decide BEFORE touching the
  // URL so history never points at e.g. /diagram.png (Back would
  // re-trigger the tab-open).
  if (ref.path && !isMarkdownPath(ref.path) && getPathExtension(ref.path) !== "pdf") {
    openUrl(`${absFsBase()}/${ref.path}`);
    return;
  }

  // Skip push/replace on popstate (URL already correct).
  if (!viaPopstate) {
    const url = `${document.baseURI}${pathToURI(ref.path)}`;
    if (replaceState) {
      history.replaceState(ref, "", url);
    } else {
      history.pushState(ref, "", url);
    }
  }

  // Flush the leaving page BEFORE detaching collab: while attached, a
  // connected session short-circuits the HTTP PUT (server checkpoints
  // the Yjs doc), so no guaranteed-stale PUT fires right after detach
  // (detach itself triggers a last-peer checkpoint server-side).
  if (leavingDifferent && isMarkdownPath(leavingPath) && client.editorView) {
    try {
      await client.contentManager.save(true);
    } catch (e: unknown) {
      console.error(`Save on leave failed: ${errMessage(e)}`);
    }
  }
  // Leaving a live collab path -> drop the session. Next loadPage
  // spawns a fresh one if the destination wants collab.
  if (client.collabHandle && client.collabHandle.path !== ref.path) {
    detachCollab(client);
  }

  if (!ref.path) {
    client.ui.hidePdfViewer();
    client.ui.hideSettings();
    client.ui.showContentBrowser();
    return;
  }
  if (getPathExtension(ref.path) === "pdf") {
    const anchor = ref.details?.type === "pdfAnchor"
      ? ref.details.anchor
      : undefined;
    client.ui.showPdfViewer(ref.path, anchor);
    return;
  }
  client.ui.hidePdfViewer();

  client.ui.hideSettings();
  client.ui.hideContentBrowser();

  const state: LocationState = { ...ref };
  const saved = client.openLocations.get(ref.path);
  if (saved) {
    state.scrollTop = saved.scrollTop;
    state.scrollAnchorPos = saved.scrollAnchorPos;
    state.selection = saved.selection;
  }

  try {
    await client.contentManager.loadPage(state);
  } catch (e: unknown) {
    console.error(`Failed to navigate: ${errMessage(e)}`);
    if (!viaPopstate && !replaceState) history.go(-1);
  }
}

function applySpecialRoute(client: Client, route: SpecialRoute): void {
  // Drop any live collab session so the status dot reverts to grey
  // (navigate() handles this for path nav, special routes need it too).
  if (client.collabHandle) detachCollab(client);
  if (route.kind === "setting") {
    client.ui.hideContentBrowser();
    client.ui.hidePdfViewer();
    client.ui.showSettings();
    return;
  }
  client.ui.hideSettings();
  client.ui.hidePdfViewer();
  client.ui.showContentBrowser();
  client.ui.setContentBrowserView(route.view);
}

export function navigateSpecialRoute(
  client: Client,
  route: SpecialRoute,
  replaceState = false,
): void {
  const url = route.kind === "setting"
    ? "/.setting"
    : `/.content/${route.view}`;
  if (replaceState) {
    history.replaceState({ special: route }, "", url);
  } else {
    history.pushState({ special: route }, "", url);
  }
  applySpecialRoute(client, route);
}

export async function initNavigator(client: Client): Promise<void> {
  globalThis.addEventListener("popstate", (event: PopStateEvent) => {
    const state = event.state;
    if (state && typeof state === "object" && "special" in state) {
      applySpecialRoute(client, (state as { special: SpecialRoute }).special);
      return;
    }
    const route = parseSpecialRoute(location.pathname);
    if (route) {
      applySpecialRoute(client, route);
      return;
    }
    // Trust history state only when it looks like a Ref - boot's query
    // strip and other writers can leave `{}` there.
    const stateRef = state && typeof state === "object" &&
        typeof (state as Ref).path === "string"
      ? state as Ref
      : null;
    const ref: Ref = stateRef ?? parseRefFromURI() ?? { ...ROOT_REF };
    void doLoad(client, ref, /*viaPopstate=*/ true, /*replaceState=*/ false);
  });

  const route = parseSpecialRoute(location.pathname);
  if (route) {
    applySpecialRoute(client, route);
    return;
  }

  if (!client.onLoadRef?.path) {
    // Bare `/` -> default to /.content/path (content.md).
    navigateSpecialRoute(client, { kind: "content", view: "path" }, true);
    return;
  }
  await navigate(client, client.onLoadRef, /*replaceState=*/ true);
  client.focus();
}
