import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../parser/parser.ts";
import { renderMarkdownToHtml } from "./markdown_render.ts";

function html(md: string): string {
  return renderMarkdownToHtml(parseMarkdown(md));
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// markdown.md Quote Block: only the first `>` per line is the marker;
// any further `>` is literal text (rendered as the escaped `&gt;`).
describe("renderMarkdownToHtml: quote block", () => {
  it("renders a single-level quote with no literal `>`", () => {
    const out = html("> hello");
    expect(count(out, "<blockquote>")).toBe(1);
    expect(out).toContain("hello");
    expect(out).not.toContain("&gt;");
  });

  it("collapses `> >` to one level, the second `>` literal", () => {
    const out = html("> > nested");
    expect(count(out, "<blockquote>")).toBe(1);
    expect(count(out, "&gt;")).toBe(1);
    expect(out).toContain("nested");
  });

  it("keeps only each line's first `>` as the marker", () => {
    const out = html("> outer\n> > nested\n> > > deepest");
    expect(count(out, "<blockquote>")).toBe(1);
    // line 2 -> one literal `>`, line 3 -> two literal `>`.
    expect(count(out, "&gt;")).toBe(3);
    for (const w of ["outer", "nested", "deepest"]) expect(out).toContain(w);
  });

  it("still renders inline marks inside a quote", () => {
    expect(html("> **bold** text")).toContain("<strong>");
  });
});

// markdown.md: "Four levels of headings." H5/H6 are not headings and
// render literally, marks included (matching hide_marks.ts in the editor).
describe("renderMarkdownToHtml: headings are H1-H4 only", () => {
  it("renders H1-H4 as heading tags", () => {
    expect(html("# a")).toContain("<h1>");
    expect(html("#### d")).toContain("<h4>");
  });

  it("renders H5/H6 literally (no heading tag, marks kept)", () => {
    const h5 = html("##### five");
    expect(h5).not.toContain("<h5");
    expect(h5).toContain("##### five");
    const h6 = html("###### six");
    expect(h6).not.toContain("<h6");
    expect(h6).toContain("###### six");
  });
});

// markdown.md: highlight cannot combine with bold/italic/strike.
describe("renderMarkdownToHtml: highlight cannot combine", () => {
  it("drops <mark> when highlight nests in bold/italic/strike", () => {
    const bold = html("**==x==**");
    expect(bold).toContain("<strong>");
    expect(bold).not.toContain("<mark>");
    expect(html("*==y==*")).not.toContain("<mark>");
    expect(html("~~==z==~~")).not.toContain("<mark>");
  });

  it("keeps <mark> for a plain highlight", () => {
    expect(html("==hi==")).toContain("<mark>");
  });

  it("renders literal `**` inside a highlight (highlight is opaque)", () => {
    const out = html("==**a**==");
    expect(out).toContain("<mark>");
    expect(out).toContain("**a**");
  });
});

// markdown.md has no comment construct: `<!-- -->` is ordinary text.
describe("renderMarkdownToHtml: HTML comments are literal", () => {
  it("renders an inline comment as escaped plain text", () => {
    expect(html("text <!-- c --> end")).toContain("&lt;!-- c --&gt;");
  });

  it("renders a block comment as escaped plain text", () => {
    expect(html("<!-- block -->")).toContain("&lt;!-- block --&gt;");
  });
});

// markdown.md: unordered lists use `-`, ordered lists use `1.`. The lezer
// parser is constrained so `+`/`*` bullets and `N)` ordered markers stay
// plain text instead of opening lists.
describe("renderMarkdownToHtml: list markers", () => {
  it("renders `-` as an unordered list", () => {
    const out = html("- a\n- b");
    expect(count(out, "<ul>")).toBe(1);
    expect(count(out, "<li>")).toBe(2);
  });

  it("renders `1.` as an ordered list", () => {
    const out = html("1. a\n2. b");
    expect(count(out, "<ol>")).toBe(1);
    expect(count(out, "<li>")).toBe(2);
  });

  it("nests `-` lists by content indent", () => {
    const out = html("- a\n  - b");
    expect(count(out, "<ul>")).toBe(2);
    expect(count(out, "<li>")).toBe(2);
  });

  it("treats `*` and `+` bullets as plain text, not lists", () => {
    for (const md of ["* a", "+ a"]) {
      const out = html(md);
      expect(count(out, "<ul>")).toBe(0);
      expect(count(out, "<li>")).toBe(0);
      expect(out).toContain("a");
    }
  });

  it("treats `1)` ordered markers as plain text, not lists", () => {
    const out = html("1) a");
    expect(count(out, "<ol>")).toBe(0);
    expect(count(out, "<li>")).toBe(0);
    expect(out).toContain("a");
  });
});
