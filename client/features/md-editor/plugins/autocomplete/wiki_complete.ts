import {
  acceptCompletion,
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { Prec } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import type { EditorCtx } from "../../../../core/ctx/editor.ts";
import type { UICtx } from "../../../../core/ctx/ui.ts";
import type { SpaceCtx } from "../../../../core/ctx/space.ts";
type Client = EditorCtx & UICtx & SpaceCtx;
import { parseMarkdown } from "../../../../capabilities/markdown/index.ts";
import { renderToText, traverseTree } from "coconote/lib/tree";
import { pageById, resolveTitle } from "../../../../capabilities/links/index.ts";
import { parseSidecar, SIDECAR_ASSET } from "../../../../core/file";
import { parseCalloutOpener } from "../../../../core/util";
import { isCodeOrCommentNode } from "../../util/util.ts";
import type { PageMeta } from "coconote/type/page";

// `[[<query>` lists titles. Sigils kept in sync with parser.ts /
// capabilities/links ref: `#heading`, `:callout label`, `%pdf name` (`@`
// named-anchor sigil is gone).
const linkTrigger = /(!?)\[\[([^\]\n#%:]*)$/;
const subTrigger = /(!?)\[\[([^\]\n#%:]+)([#%:])([^\]\n]*)$/;

const headingCache = new Map<
  string,
  {
    lastModified: string;
    headings: string[];
    calloutLabels: string[];
  }
>();

// Separate cache for PDF anchors so a stale sidecar change doesn't
// silently miss in autocomplete. Refreshed every time the trigger fires.
const pdfAnchorCache = new Map<string, { ts: number; names: string[] }>();
const PDF_CACHE_TTL_MS = 5_000;

async function loadPdfAnchors(client: Client, page: PageMeta): Promise<string[]> {
  const cached = pdfAnchorCache.get(page.id);
  if (cached && Date.now() - cached.ts < PDF_CACHE_TTL_MS) {
    return cached.names;
  }
  try {
    // Read the resolved pdf's sidecar by id via core/transport + the core
    // parse, not the pdf feature (no feature->feature edge for %name
    // completion). @sidecar addresses it without a path.
    const { data } = await client.httpSpacePrimitives.readFile({
      id: page.id,
      asset: SIDECAR_ASSET,
    });
    const names = parseSidecar(new TextDecoder().decode(data)).anchors.map(
      (a) => a.name,
    );
    pdfAnchorCache.set(page.id, { ts: Date.now(), names });
    return names;
  } catch {
    // Cache the failure as EMPTY so we don't loop fetch -> retrigger.
    pdfAnchorCache.set(page.id, { ts: Date.now(), names: [] });
    return [];
  }
}

/** Cache-validation key: the page list's lastModified for `id`, or "" when
 *  unknown. When the page later changes the key changes and the stale
 *  entry stops validating. */
function pageLastModified(client: Client, id: string): string {
  return pageById(id, client.ui.viewState.allPages)?.lastModified ?? "";
}

function getPageAnchors(client: Client, id: string): {
  loaded: boolean;
  headings: string[];
  calloutLabels: string[];
} {
  const cached = headingCache.get(id);
  if (cached && cached.lastModified === pageLastModified(client, id)) {
    return { loaded: true, ...cached };
  }
  return { loaded: false, headings: [], calloutLabels: [] };
}

async function loadPageAnchors(client: Client, id: string) {
  const lastModified = pageLastModified(client, id);
  try {
    const { text } = await client.space.readPage(id);
    const tree = parseMarkdown(text);
    const headings: string[] = [];
    traverseTree(tree, (n) => {
      // markdown.md: only H1-H4 are headings / `#heading` anchor targets.
      if (n.type && /^ATXHeading[1-4]$/.test(n.type)) {
        const level = +n.type.substring("ATXHeading".length);
        const t = renderToText(n).slice(level + 1).trim();
        if (t) headings.push(t);
      }
      return false;
    });
    const calloutLabels: string[] = [];
    for (const line of text.split("\n")) {
      const op = parseCalloutOpener(line);
      if (op?.label) calloutLabels.push(op.label);
    }
    headingCache.set(id, { lastModified, headings, calloutLabels });
  } catch {
    headingCache.set(id, { lastModified, headings: [], calloutLabels: [] });
  }
}

/** Display label for a title in the `[[` list: the bare title, or
 *  `tag/title` when several known files share that title. */
function titleLabels(pages: readonly PageMeta[], excludeId: string): Completion[] {
  const counts = new Map<string, number>();
  for (const p of pages) {
    if (!p.title) continue;
    counts.set(p.title, (counts.get(p.title) ?? 0) + 1);
  }
  const out: Completion[] = [];
  const seen = new Set<string>();
  for (const p of pages) {
    if (!p.title || p.id === excludeId) continue;
    const dup = (counts.get(p.title) ?? 0) > 1;
    const tag = p.tags?.[0];
    const label = dup && tag ? `${tag}/${p.title}` : p.title;
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ label, type: "page", apply: applyTitle(label) });
  }
  return out.sort((a, b) => (a.label < b.label ? -1 : 1));
}

function applyTitle(label: string) {
  return (view: EditorView, _c: Completion, from: number, to: number) => {
    // Don't double the closing `]]` when closeBrackets already inserted
    // them. Park the caret BEFORE the closing pair so the user can keep
    // typing #/:/%.
    const after = view.state.doc.sliceString(to, to + 2);
    const alreadyClosed = after === "]]";
    const insert = alreadyClosed ? label : label + "]]";
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + label.length },
    });
  };
}

function wikiCompletions(client: Client) {
  return (ctx: CompletionContext): CompletionResult | null => {
    if ((ctx.view as EditorView | undefined)?.composing) return null;

    for (
      let n: SyntaxNode | null = syntaxTree(ctx.state).resolveInner(ctx.pos, -1);
      n;
      n = n.parent
    ) {
      if (isCodeOrCommentNode(n.type.name)) return null;
    }

    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);
    const pages = client.ui.viewState.allPages;

    const sub = subTrigger.exec(before);
    if (sub) {
      const [, , titleQuery, sep, query] = sub;
      const queryStart = ctx.pos - query.length;
      const resolved = resolveTitle(titleQuery, pages);
      if (resolved.state !== "hit") {
        return { from: queryStart, to: ctx.pos, options: [] };
      }
      const page = pageById(resolved.id, pages);
      if (!page) return { from: queryStart, to: ctx.pos, options: [] };

      // `%` pdf-name path: list the resolved PDF's named highlights.
      if (sep === "%") {
        const cached = pdfAnchorCache.get(page.id);
        if (!cached) {
          void loadPdfAnchors(client, page).then(() => {
            if (!ctx.view) return;
            import("@codemirror/autocomplete").then(({ startCompletion }) => {
              startCompletion(ctx.view!);
            });
          });
          return { from: queryStart, to: ctx.pos, options: [] };
        }
        void loadPdfAnchors(client, page);
        return {
          from: queryStart,
          to: ctx.pos,
          options: cached.names.map((n) => ({ label: n, type: "anchor" })),
          validFor: /^[^\]\n#%:]*$/,
        };
      }

      const { loaded, headings, calloutLabels } = getPageAnchors(client, page.id);
      if (!loaded) {
        void loadPageAnchors(client, page.id).then(() => {
          if (!ctx.view) return;
          import("@codemirror/autocomplete").then(({ startCompletion }) => {
            startCompletion(ctx.view!);
          });
        });
      }
      const pool = sep === "#" ? headings : calloutLabels; // sep === ":"
      const optType = sep === "#" ? "heading" : "label";
      return {
        from: queryStart,
        to: ctx.pos,
        options: pool.map((h) => ({ label: h, type: optType })),
        validFor: /^[^\]\n#%:]*$/,
      };
    }

    const main = linkTrigger.exec(before);
    if (!main) return null;
    const [, , query] = main;
    const queryStart = ctx.pos - query.length;
    // SPEC: typing `[[` lists known-file titles (duplicates as tag/title).
    return {
      from: queryStart,
      to: ctx.pos,
      options: titleLabels(pages, client.currentId()),
      // Sigil chars (# % :) and `|` must INVALIDATE so the source re-runs
      // and switches to heading/label/pdf-name completion.
      validFor: /^[^\]\n#%:|]*$/,
    };
  };
}

export function wikiCompletionPlugin(client: Client) {
  return [
    autocompletion({
      override: [wikiCompletions(client)],
      activateOnTyping: true,
      closeOnBlur: true,
      maxRenderedOptions: 50,
    }),
    // editor.md: "Press Tab or Enter to select a candidate" - the default
    // completionKeymap only binds Enter. Prec.highest so Tab outranks the
    // snippet-expansion and indent handlers while the popup is open.
    Prec.highest(keymap.of([{ key: "Tab", run: acceptCompletion }])),
  ];
}
