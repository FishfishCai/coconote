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
import type { ClientContext as Client } from "../../../core/context.ts";
import { parseMarkdown } from "../../../markdown/parser/parser.ts";
import {
  traverseTree,
  renderToText,
} from "coconote/lib/tree";
import { resolvePdfWikiLinkPath } from "../../../markdown/wiki_link_resolver.ts";
import { resolveWikiLink, shortestLocator } from "../../../lib/wikilink.ts";
import { parseCalloutOpener } from "../../../lib/callout.ts";
import { isCodeOrCommentNode } from "../../util/util.ts";

const linkTrigger = /(!?)\[\[([^\]\n#@%:]*)$/;
// `[[<page>#<query>` (heading), `[[<page>@<query>` (anchor),
// `[[<page>%<query>` (PDF anchor), `[[<page>:<query>` (callout
// label). Sigils kept in sync with parser.ts NamedAnchor /
// lib/ref.ts refRegex.
const subTrigger = /(!?)\[\[([^\]\n#@%:]+)([#@%:])([^\]\n]*)$/;

const headingCache = new Map<
  string,
  {
    lastModified: string;
    headings: string[];
    anchors: string[];
    /** Callout opener labels — `::: theorem:mylabel` → "mylabel". */
    calloutLabels: string[];
  }
>();

// Separate cache for PDF anchors so a stale notes.json change doesn't
// silently miss in autocomplete; refreshed every time the trigger fires.
const pdfAnchorCache = new Map<string, { ts: number; names: string[] }>();
const PDF_CACHE_TTL_MS = 5_000;

async function loadPdfAnchors(pdfPath: string): Promise<string[]> {
  const cached = pdfAnchorCache.get(pdfPath);
  if (cached && Date.now() - cached.ts < PDF_CACHE_TTL_MS) {
    return cached.names;
  }
  try {
    const { loadSidecar } = await import("../../../pdf/notes_client.ts");
    const notes = await loadSidecar(pdfPath);
    const names = notes.anchors.map((a) => a.name);
    pdfAnchorCache.set(pdfPath, { ts: Date.now(), names });
    return names;
  } catch {
    // Cache the failure as an EMPTY entry: an absent entry is
    // indistinguishable from "not loaded yet", so bailing without
    // caching loops fetch → startCompletion → fetch forever. The TTL
    // retries after 5 s.
    pdfAnchorCache.set(pdfPath, { ts: Date.now(), names: [] });
    return [];
  }
}

/** Cache key the heading cache is validated against: the page list's
 *  lastModified, or "" when the page isn't listed (doesn't exist yet).
 *  When the page later changes / appears, the key changes and the
 *  stale entry stops validating. */
function pageListLastModified(client: Client, pageName: string): string {
  return client.ui.viewState.allPages.find((p) => p.name === pageName)
    ?.lastModified ?? "";
}

function getPageAnchors(client: Client, pageName: string): {
  /** False ⇒ no valid cache entry — caller should kick loadPageAnchors. */
  loaded: boolean;
  headings: string[];
  anchors: string[];
  calloutLabels: string[];
} {
  const cached = headingCache.get(pageName);
  // An entry with ZERO names is still a loaded entry (the page may
  // genuinely have no headings/anchors/labels) — "loaded" must be
  // explicit, or the completion source refetches + re-triggers itself
  // forever for such pages.
  if (cached && cached.lastModified === pageListLastModified(client, pageName)) {
    return { loaded: true, ...cached };
  }
  return { loaded: false, headings: [], anchors: [], calloutLabels: [] };
}

async function loadPageAnchors(client: Client, pageName: string) {
  // Key the entry on what getPageAnchors will validate against, so
  // one write satisfies the next lookup.
  const lastModified = pageListLastModified(client, pageName);
  try {
    const { text } = await client.space.readPage(pageName);
    const tree = parseMarkdown(text);
    const headings: string[] = [];
    const anchors: string[] = [];
    traverseTree(tree, (n) => {
      if (n.type?.startsWith("ATXHeading")) {
        const level = +n.type.substring("ATXHeading".length);
        const text = renderToText(n).slice(level + 1).trim();
        if (text) headings.push(text);
      }
      if (n.type === "NamedAnchor") {
        const text = renderToText(n).replace(/^@/, "").trim();
        if (text) anchors.push(text);
      }
      return false;
    });
    // Callout labels live in plain text (the parser keeps `::: ...`
    // as a FencedDivOpener but we don't traverse there yet); a flat
    // line scan is the cheapest correct approach.
    const calloutLabels: string[] = [];
    for (const line of text.split("\n")) {
      const op = parseCalloutOpener(line);
      if (op?.label) calloutLabels.push(op.label);
    }
    headingCache.set(pageName, {
      lastModified,
      headings,
      anchors,
      calloutLabels,
    });
  } catch {
    // Page may not exist yet. Still cache an empty entry — leaving the
    // cache unwritten would loop fetch → startCompletion → fetch.
    headingCache.set(pageName, {
      lastModified,
      headings: [],
      anchors: [],
      calloutLabels: [],
    });
  }
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

    const sub = subTrigger.exec(before);
    if (sub) {
      const [, , pageName, sep, query] = sub;
      const queryStart = ctx.pos - query.length;
      // PDF anchor path: pageName looks like "foo.pdf" or "notes/x.pdf".
      // Resolve against allKnownFiles first so nested PDFs (basename
      // match) hit the right sidecar.
      if (sep === "%" && pageName.toLowerCase().endsWith(".pdf")) {
        const resolved = resolvePdfWikiLinkPath(
          pageName,
          client.currentPath?.(),
          client.allKnownFiles,
          client.ui.viewState.allPages,
        );
        const cached = pdfAnchorCache.get(resolved);
        if (!cached) {
          // Kick load + re-trigger so the popup fills without a
          // second keystroke.
          void loadPdfAnchors(resolved).then(() => {
            if (!ctx.view) return;
            import("@codemirror/autocomplete").then(({ startCompletion }) => {
              startCompletion(ctx.view!);
            });
          });
          return { from: queryStart, to: ctx.pos, options: [] };
        }
        // Serve the cached names, refreshing in the background once
        // the TTL lapses (loadPdfAnchors no-ops while fresh) so a
        // failed / stale sidecar heals without a reload. No
        // startCompletion here — the next keystroke re-queries, so
        // this cannot re-trigger itself into a loop.
        void loadPdfAnchors(resolved);
        const options: Completion[] = cached.names.map((n) => ({
          label: n,
          type: "anchor",
        }));
        return {
          from: queryStart,
          to: ctx.pos,
          options,
          validFor: /^[^\]\n#@%]*$/,
        };
      }
      // Resolve the user-typed shorthand (bare title/filename) to a
      // real page name so we can find the file in allPages and read
      // it via space.readPage. Without this, `[[markdown#` looks
      // for `markdown.md` at vault root and gets nothing.
      const resolved = resolveWikiLink(pageName, client.ui.viewState.allPages);
      const fullName = resolved.kind === "ok" ? resolved.page.name : pageName;
      const { loaded, headings, anchors, calloutLabels } = getPageAnchors(
        client,
        fullName,
      );
      if (!loaded) {
        // Kick the async load AND re-trigger completion after it
        // lands so the popup refills without a second keystroke.
        // loadPageAnchors caches even empty / failed results, so the
        // re-entry sees `loaded` and does not loop.
        void loadPageAnchors(client, fullName).then(() => {
          if (!ctx.view) return;
          import("@codemirror/autocomplete").then(({ startCompletion }) => {
            startCompletion(ctx.view!);
          });
        });
      }
      const pool = sep === "#"
        ? headings
        : sep === "@"
        ? anchors
        : calloutLabels; // sep === ":"
      const optType = sep === "#"
        ? "heading"
        : sep === "@"
        ? "anchor"
        : "label";
      const options: Completion[] = pool.map((h) => ({
        label: h,
        type: optType,
      }));
      return {
        from: queryStart,
        to: ctx.pos,
        options,
        validFor: /^[^\]\n#@%]*$/,
      };
    }

    const main = linkTrigger.exec(before);
    if (!main) return null;
    const [, , query] = main;
    const queryStart = ctx.pos - query.length;
    const allPages = client.ui.viewState.allPages;
    const options: Completion[] = allPages.map((p) => {
      // Insert the shortest locator that unambiguously points at
      // this page (filename > title > tag/key > path-prefix/key).
      // Falls back to p.name if everything's ambiguous.
      const label = shortestLocator(p, allPages);
      return {
        label,
        detail: p.title && p.title !== label ? p.title : undefined,
        type: "page",
        apply: (view, _completion, from, to) => {
          // Don't double the closing `]]` when closeBrackets already
          // auto-inserted them on `[[`. Park the caret BEFORE the
          // closing pair so the user can keep typing #/anchor/etc.
          const after = view.state.doc.sliceString(to, to + 2);
          const alreadyClosed = after === "]]";
          const insert = alreadyClosed ? label : label + "]]";
          view.dispatch({
            changes: { from, to, insert },
            selection: { anchor: from + label.length },
          });
        },
      };
    });
    return {
      from: queryStart,
      to: ctx.pos,
      options,
      // Sigil chars (# @ % :) and `|` must INVALIDATE the result so
      // the source re-runs and switches to heading/anchor/pdf-anchor/
      // label completion — leaving `:`/`%` out kept the page-list
      // result alive and those popups never appeared.
      validFor: /^[^\]\n#@%:|]*$/,
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
    // editor.md: "Press Tab or Enter to select a candidate" — the
    // default completionKeymap only binds Enter. Prec.highest so Tab
    // outranks the snippet-expansion and indent handlers while the
    // popup is open; acceptCompletion returns false when no completion
    // is active, letting Tab fall through to those.
    Prec.highest(keymap.of([{ key: "Tab", run: acceptCompletion }])),
  ];
}
