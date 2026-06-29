import {
  addParentPointers,
  findNodeOfType,
  type ParseTree,
  renderToText,
} from "coconote/lib/tree";
import katex from "katex";
import { Fragment, Raw, renderHtml, type Tag } from "./html_render.ts";
import { createMediaElement } from "./inline.ts";
import { parseTransclusion } from "../transclusion.ts";
import { errMessage } from "coconote/constants";

export type MarkdownRenderOptions = {
  /** Resolve a wikilink name (title / tag/title) to its display title
   *  (SPEC: a chip always shows the target's current `title`). Returns
   *  undefined when unknown, so the renderer falls back to the raw text. */
  wikiLinkTitle?: (name: string) => string | undefined;
  /** The owning file id, so local image embeds resolve to
   *  `/.file?id=<owner>&asset=<filename>`. */
  assetOwnerId?: string;
};

function cleanTags(values: (Tag | null)[], cleanWhitespace = false): Tag[] {
  const result: Tag[] = [];
  for (const value of values) {
    if (cleanWhitespace && typeof value === "string" && value.match(/^\s+$/)) {
      continue;
    }
    if (value) result.push(value);
  }
  return result;
}

// Per-column alignment from a GFM delimiter row (`:---` left, `:---:`
// center, `---:` right, plain dashes none).
function tableAlignments(delimiterRow: string): (string | null)[] {
  return delimiterRow
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((col) => {
      const c = col.trim();
      const left = c.startsWith(":");
      const right = c.endsWith(":");
      if (left && right) return "center";
      if (right) return "right";
      if (left) return "left";
      return null;
    });
}

// markdown.md Quote Block: only the FIRST `>` on each line is the quote
// marker; any further `>` on the line is plain text. lezer nests `> >` as
// nested Blockquotes, so flatten every nested Blockquote into the single
// outer level: drop each line's first `>` (it draws the border) and emit
// any later `>` as literal text. `bqText` is the outer blockquote's source
// and `bqFrom` its document offset, so a mark's line prefix is checked the
// same way the live editor does (hide_marks.ts).
function quoteBody(
  t: ParseTree,
  options: MarkdownRenderOptions,
  bqText: string,
  bqFrom: number,
): (Tag | null)[] {
  const out: (Tag | null)[] = [];
  for (const c of t.children ?? []) {
    if (c.type === "Blockquote") {
      out.push(...quoteBody(c, options, bqText, bqFrom));
    } else if (c.type === "QuoteMark") {
      const rel = (c.from ?? bqFrom) - bqFrom;
      const lineStart = bqText.lastIndexOf("\n", rel - 1) + 1;
      // Only-whitespace prefix => this is the line's first `>` (the
      // marker, dropped). Otherwise it is a literal `>`.
      if (!/^\s*$/.test(bqText.slice(lineStart, rel))) out.push(renderToText(c));
    } else {
      out.push(render(c, options));
    }
  }
  return out;
}

