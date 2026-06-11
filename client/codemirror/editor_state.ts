import customMarkdownStyle from "./style.ts";
import {
  cursorGroupLeft,
  cursorGroupRight,
  cursorLineBoundaryBackward,
  cursorLineBoundaryForward,
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
  selectGroupLeft,
  selectGroupRight,
  selectLineBoundaryBackward,
  selectLineBoundaryForward,
} from "@codemirror/commands";
import {
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import { search, searchKeymap, selectNextOccurrence } from "@codemirror/search";
import {
  codeFolding,
  indentOnInput,
  indentUnit,
  LanguageDescription,
  LanguageSupport,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  Annotation,
  Compartment,
  EditorState,
  type EditorSelection as EditorSelectionT,
  type Extension,
  Prec,
} from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightSpecialChars,
  keymap,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import {
  deleteMarkupBackward,
  insertNewlineContinueMarkup,
  markdown,
} from "@codemirror/lang-markdown";
import type { ClientContext as Client } from "../core/context.ts";
import { collectModuleExtensions } from "./registry.ts";
import { insideList, smartSelectAll } from "./commands.ts";
import { handleImagePaste } from "./plugins/paste_image.ts";
import { readModeFacet } from "./util/util.ts";
import { lazyLanguages, languageFor, loadLanguageFor } from "./languages.ts";
import { buildExtendedMarkdownLanguage } from "../markdown/parser/parser.ts";
import { safeRun } from "coconote/lib/async";
import { toPath } from "coconote/lib/ref";
import type { ClickEvent } from "coconote/type/client";

// Tags transactions from outside the editor so save-on-change can skip
// them (avoids re-save loops).
export const externalUpdate = Annotation.define<boolean>();

export function createEditorState(
  client: Client,
  pageName: string,
  text: string,
  readOnly: boolean,
  selection?: EditorSelectionT,
): EditorState {
  let touchCount = 0;

  const regularKeyBindings = createRegularKeyBindings(client);

  client.undoHistoryCompartment = new Compartment();
  // With a live collab session, Yjs owns undo (editor.md) — CM history
  // would let Cmd+Z revert remote peers' edits.
  const collabAlive = client.collabHandle?.path === toPath(pageName);
  const undoHistory = client.undoHistoryCompartment.of(
    collabAlive ? [] : [history()],
  );

  // collab extension slot — populated by content_manager.loadPage when
  // collab is enabled for the active page. If there's already a live
  // handle bound to THIS page (rebuildEditorState scenario), reseed
  // with it so a font/theme change doesn't kill the WebSocket session.
  // NB: collabHandle.path carries the .md extension, pageName doesn't —
  // compare via toPath or the live session is silently dropped on every
  // rebuild while its WS stays "connected" (saves then no-op forever).
  if (!client.collabCompartment) {
    client.collabCompartment = new Compartment();
  }
  const liveCollab = client.collabHandle?.path === toPath(pageName)
    ? client.collabHandle.extension
    : [];
  const collabExt = client.collabCompartment.of(liveCollab);

  client.markdownLanguageCompartment = new Compartment();
  const markdownLanguageExtension = client.markdownLanguageCompartment.of(
    buildMarkdownLanguageExtension(client),
  );

  // Read from config not viewState — React may lag right after setUiOption.
  const editorMode = client.config.get<string>(
    ["ui", "editorMode"],
    "render",
  ) as "read" | "source" | "render";
  if (!client.editModeCompartment) {
    client.editModeCompartment = new Compartment();
  }
  const readOnlyExtensions = client.editModeCompartment.of(
    editModeExtensionsFor(client, readOnly, editorMode),
  );

  return EditorState.create({
    doc: text,
    selection,
    extensions: [
      // `{}` so CM measures heightMap from real CSS font metrics —
      // setting fontSize/lineHeight here drifts selection if CSS differs.
      EditorView.theme({}, { dark: client.ui.viewState.uiOptions.darkMode }),

      readOnlyExtensions,
      collabExt,

      markdownLanguageExtension,
      syntaxHighlighting(customMarkdownStyle()),
      EditorView.contentAttributes.of({
        spellcheck: "true",
        autocorrect: "on",
        autocapitalize: "on",
      }),
      highlightSpecialChars(),
      undoHistory,
      dropCursor(),
      codeFolding({
        placeholderText: "…",
      }),
      // 4 spaces per indent level. Outside of lists Tab inserts this
      // verbatim; inside lists indentMore/indentLess shift by it.
      indentUnit.of("    "),
      indentOnInput(),
      ...collectModuleExtensions(client),
      EditorView.lineWrapping,
      drawSelection(),
      // Required for Cmd+D / selectNextOccurrence to carry > 1 range.
      EditorState.allowMultipleSelections.of(true),
      regularKeyBindings,
      EditorView.domEventHandlers({
        touchmove: () => {
          touchCount++;
        },
        touchend: (event: TouchEvent, view: EditorView) => {
          if (touchCount === 0) {
            safeRun(async () => {
              const touch = event.changedTouches.item(0)!;
              if (!event.altKey && event.target instanceof Element) {
                // Avoid double-open on touch devices.
                if (event.target.closest("a")) event.preventDefault();
              }
              const pos = view.posAtCoords({
                x: touch.clientX,
                y: touch.clientY,
              })!;

              const potentialClickEvent: ClickEvent = {
                page: pageName,
                altKey: event.altKey,
                pos: pos,
              };

              const distanceX = touch.clientX - view.coordsAtPos(pos)!.left;
              // Live-preview-expanded regions register taps far from
              // the actual char position — guard with width threshold.
              if (distanceX <= view.defaultCharacterWidth) {
                client.onPageClick?.(potentialClickEvent);
              }
            });
          }
          touchCount = 0;
        },

        click: (event: MouseEvent, view: EditorView) => {
          if (event.button !== 0) return;
          if (event.altKey) return;
          if (!(event.target instanceof Element)) return;
          // Raw `[[..]]` source isn't an <a> — those are editing clicks.
          const anchor = event.target.closest("a") as HTMLAnchorElement | null;
          if (!anchor) return;
          // editor.md: Cmd/Ctrl+Click opens the link in a new tab
          // (browser) / system browser (desktop shell — Electron's
          // preload.cjs intercepts target=_blank clicks).
          if (event.metaKey || event.ctrlKey) {
            event.stopPropagation();
            event.preventDefault();
            const href = anchor.getAttribute("href") ?? "";
            if (href) {
              window.open(href, "_blank");
            }
            return;
          }
          event.stopPropagation();
          event.preventDefault();
          safeRun(async () => {
            const pos = view.posAtCoords({ x: event.x, y: event.y });
            if (pos == null) return;
            client.onPageClick?.({
              page: pageName,
              altKey: event.altKey,
              pos,
            });
          });
        },
        paste: (event: ClipboardEvent, view: EditorView) => {
          // editor.md: image in clipboard → save to assets folder
          // and insert a wikilink at the cursor.
          const items = event.clipboardData?.items;
          if (!items) return;
          for (let i = 0; i < items.length; i++) {
            const it = items[i];
            if (it.kind !== "file") continue;
            if (!it.type.startsWith("image/")) continue;
            const file = it.getAsFile();
            if (!file) continue;
            event.preventDefault();
            void handleImagePaste(client, view, file);
            return;
          }
        },
      }),
      ViewPlugin.fromClass(
        class {
          private composingDirty = false;

          update(update: ViewUpdate): void {
            if (update.docChanged) {
              if (
                update.transactions.some((t) => t.annotation(externalUpdate))
              ) {
                return;
              }

              // Defer save during IME — flush at composition end.
              if (update.view.composing) {
                this.composingDirty = true;
                client.ui.markPageChanged();
                return;
              }

              client.ui.markPageChanged();
              client.save().catch((e) => console.error("Error saving", e));
              this.composingDirty = false;
            } else if (this.composingDirty && !update.view.composing) {
              this.composingDirty = false;
              client.save().catch((e) => console.error("Error saving", e));
            }
          }
        },
      ),
      closeBrackets(),
    ],
  });
}

export function editModeExtensionsFor(
  client: Client,
  pageReadOnly: boolean,
  editorMode: "read" | "source" | "render",
): Extension {
  const isRO = pageReadOnly ||
    editorMode === "read" ||
    client.config.get<boolean>(["_boot", "readOnly"], false);
  return [
    // Widgets/decorations read this off the EditorState (read mode ⇒
    // permanently folded); reconfiguring the edit-mode compartment on
    // a mode switch refreshes it.
    readModeFacet.of(editorMode === "read"),
    isRO
      ? [EditorView.editable.of(false), EditorState.readOnly.of(true)]
      : [],
  ];
}

function createRegularKeyBindings(_client: Client): Extension {
  // Expose the @codemirror/search commands on globalThis so headless
  // tests can fire them without depending on Playwright's flaky
  // keyboard.press for macOS Meta-prefixed shortcuts.
  if (typeof globalThis !== "undefined") {
    const g = globalThis as typeof globalThis & {
      __cmCommands?: { selectNextOccurrence?: typeof selectNextOccurrence };
    };
    g.__cmCommands ??= {};
    g.__cmCommands.selectNextOccurrence = selectNextOccurrence;
  }
  return [
    // editor.md: Cmd/Ctrl+F opens find, Cmd/Ctrl+D selects the
    // next occurrence. Both come from @codemirror/search and require
    // the search() extension to be active.
    search({ top: true }),
    keymap.of([
      { key: "Mod-d", run: selectNextOccurrence, preventDefault: true },
      // editor.md: Cmd/Ctrl+←/→ = line start/end, Alt+←/→ = word jump.
      // macOS defaults already match; bind explicitly so Windows/Linux
      // (where Ctrl+arrow is conventionally a word jump) follow the
      // spec too.
      {
        key: "Mod-ArrowLeft",
        run: cursorLineBoundaryBackward,
        shift: selectLineBoundaryBackward,
        preventDefault: true,
      },
      {
        key: "Mod-ArrowRight",
        run: cursorLineBoundaryForward,
        shift: selectLineBoundaryForward,
        preventDefault: true,
      },
      { key: "Alt-ArrowLeft", run: cursorGroupLeft, shift: selectGroupLeft },
      { key: "Alt-ArrowRight", run: cursorGroupRight, shift: selectGroupRight },
      ...searchKeymap,
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
    ]),
  ];
}

export function buildMarkdownLanguageExtension(client: Client): Extension[] {
  const markdownLanguage = buildExtendedMarkdownLanguage();
  return [
    markdown({
      base: markdownLanguage,
      codeLanguages: (info) => {
        const lang = languageFor(info);
        if (lang) {
          return LanguageDescription.of({
            name: info,
            support: new LanguageSupport(lang),
          });
        }
        if (info in lazyLanguages) {
          return LanguageDescription.of({
            name: info,
            load: async () =>
              new LanguageSupport((await loadLanguageFor(info))!),
          });
        }
        return null;
      },
      addKeymap: false,
    }),
    Prec.high(
      keymap.of([
        { key: "Backspace", run: deleteMarkupBackward },
        { key: "Enter", run: insertNewlineContinueMarkup },
        { key: "Mod-a", run: smartSelectAll },
        // Tab inside a list → indent the item one level
        // (sub-list); outside a list → insert 4 spaces. The
        // explicit insert beats CodeMirror's "focus next tabbable"
        // default behaviour which is surprising inside an editor.
        {
          key: "Tab",
          run: (view) => {
            if (insideList(view)) return indentMore(view);
            view.dispatch(view.state.replaceSelection("    "));
            return true;
          },
        },
        {
          // editor.md: "Shift + Tab: outdent inside a list; no-op
          // otherwise." Consume the key even outside a list — returning
          // false would let the browser move focus out of the editor.
          key: "Shift-Tab",
          run: (view) => insideList(view) ? indentLess(view) : true,
        },
      ]),
    ),
    // editor.md §Autocomplete: `$$` → `$$|$$`. closeBrackets pairs the
    // first `$` into `$|$`, but its symmetric-close handling would let
    // the SECOND typed `$` merely type over the auto-closer (`$$|`).
    // Intercept that second `$` while the caret sits in an empty `$|$`
    // pair and grow it to display math instead.
    Prec.high(
      EditorView.inputHandler.of((view, from, to, text) => {
        if (text !== "$" || from !== to || from === 0) return false;
        const state = view.state;
        const sel = state.selection.main;
        if (!sel.empty || sel.head !== from) return false;
        if (state.sliceDoc(from - 1, from) !== "$") return false;
        if (state.sliceDoc(from, from + 1) !== "$") return false;
        // One `$` before the caret, one after the existing closer:
        // `$|$` becomes `$$|$$` with the caret centered.
        view.dispatch({
          changes: [
            { from, insert: "$" },
            { from: from + 1, insert: "$" },
          ],
          selection: { anchor: from + 1 },
          userEvent: "input.type",
          scrollIntoView: true,
        });
        return true;
      }),
    ),
    markdownLanguage.data.of({
      // editor.md §AutoPair: ( [ { " ` $ auto-close in markdown. `[[`
      // nests to `[[]]` since `[`≠`]`; `$` covers inline math. Display
      // `$$` pairs via the inputHandler above, which grows an empty
      // auto-paired `$|$` into `$$|$$` when the second `$` is typed.
      closeBrackets: { brackets: ["(", "[", "{", '"', "`", "$"] },
    }),
  ];
}
