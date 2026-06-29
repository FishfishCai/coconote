import { type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { EditorCtx } from "../../../../core/ctx/editor.ts";
import type { SpaceCtx } from "../../../../core/ctx/space.ts";
import type { UICtx } from "../../../../core/ctx/ui.ts";
import type { NavigationCtx } from "../../../../core/ctx/navigation.ts";
type Client = EditorCtx & SpaceCtx & UICtx & NavigationCtx;
import { decoratorStateField, isCursorInRange } from "../../util/util.ts";
import { extractFrontmatter } from "../../../../core/file";
import { titleForId } from "../../../../capabilities/links/index.ts";

export function frontmatterPlugin(client: Client) {
  return decoratorStateField((state: EditorState) => {
    const widgets: Range<Decoration>[] = [];
    syntaxTree(state).iterate({
      enter({ name, from, to }) {
        if (name !== "FrontMatter") return;
        if (isCursorInRange(state, [from, to])) return false;
        const startLine = state.doc.lineAt(from).number;
        const endLine = state.doc.lineAt(to).number;
        for (let n = startLine; n <= endLine; n++) {
          const line = state.doc.line(n);
          // `display: none` measures row as 0px in both DOM and CM's
          // heightMap so clicks below the frontmatter don't drift.
          // (`coconote-line-table-outside` is a legacy name - it's the
          // generic hide-this-line class, nothing table-specific.)
          widgets.push(
            Decoration.line({ class: "coconote-line-table-outside" }).range(line.from),
          );
        }
        const source = state.doc.sliceString(from, to);
        const fm = extractFrontmatter(source);
        // Insertion lands on the line AFTER the opening `---` fence so
        // CRLF (Windows) and LF (Unix) frontmatters both target the
        // right offset without a hand-counted `+4`.
        const bodyFrom = state.doc.line(startLine + 1).from;
        widgets.push(
          Decoration.widget({
            widget: new FrontmatterChip(
              client,
              bodyFrom,
              fm.title,
              fm.tags ?? [],
              fm.refs ?? [],
              fm.backrefs ?? [],
            ),
            block: true,
            side: -1,
          }).range(state.doc.line(startLine).from),
        );
        return false;
      },
    });
    return Decoration.set(widgets, true);
  });
}

class FrontmatterChip extends WidgetType {
  constructor(
    readonly client: Client,
    readonly insertPos: number,
    readonly title: string | undefined,
    readonly tags: string[],
    readonly refs: string[],
    readonly backrefs: string[],
  ) {
    super();
  }
  override get estimatedHeight(): number {
    return 32;
  }
  toDOM(): HTMLElement {
    const div = document.createElement("div");
    div.className = "coconote-frontmatter-chip-block";
    const chip = document.createElement("span");
    chip.className = "coconote-frontmatter-chip";
    chip.title = "Click to edit frontmatter";
    chip.textContent = this.title ?? "frontmatter";
    chip.addEventListener("mousedown", (e) => {
      if (!isPlainLeftMouse(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const view = this.client.editorView;
      view.dispatch({
        selection: { anchor: this.insertPos },
        effects: EditorView.scrollIntoView(this.insertPos),
      });
      view.focus();
    });
    div.appendChild(chip);
    // Tags are display-only metadata here (the recent list is where tag
    // filtering happens, SPEC tag section).
    for (const tag of this.tags) {
      const tagEl = document.createElement("span");
      tagEl.className = "coconote-frontmatter-tag";
      tagEl.textContent = `#${tag}`;
      div.appendChild(tagEl);
    }
    // refs / backrefs: ID lists, rendered as the target's current title
    // and navigable by id. refs jump out; backrefs jump to "who refs me".
    const pages = this.client.ui.viewState.allPages;
    const addRefChip = (id: string, cls: string, prefix: string) => {
      const el = document.createElement("span");
      el.className = cls;
      el.textContent = `${prefix} ${titleForId(id, pages) ?? id}`;
      el.style.cursor = "pointer";
      el.addEventListener("mousedown", (e) => {
        if (!isPlainLeftMouse(e)) return;
        e.preventDefault();
        e.stopPropagation();
        void this.client.navigate({ id });
      });
      div.appendChild(el);
    };
    for (const id of this.refs) {
      addRefChip(id, "coconote-frontmatter-refs", "->");
    }
    for (const id of this.backrefs) {
      addRefChip(id, "coconote-frontmatter-backrefs", "<-");
    }
    return div;
  }
  override eq(other: WidgetType): boolean {
    return other instanceof FrontmatterChip &&
      other.title === this.title &&
      sameList(other.tags, this.tags) &&
      sameList(other.refs, this.refs) &&
      sameList(other.backrefs, this.backrefs);
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Modifier keys (cmd/ctrl/shift/alt) and middle/right buttons keep their
// browser-native meaning (text-drag start, context menu, etc.). We only
// treat a plain left mousedown as "chip click".
function isPlainLeftMouse(e: MouseEvent): boolean {
  return e.button === 0 &&
    !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}
