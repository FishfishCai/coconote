import {
  addParentPointers,
  findNodeOfType,
  type ParseTree,
  renderToText,
} from "coconote/lib/tree";
import {
  encodePageURI,
  encodeRef,
  parseToRef,
} from "coconote/lib/ref";
import { Fragment, renderHtml, type Tag } from "./html_render.ts";
import { createMediaElement } from "./inline.ts";
import { parseTransclusion } from "coconote/lib/transclusion";
import { errMessage } from "coconote/constants";

export type MarkdownRenderOptions = {
  shortWikiLinks?: boolean;
  translateUrls?: (url: string, type: "link") => string;
};

// Allow only safe URL schemes on rendered links. The output HTML is
// written to innerHTML (hover preview), so a `javascript:` / `data:` /
// `vbscript:` href would execute. Control chars are stripped first
// because browsers ignore them when parsing the scheme (`java\tscript:`).
function safeHref(url: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional
  const cleaned = url.replace(/[\u0000-\u0020]+/g, "");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned);
  if (scheme && !/^(https?|mailto)$/i.test(scheme[1])) return "#";
  return url;
}

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

function render(t: ParseTree, options: MarkdownRenderOptions = {}): Tag | null {
  if (t.type?.endsWith("Mark") || t.type?.endsWith("Delimiter")) return null;
  const mapRender = (children: ParseTree[]) =>
    children.map((c) => render(c, options));
  switch (t.type) {
    case "Document":
      return { name: Fragment, body: cleanTags(mapRender(t.children!)) };
    case "FrontMatter":
    case "CommentBlock":
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
      return {
        name: "blockquote",
        body: cleanTags(mapRender(t.children!)),
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
    case "Link": {
      // Link body = children between the outer `[` and `]` LinkMarks.
      // LinkTitle / URL live outside that range.
      const kids = t.children ?? [];
      const firstMark = kids.findIndex((c) => c.type === "LinkMark");
      const closeMark =
        firstMark >= 0 ? kids.findIndex((c, i) =>
          i > firstMark && c.type === "LinkMark" && c.text === "]"
        ) : -1;
      const linkTextChildren = (firstMark >= 0 && closeMark > firstMark)
        ? kids.slice(firstMark + 1, closeMark)
        : kids;
      const urlNode = findNodeOfType(t, "URL");
      if (!urlNode) return renderToText(t);
      return {
        name: "a",
        attrs: {
          href: safeHref(urlNode.children![0].text!),
          target: "_blank",
        },
        body: cleanTags(mapRender(linkTextChildren)),
      };
    }
    case "Autolink": {
      const urlNode = findNodeOfType(t, "URL");
      if (!urlNode) return renderToText(t);
      const url = urlNode.children![0].text!;
      return {
        name: "a",
        attrs: { href: safeHref(url), target: "_blank" },
        body: url,
      };
    }
    case "Image": {
      const text = renderToText(t);
      const transclusion = parseTransclusion(text);
      if (!transclusion) return text;
      try {
        const element = createMediaElement(transclusion);
        if (!element) return text;
        return {
          name: element.tagName,
          attrs: Array.from(element.attributes).reduce(
            (obj, attr) => {
              obj[attr.name] = attr.value;
              return obj;
            },
            {} as Record<string, string>,
          ),
          body: "",
        };
      } catch (e: unknown) {
        console.error("Error rendering image/transclusion", errMessage(e));
        return { name: "span", body: "Error loading image" };
      }
    }
    case "WikiLink": {
      const link = findNodeOfType(t, "WikiLinkPage")!.children![0].text!;
      let linkText = options.shortWikiLinks === true
        ? link.split("/").pop()!
        : link;
      const aliasNode = findNodeOfType(t, "WikiLinkAlias");
      if (aliasNode) linkText = aliasNode.children![0].text!;
      let href = "#";
      const ref = parseToRef(link);
      if (ref) href = `/${encodePageURI(encodeRef(ref))}`;
      return {
        name: "a",
        attrs: { href, class: "wiki-link", "data-ref": link },
        body: linkText,
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

function traverseTag(t: Tag, fn: (t: Tag) => void) {
  fn(t);
  if (typeof t === "string") return;
  // body is `Tag[] | string` - iterating a string here yields chars.
  if (Array.isArray(t.body)) for (const child of t.body) traverseTag(child, fn);
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
  if (htmlTree) {
    traverseTag(htmlTree, (t) => {
      if (typeof t === "string") return;
      if (t.name === "a" && t.attrs!.href) {
        if (options.translateUrls) {
          t.attrs!.href = options.translateUrls!(t.attrs!.href, "link");
        }
        if (t.body.length === 0) t.body = [t.attrs!.href];
      }
    });
  }
  return renderHtml(htmlTree);
}
