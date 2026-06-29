import { EditorView } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import { getOffsetFromRef } from "../capabilities/links/index.ts";
import type { PageMeta } from "coconote/type/page";
import { errMessage, notFoundError } from "coconote/constants";
import {
  attachCollab,
  createEditorState,
  detachCollab,
  diffAndPrepareChanges,
  externalUpdate,
} from "../features/md-editor";
import { stripFrontmatter } from "../core/file";
import { parseMarkdown } from "../capabilities/markdown/index.ts";
import { isStaleWriteError } from "../core/transport";
import type { Client } from "./client.ts";
import type { LocationState } from "./navigator.ts";

const autoSaveInterval = 1000;

export class ContentManager {
  saveTimeout?: ReturnType<typeof setTimeout>;
  // Mtime (epoch ms) for optimistic-concurrency PUT stale-write detection.
  private currentMtime = 0;
  // Every save() call's promise settles when the flush that covers it
  // actually completes (write landed / legitimately skipped) - never
  // before, so `await save(true)` really means "data is safe".
  private saveWaiters: { resolve(): void; reject(e: unknown): void }[] = [];
  private saveInFlight = false;
  // Settling-scroll timers for the current page, cleared on navigation
  // so a leftover timer can't scroll the NEXT page to this page's anchor.
  private cancelScroll?: () => void;

  constructor(private client: Client) {}

