import { describe, expect, it } from "vitest";
import {
  encodeRef,
  findCalloutTarget,
  getOffsetFromHeader,
  parseToRef,
  type Ref,
  resolveCalloutDisplay,
  sliceByRef,
} from "./ref.ts";
// Test-only DOWN-ish use of the markdown capability's public barrel to build
// a real parse tree fixture for getOffsetFromHeader (the heading-offset logic
// is inherently about parsed markdown). Production ref.ts has no markdown edge.
import { parseMarkdown } from "../markdown/index.ts";

describe("parseToRef parses a title-based wiki link", () => {
  it("parses a plain title", () => {
    expect(parseToRef("My Note")).toEqual({ title: "My Note" });
  });

  it("keeps a tag/title prefix in the name part", () => {
    expect(parseToRef("research/My Note")).toEqual({ title: "research/My Note" });
  });

  it("parses a header marker (#)", () => {
    expect(parseToRef("foo#Heading One")).toEqual({
      title: "foo",
      details: { type: "header", header: "Heading One" },
    });
  });

  it("parses a numeric and a named callout marker (:)", () => {
    expect(parseToRef("foo:3")).toEqual({
      title: "foo",
      details: { type: "callout", target: "3" },
    });
    expect(parseToRef("foo:myLabel")).toEqual({
      title: "foo",
      details: { type: "callout", target: "myLabel" },
    });
  });

  it("parses a PDF anchor marker (%)", () => {
    expect(parseToRef("paper%fig3")).toEqual({
      title: "paper",
      details: { type: "pdfAnchor", anchor: "fig3" },
    });
  });

  it("parses a marker-only ref as the current file (empty title)", () => {
    // wikilink.md: omit the name to target the current file.
    expect(parseToRef("#Top")).toEqual({
      title: "",
      details: { type: "header", header: "Top" },
    });
  });

  it("rejects a body containing the wikilink terminator", () => {
    expect(parseToRef("a]]b")).toBeNull();
  });
});

describe("encodeRef", () => {
  it("round-trips the title alone", () => {
    expect(encodeRef({ title: "foo" })).toBe("foo");
  });

  it("encodes each marker type with its sigil", () => {
    expect(encodeRef({ title: "foo", details: { type: "header", header: "H" } }))
      .toBe("foo#H");
    expect(
      encodeRef({ title: "foo", details: { type: "callout", target: "3" } }),
    ).toBe("foo:3");
    expect(
      encodeRef({ title: "p", details: { type: "pdfAnchor", anchor: "f" } }),
    ).toBe("p%f");
  });

  it("round-trips parse -> encode for the common forms", () => {
    for (const s of ["My Note", "foo#Heading One", "foo:2", "paper%fig3"]) {
      expect(encodeRef(parseToRef(s) as Ref)).toBe(s);
    }
  });
});

// A document with three callouts: a numbered+labelled definition, a
// numbered theorem, and an unnumbered labelled note. The note keyword is
// not numbered, so it must NOT bump the document-wide counter.
const calloutDoc = [
  "::: definition: defLimit", // numbered #1, labelled
  "A limit is the value.",
  ":::",
  "",
  "::: theorem", // numbered #2
  "Some theorem body",
  ":::",
  "",
  "::: note: myNote", // labelled, NOT numbered
  "note body line",
  ":::",
].join("\n");

describe("findCalloutTarget", () => {
  it("finds the Nth numbered callout (counter skips unnumbered)", () => {
    expect(findCalloutTarget(calloutDoc, "1")).toBe(0); // definition
    expect(findCalloutTarget(calloutDoc, "2"))
      .toBe(calloutDoc.indexOf("::: theorem"));
  });

  it("finds a callout by its label", () => {
    expect(findCalloutTarget(calloutDoc, "defLimit")).toBe(0);
    expect(findCalloutTarget(calloutDoc, "myNote"))
      .toBe(calloutDoc.indexOf("::: note"));
  });

  it("returns -1 when the target does not exist", () => {
    expect(findCalloutTarget(calloutDoc, "3")).toBe(-1); // only 2 numbered
    expect(findCalloutTarget(calloutDoc, "nope")).toBe(-1);
  });

  it("ignores callout openers inside a fenced code block", () => {
    const doc = ["```", "::: theorem", ":::", "```", "::: theorem", "real",
      ":::"].join("\n");
    expect(findCalloutTarget(doc, "1")).toBe(doc.indexOf("::: theorem", 5));
  });

  it("skips an unclosed callout entirely", () => {
    const doc = ["::: theorem", "no closer", "", "::: definition", "d", ":::"]
      .join("\n");
    expect(findCalloutTarget(doc, "1")).toBe(doc.indexOf("::: definition"));
  });
});

describe("resolveCalloutDisplay", () => {
  it("formats a numbered + labelled callout", () => {
    expect(resolveCalloutDisplay(calloutDoc, "1"))
      .toBe("Definition 1 (defLimit).");
  });

  it("formats a numbered-only callout", () => {
    expect(resolveCalloutDisplay(calloutDoc, "2")).toBe("Theorem 2.");
  });

  it("formats an unnumbered labelled callout without a trailing period", () => {
    expect(resolveCalloutDisplay(calloutDoc, "myNote")).toBe("Note (myNote)");
  });

  it("returns null when the target is missing", () => {
    expect(resolveCalloutDisplay(calloutDoc, "nope")).toBeNull();
  });
});

describe("sliceByRef", () => {
  it("slices a header section up to the next same/higher heading", () => {
    const md = "# A\nbody a\n## B\nbody b\n# C\nbody c";
    const a = sliceByRef(md, { type: "header", header: "A" });
    expect(a?.text).toBe("# A\nbody a\n## B\nbody b\n");
    expect(a?.offset).toBe(0);
  });

  it("slices a callout body between the fences", () => {
    const r = sliceByRef(calloutDoc, { type: "callout", target: "1" });
    expect(r?.text).toBe("A limit is the value.");
  });

  it("returns null for a PDF anchor (not addressable in markdown)", () => {
    expect(sliceByRef("text", { type: "pdfAnchor", anchor: "f" })).toBeNull();
  });

  // markdown.md: headings (and `#heading` anchors) are H1-H4 only.
  it("slices an H4 section but does not match an H5 heading", () => {
    const md = "#### Sec\nbody\n#### Next\nx";
    expect(sliceByRef(md, { type: "header", header: "Sec" })?.text)
      .toBe("#### Sec\nbody\n");
    expect(sliceByRef("##### Five\nbody", { type: "header", header: "Five" }))
      .toBeNull();
  });
});

describe("getOffsetFromHeader is H1-H4 only", () => {
  it("resolves an H1-H4 heading to its line start", () => {
    const tree = parseMarkdown("# Top\nbody\n#### Deep\nmore");
    expect(getOffsetFromHeader(tree, "Top")).toBe(0);
    expect(getOffsetFromHeader(tree, "Deep")).toBe("# Top\nbody\n".length);
  });

  it("does not resolve an H5/H6 heading", () => {
    const tree = parseMarkdown("##### Five\n###### Six");
    expect(getOffsetFromHeader(tree, "Five")).toBe(-1);
    expect(getOffsetFromHeader(tree, "Six")).toBe(-1);
  });
});
