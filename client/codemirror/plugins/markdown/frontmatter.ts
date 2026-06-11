import { type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { ClientContext as Client } from "../../../core/context.ts";
import { decoratorStateField, isCursorInRange } from "../../util/util.ts";
import { extractFrontmatter } from "../../../markdown/frontmatter.ts";
import { toPath } from "../../../lib/ref.ts";
import { resolveWikiLink } from "../../../lib/wikilink.ts";

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
              fm.tag ?? [],
              fm.prereq ?? [],
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
    readonly prereq: string[],
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
    for (const tag of this.tags) {
      const tagEl = document.createElement("span");
      tagEl.className = "coconote-frontmatter-tag";
      tagEl.textContent = `#${tag}`;
      tagEl.title = "Click to filter Content by this tag";
      tagEl.style.cursor = "pointer";
      tagEl.addEventListener("mousedown", (e) => {
        if (!isPlainLeftMouse(e)) return;
        e.preventDefault();
        e.stopPropagation();
        // content.md: clicking a tag chip "jumps to tag view and
        // auto-fills that tag into the filter". Route through the
        // navigator so the URL becomes /.content/tag (each view owns
        // a URL), then seed the filter.
        this.client.navigateRoute({ kind: "content", view: "tag" });
        this.client.ui.showContentBrowser(tag);
      });
      div.appendChild(tagEl);
    }
    for (const page of this.prereq) {
      const pEl = document.createElement("span");
      pEl.className = "coconote-frontmatter-prereq";
      pEl.textContent = `← ${page}`;
      // Click prereq chip -> jump to the page it references, using the
      // same locator grammar as `[[..]]` wiki links.
      pEl.style.cursor = "pointer";
      pEl.addEventListener("mousedown", (e) => {
        if (!isPlainLeftMouse(e)) return;
        e.preventDefault();
        e.stopPropagation();
        const r = resolveWikiLink(page, this.client.ui.viewState.allPages);
        if (r.kind === "ok") {
          this.client.navigate({ path: toPath(r.page.name) });
        } else if (r.kind === "ambiguous") {
          console.error(
            `Ambiguous prereq "${page}": ${
              r.pages.map((p) => p.name).join(", ")
            }`,
          );
        } else {
          console.error(`No page matches prereq "${page}"`);
        }
      });
      div.appendChild(pEl);
    }
    return div;
  }
  override eq(other: WidgetType): boolean {
    return other instanceof FrontmatterChip &&
      other.title === this.title &&
      other.tags.length === this.tags.length &&
      other.tags.every((t, i) => t === this.tags[i]) &&
      other.prereq.length === this.prereq.length &&
      other.prereq.every((p, i) => p === this.prereq[i]);
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

// Modifier keys (cmd/ctrl/shift/alt) and middle/right buttons keep their
// browser-native meaning (text-drag start, context menu, etc.). We only
// treat a plain left mousedown as "chip click".
function isPlainLeftMouse(e: MouseEvent): boolean {
  return e.button === 0 &&
    !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}