function render(t: ParseTree, options: MarkdownRenderOptions = {}): Tag | null {
  if (t.type?.endsWith("Mark") || t.type?.endsWith("Delimiter")) return null;
  const mapRender = (children: ParseTree[]) =>
    children.map((c) => render(c, options));
  switch (t.type) {
    case "Document":
      return { name: Fragment, body: cleanTags(mapRender(t.children!)) };
    case "FrontMatter":
      return null;
    case "Highlight": {
      // markdown.md: highlight can't combine with bold/italic/strike.
      // If it's nested inside one, render the inner text without <mark>
      // so the invalid combination doesn't produce stacked styling.
      for (let p = t.parent; p; p = p.parent) {
        if (
          p.type === "Emphasis" || p.type === "StrongEmphasis" ||
          p.type === "Strikethrough"
        ) {
          return { name: Fragment, body: cleanTags(mapRender(t.children!)) };
        }
      }
      return { name: "mark", body: cleanTags(mapRender(t.children!)) };
    }
    case "ATXHeading1":
    case "ATXHeading2":
    case "ATXHeading3":
    case "ATXHeading4": {
      // markdown.md: "Four levels of headings." H5 / H6 are not in
      // spec - they hit the default branch and render as raw text
      // (including the `#####` marks).
      const level = t.type.slice(-1);
      return { name: `h${level}`, body: cleanTags(mapRender(t.children!)) };
    }
    case "Paragraph":
      return {
        name: "span",
        attrs: { class: "p" },
        body: cleanTags(mapRender(t.children!)),
      };
    case "FencedCode":
    case "CodeBlock": {
      const lang = findNodeOfType(t, "CodeInfo");
      // Drop whitespace text nodes between fence markers/info/text. The
      // local filtered copy avoids mutating the shared parse tree.
      const codeChildren = t.children!.filter((c) => c.type);
      return {
        name: "pre",
        attrs: { "data-lang": lang ? lang.children![0].text : undefined },
        body: cleanTags(mapRender(codeChildren)),
      };
    }
    case "CodeInfo":
      return null;
    case "CodeText":
      return t.children![0].text!;
    case "Blockquote":
      // Render ONE level; nested `> >` collapses here with later `>`
      // kept as literal text (markdown.md Quote Block).
      return {
        name: "blockquote",
        body: cleanTags(quoteBody(t, options, renderToText(t), t.from ?? 0)),
      };
    case "HardBreak":
      return { name: "br", body: "" };
    case "Emphasis":
      return { name: "em", body: cleanTags(mapRender(t.children!)) };
    case "Strikethrough":
      return { name: "del", body: cleanTags(mapRender(t.children!)) };
    case "InlineCode":
      return {
        name: "code",
        attrs: { class: "coconote-code" },
        body: cleanTags(mapRender(t.children!)),
      };
    case "BulletList":
      return { name: "ul", body: cleanTags(mapRender(t.children!), true) };
    case "OrderedList":
      return { name: "ol", body: cleanTags(mapRender(t.children!), true) };
    case "ListItem":
      return { name: "li", body: cleanTags(mapRender(t.children!), true) };
    case "StrongEmphasis":
      return { name: "strong", body: cleanTags(mapRender(t.children!)) };
    case "HorizontalRule":
      return { name: "hr", body: "" };
    case "Table": {
      // The direct TableDelimiter child is the alignment row. The `|`
      // marks are also TableDelimiter but sit inside header/row nodes,
      // where the TableCell filter below drops them.
      const kids = t.children!;
      const delimiter = kids.find((c) => c.type === "TableDelimiter");
      const aligns = delimiter ? tableAlignments(renderToText(delimiter)) : [];
      const row = (r: ParseTree, cellTag: "th" | "td"): Tag => ({
        name: "tr",
        body: r.children!
          .filter((c) => c.type === "TableCell")
          .map((cell, i): Tag => ({
            name: cellTag,
            attrs: aligns[i]
              ? { style: `text-align:${aligns[i]}` }
              : undefined,
            body: cleanTags(mapRender(cell.children!)),
          })),
      });
      const header = kids.find((c) => c.type === "TableHeader");
      const rows = kids.filter((c) => c.type === "TableRow");
      const parts: Tag[] = [];
      if (header) parts.push({ name: "thead", body: [row(header, "th")] });
      if (rows.length > 0) {
        parts.push({ name: "tbody", body: rows.map((r) => row(r, "td")) });
      }
      return { name: "table", body: parts };
    }
    case "Link":
    case "Autolink":
      // markdown.md has no standard `[text](url)` link or `<url>` autolink
      // syntax: the only navigable form is the wiki link. Render the
      // literal source text so nothing is silently dropped.
      return renderToText(t);
    case "Image": {
      const text = renderToText(t);
      const transclusion = parseTransclusion(text);
      if (!transclusion) return text;
      try {
        const element = createMediaElement(transclusion, options.assetOwnerId);
        if (!element) return text;
        const attrs = Array.from(element.attributes).reduce(
          (obj, attr) => {
            obj[attr.name] = attr.value;
            return obj;
          },
          {} as Record<string, string>,
        );
        // The live editor swaps a broken image for a text link via img.onerror
        // (inline.ts) - a JS property that does not serialize into
        // element.attributes, so the static path lost the fallback and showed
        // the browser's broken-image icon. Re-attach it as an inline onerror.
        if (element.tagName === "IMG") {
          attrs.onerror =
            "this.replaceWith(Object.assign(document.createElement('a')," +
            "{href:this.src,textContent:this.alt||this.src," +
            "target:'_blank',rel:'noopener'}))";
        }
        // Lower-case so a void element renders as <img ...>, not <IMG ...>.
        return { name: element.tagName.toLowerCase(), attrs, body: "" };
      } catch (e: unknown) {
        console.error("Error rendering image/transclusion", errMessage(e));
        return { name: "span", body: "Error loading image" };
      }
    }
    case "WikiLink": {
      const link = findNodeOfType(t, "WikiLinkPage")!.children![0].text!;
      // SPEC: a chip shows the target's current title, falling back to the
      // raw link when the title is unknown. An explicit alias always wins.
      let linkText = options.wikiLinkTitle?.(link) ?? link;
      const aliasNode = findNodeOfType(t, "WikiLinkAlias");
      if (aliasNode) linkText = aliasNode.children![0].text!;
      // Static render: the chip is non-navigable (export degrades it to a
      // span); keep data-ref for the export post-processor.
      return {
        name: "a",
        attrs: { href: "#", class: "wiki-link", "data-ref": link },
        body: linkText,
      };
    }
    case "Math": {
      // One node type covers both forms - the delimiter length ($$ vs $)
      // tells display from inline (parser.ts MathConfig).
      const text = renderToText(t);
      const displayMode = text.startsWith("$$");
      const d = displayMode ? 2 : 1;
      let html: string;
      try {
        html = katex.renderToString(text.slice(d, -d).trim(), {
          displayMode,
          throwOnError: false,
          output: "html",
        });
      } catch (e: unknown) {
        // Mirror the live editor (tex.ts): a formula that makes KaTeX throw
        // despite throwOnError:false degrades to an inline error - it must not
        // bubble out and blank the whole export / hover-preview render.
        return {
          name: "span",
          attrs: { class: "coconote-tex-error" },
          body: `[TeX error: ${errMessage(e)}]`,
        };
      }
      return {
        name: displayMode ? "div" : "span",
        attrs: {
          class: displayMode ? "coconote-tex-display" : "coconote-tex-inline",
        },
        body: [{ name: Raw, body: html }],
      };
    }
    case "Escape":
      return {
        name: "span",
        attrs: { class: "escape" },
        body: t.children![0].text!.slice(1),
      };
    case "Entity":
      return t.children![0].text!;
    case undefined:
      return t.text!;
    default:
      return renderToText(t);
  }
}

export function renderMarkdownToHtml(
  t: ParseTree,
  options: MarkdownRenderOptions = {},
) {
  // The Highlight case walks t.parent, and callers on the render path
  // (hover preview) don't run addParentPointers - set them here or the
  // guard is a no-op. The emitted Tag tree is separate from the parse
  // tree, so the cycles this introduces are never serialized.
  addParentPointers(t);
  const htmlTree = render(t, options);
  return renderHtml(htmlTree);
}
