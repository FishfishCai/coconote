import { describe, expect, it } from "vitest";
import { highlightTree } from "@lezer/highlight";
import { buildExtendedMarkdownLanguage } from "../../capabilities/markdown/index.ts";
import highlightStyles from "./style.ts";

// The live editor suppresses a combined highlight via CSS
// (colors.scss `.coconote-strong.coconote-highlight { background: none }`),
// which only works if both classes land on the SAME highlighted span. This
// lives with the codemirror HighlightStyle (style.ts) it exercises, built
// on top of the markdown capability's parser (a DOWN import).
describe("live editor: combined highlight carries both classes", () => {
  function classesFor(md: string, slice: string): string {
    const lang = buildExtendedMarkdownLanguage();
    const tree = lang.parser.parse(md);
    let found = "";
    highlightTree(tree, highlightStyles(), (from, to, classes) => {
      if (md.slice(from, to) === slice) found = classes;
    });
    return found;
  }

  it("tags the inner span with the mark AND the highlight class", () => {
    expect(classesFor("**==x==**", "x")).toContain("coconote-strong");
    expect(classesFor("**==x==**", "x")).toContain("coconote-highlight");
    expect(classesFor("~~==y==~~", "y")).toContain("coconote-strikethrough");
    expect(classesFor("~~==y==~~", "y")).toContain("coconote-highlight");
    expect(classesFor("*==z==*", "z")).toContain("coconote-emphasis");
    expect(classesFor("*==z==*", "z")).toContain("coconote-highlight");
  });

  it("a plain highlight carries only coconote-highlight", () => {
    expect(classesFor("==x==", "x")).toBe("coconote-highlight");
  });
});