  save(immediate = false): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.saveWaiters.push({ resolve, reject });
      if (this.saveTimeout) clearTimeout(this.saveTimeout);
      this.saveTimeout = setTimeout(
        () => void this.flushSave(),
        immediate ? 0 : autoSaveInterval,
      );
    });
  }

  private settleSave(err?: unknown) {
    const waiters = this.saveWaiters.splice(0);
    for (const w of waiters) {
      if (err === undefined) w.resolve();
      else w.reject(err);
    }
  }

  private async flushSave(): Promise<void> {
    if (this.saveInFlight) {
      // A write is on the wire - re-flush once it settles so the latest
      // text still lands (two concurrent PUTs would race mtimes).
      this.saveTimeout = setTimeout(() => void this.flushSave(), 100);
      return;
    }
    if (
      !this.client.ui.viewState.unsavedChanges ||
      this.client.isReadOnlyMode()
    ) {
      return this.settleSave();
    }
    // editor.md Collaboration: with a session attached AND the WS
    // connected, the server checkpoints the Yjs doc to disk every 5s -
    // the client's HTTP PUT is redundant and races that checkpoint
    // (spurious stale-write 409s). During connecting/reconnecting/
    // disposed the server cannot checkpoint, so we MUST fall through to
    // HTTP PUT or edits live only in the local Yjs doc and exceed the
    // spec's 5s worst-case data-loss bound on tab close.
    const collabConnected =
      this.client.collabHandle?.status() === "connected";
    if (collabConnected) {
      this.client.ui.markPageSaved();
      this.client.onPageSaved?.();
      return this.settleSave();
    }
    if (this.client.editorView.composing) {
      // Mid-IME composition: defer the write AND the waiters with it -
      // resolving now would break the "settled -> on disk" contract.
      this.saveTimeout = setTimeout(
        () => void this.flushSave(),
        autoSaveInterval,
      );
      return;
    }
    const id = this.client.currentId();
    const pathHint = this.client.currentPath() || undefined;
    const text = this.client.editorView.state.sliceDoc(0);
    if (!id) return this.settleSave();
    this.saveInFlight = true;
    try {
      const meta = await this.client.space.writePage(
        id,
        text,
        this.currentMtime || undefined,
        pathHint,
      );
      this.currentMtime = Date.parse(meta.lastModified) || 0;
      this.client.ui.markPageSaved();
      this.client.onPageSaved?.();
      this.settleSave();
    } catch (e: unknown) {
      if (isStaleWriteError(e)) {
        void this.handleStaleWrite(id, text, pathHint);
        this.settleSave();
      } else {
        console.error("Could not save page, retrying in 10s");
        this.saveTimeout = setTimeout(() => void this.flushSave(), 10000);
        this.settleSave(e);
      }
    } finally {
      this.saveInFlight = false;
    }
  }

  /** 409 fallout. Captures the page id + text AT CONFLICT TIME so the
   *  user's answer can't be applied to a different page after they
   *  navigate away while the dialog is up. */
  private async handleStaleWrite(id: string, text: string, pathHint?: string) {
    const reload = await this.client.ui.confirm(
      "This file was modified elsewhere since you opened it. " +
        "OK = reload remote (discard local edits). " +
        "Cancel = overwrite remote with your edits.",
    );
    if (this.client.currentId() !== id) return;
    if (reload) {
      void this.reloadEditor();
      return;
    }
    try {
      const meta = await this.client.space.writePage(id, text, undefined, pathHint);
      this.currentMtime = Date.parse(meta.lastModified) || 0;
      // Only clear the dirty flag when nothing changed since the
      // conflicting snapshot - later keystrokes still need their save.
      if (this.client.editorView.state.sliceDoc(0) === text) {
        this.client.ui.markPageSaved();
        this.client.onPageSaved?.();
      }
    } catch (e: unknown) {
      console.error(`Overwrite after stale write failed: ${errMessage(e)}`);
    }
  }

  async reloadEditor() {
    if (!this.client.systemReady) return;
    const id = this.client.currentId();
    if (!id || this.client.currentPageMeta()?.kind === "pdf") return;
    clearTimeout(this.saveTimeout);
    try {
      await this.loadPage(
        { id },
        this.client.currentPath() || undefined,
        false,
      );
    } catch {
      console.error("Reload error for", id);
    }
  }

  private async leaveCurrentPage(newId: string) {
    const previousId = this.client.currentId();
    const loadingDifferentPage = previousId ? previousId !== newId : true;
    if (previousId) await this.save(true);
    return { previousId, loadingDifferentPage };
  }

  async loadPage(
    locationState: LocationState,
    pathHint?: string,
    navigateWithinPage: boolean = true,
  ) {
    const id = locationState.id;

    this.cancelScroll?.();

    const { loadingDifferentPage } = await this.leaveCurrentPage(id);

    let doc: { text: string; meta: PageMeta };
    try {
      doc = await this.client.space.readPage(id, pathHint);
    } catch (e: unknown) {
      // Only a genuine 404 creates a fresh page. Offline/server errors
      // must NOT synthesize an empty editor - typing into it would later
      // save with no mtime guard and silently overwrite the real file.
      if (errMessage(e) !== notFoundError.message) throw e;
      doc = {
        text: "",
        meta: {
          id,
          path: pathHint,
          kind: "md",
          lastModified: "",
          created: "",
          perm: "rw",
        },
      };
    }
    this.client.ui.setLoadedPage(doc.meta);
    this.currentMtime = Date.parse(doc.meta.lastModified) || 0;

    if (loadingDifferentPage || doc.meta.perm === "ro") {
      // y-codemirror.next replays yText empty->full at pos 0, so the
      // editor must be empty when collab attaches or the doc gets
      // duplicated on save. Collab is always on for rw pages.
      const willHaveCollab = doc.meta.perm !== "ro";
      const state = createEditorState(
        this.client,
        id,
        willHaveCollab ? "" : doc.text,
        doc.meta.perm === "ro",
      );
      this.client.editorView.setState(state);
      // A dirty flag carried over from the previous page (e.g. a failed
      // save) must not trigger a bogus autosave of the fresh page.
      this.client.ui.markPageSaved();
      detachCollab(this.client);
      if (willHaveCollab) {
        attachCollab(this.client, id, doc.text);
      }
    } else {
      const collabLive = this.client.collabHandle?.id === id &&
        this.client.collabHandle?.status() === "connected";
      // While a collab session is live the CRDT is the source of truth:
      // replaying the (<=5s stale) disk checkpoint into it would
      // broadcast a revert of every peer's latest edits. Meta was
      // refreshed above - the text needs nothing.
      if (!collabLive) this.applyExternalPatches(doc.text);
    }

    if (navigateWithinPage) {
      try {
        this.navigateWithinPage(locationState);
      } catch { /* best-effort */ }
    }
  }

  private applyExternalPatches(newText: string) {
    const currentText = this.client.editorView.state.sliceDoc();
    const allChanges = diffAndPrepareChanges(currentText, newText);
    this.client.editorView.dispatch({
      changes: allChanges,
      annotations: [isolateHistory.of("full"), externalUpdate.of(true)],
    });
  }

  private navigateWithinPage(pageState: LocationState) {
    let pos: number | undefined;
    if (pageState.details) {
      const pageText = this.client.editorView.state.sliceDoc();
      const offset = getOffsetFromRef(
        parseMarkdown(pageText),
        { title: "", details: pageState.details },
        pageText,
      );
      if (offset < 0) {
        const d = pageState.details;
        if (d.type === "header") {
          console.error(`Could not find header "${d.header}"`);
        }
      } else {
        pos = Math.max(
          0,
          Math.min(offset, this.client.editorView.state.doc.length),
        );
      }
    }
    if (pos !== undefined) {
      this.client.editorView.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 5 }),
      });
      return;
    }
    if (pageState.selection?.anchor !== undefined) {
      this.client.editorView.dispatch({ selection: pageState.selection });
    }
    // Pixel scroll drifts as KaTeX/transclusion widgets render and
    // re-measure CM's heightMap (CM-internal, so ResizeObserver doesn't
    // help). Re-fire scrollIntoView on a settling schedule.
    if (pageState.scrollAnchorPos !== undefined) {
      const view = this.client.editorView;
      const want = pageState.scrollAnchorPos;
      const dispatchScroll = () => {
        if (view.state.doc.length === 0) return;
        // Clamp against the doc as it is NOW - widgets may have changed it.
        const pos = Math.max(0, Math.min(want, view.state.doc.length));
        view.dispatch({
          effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 5 }),
        });
      };
      // Cancel on first user scroll input (their position is
      // authoritative) and on navigation (loadPage calls cancelScroll).
      const timers: number[] = [];
      const cancel = () => {
        for (const t of timers) clearTimeout(t);
        for (const ev of cancelEvents) {
          view.scrollDOM.removeEventListener(ev, cancel as EventListener);
        }
        if (this.cancelScroll === cancel) this.cancelScroll = undefined;
      };
      const cancelEvents = ["wheel", "touchstart", "keydown", "mousedown"];
      for (const ev of cancelEvents) {
        view.scrollDOM.addEventListener(ev, cancel as EventListener, {
          passive: true,
        });
      }
      for (const d of [0, 80, 200, 500, 1000, 2000]) {
        timers.push(setTimeout(dispatchScroll, d) as unknown as number);
      }
      timers.push(setTimeout(cancel, 2200) as unknown as number);
      this.cancelScroll = cancel;
      return;
    }
    if (pageState.scrollTop !== undefined) {
      this.client.editorView.scrollDOM.scrollTop = pageState.scrollTop;
      return;
    }
    if (pageState.selection?.anchor !== undefined) return;
    // Fresh open: cursor just past the frontmatter block.
    const pageText = this.client.editorView.state.sliceDoc();
    const initial = stripFrontmatter(pageText).offset;
    this.client.editorView.scrollDOM.scrollTop = 0;
    this.client.editorView.dispatch({
      selection: { anchor: initial },
      scrollIntoView: true,
    });
  }
}
