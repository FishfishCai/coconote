import { describe, expect, it } from "vitest";
import {
  CALLOUT_CLOSE_RE,
  CALLOUT_OPEN_RE,
  findCalloutBounds,
  parseCalloutOpener,
  resolveTemplate,
} from "./callout.ts";

// Build a `getLine` accessor over an array of lines, matching the
// contract findCalloutBounds expects (1-based, null past EOF).
function lineAccessor(lines: string[]) {
  return (n: number) =>
    n >= 1 && n <= lines.length
      ? { text: lines[n - 1], from: n * 100, to: n * 100 + lines[n - 1].length }
      : null;
}

describe("resolveTemplate", () => {
  it("resolves a builtin keyword", () => {
    expect(resolveTemplate("definition")).toMatchObject({
      title: "Definition",
      numbered: true,
    });
  });

  it("is case-insensitive", () => {
    expect(resolveTemplate("THEOREM")?.title).toBe("Theorem");
  });

  it("returns null for an unknown keyword", () => {
    expect(resolveTemplate("zzz")).toBeNull();
  });

  it("marks the math-like keywords numbered and prose ones not", () => {
    for (const k of ["definition", "theorem", "proposition", "lemma",
      "corollary", "example"]) {
      expect(resolveTemplate(k)?.numbered).toBe(true);
    }
    for (const k of ["note", "warning", "tip", "info", "remark", "proof"]) {
      expect(resolveTemplate(k)?.numbered).toBeFalsy();
    }
  });
});

describe("parseCalloutOpener", () => {
  it("parses a bare opener with no label", () => {
    expect(parseCalloutOpener("::: theorem")).toEqual({
      keyword: "theorem",
      label: null,
      labelOffset: -1,
    });
  });

  it("parses a labelled opener and reports the label offset", () => {
    const r = parseCalloutOpener("::: definition: myLabel");
    expect(r).toMatchObject({ keyword: "definition", label: "myLabel" });
    // labelOffset points at the first char of the label in the line.
    expect("::: definition: myLabel".slice(r!.labelOffset)).toBe("myLabel");
  });

  it("accepts four or more colons", () => {
    expect(parseCalloutOpener(":::: note: tag")).toMatchObject({
      keyword: "note",
      label: "tag",
    });
  });

  it("returns null for a non-opener line", () => {
    expect(parseCalloutOpener("not a callout")).toBeNull();
    expect(parseCalloutOpener(":::")).toBeNull(); // closer, not opener
  });
});

describe("findCalloutBounds", () => {
  it("locates the closing fence of a well-formed callout", () => {
    const bounds = findCalloutBounds(
      lineAccessor(["::: theorem", "body", ":::", "after"]),
      1,
    );
    expect(bounds).toEqual({ closerLineNo: 3, closerFrom: 300, closerTo: 303 });
  });

  it("returns null for an unclosed callout that runs to EOF", () => {
    expect(findCalloutBounds(lineAccessor(["::: theorem", "no closer"]), 1))
      .toBeNull();
  });

  it("returns null when another opener appears before any closer", () => {
    // Callouts do not nest: the second opener ends the (unclosed) first.
    const lines = ["::: theorem", "body", "::: note", "x", ":::"];
    expect(findCalloutBounds(lineAccessor(lines), 1)).toBeNull();
  });
});

describe("callout fence regexes", () => {
  it("a closing fence may use more colons than the opener", () => {
    // markdown.md: the closer matches any run of three or more colons.
    expect(CALLOUT_OPEN_RE.test(":::: theorem")).toBe(true);
    expect(CALLOUT_CLOSE_RE.test(":::::")).toBe(true);
  });

  it("rejects fewer than three colons", () => {
    expect(CALLOUT_OPEN_RE.test(":: theorem")).toBe(false);
    expect(CALLOUT_CLOSE_RE.test("::")).toBe(false);
  });
});
