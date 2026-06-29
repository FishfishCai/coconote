import { describe, expect, it } from "vitest";
import {
  assetsPrefix,
  basename,
  encodePathSegments,
  getPathExtension,
  isMarkdownPath,
  pdfSidecarPath,
  pdfStem,
} from "./path_url.ts";

describe("getPathExtension / isMarkdownPath", () => {
  it("returns the lowercased extension", () => {
    expect(getPathExtension("a/b.PDF")).toBe("pdf");
    expect(getPathExtension("note.md")).toBe("md");
  });

  it("treats the empty path as markdown", () => {
    expect(getPathExtension("")).toBe("md");
    expect(isMarkdownPath("")).toBe(true);
  });

  it("isMarkdownPath is false for non-md", () => {
    expect(isMarkdownPath("paper.pdf")).toBe(false);
    expect(isMarkdownPath("note.md")).toBe(true);
  });
});

describe("encodePathSegments", () => {
  it("escapes URL-special chars inside each segment but keeps slashes", () => {
    // encodeURI leaves `# ? &` alone (they truncate/rewrite the URL) and
    // encodeURIComponent would flatten the `/` separators - this keeps
    // the separators and escapes everything else.
    expect(encodePathSegments("a b/c#d/e?f")).toBe("a%20b/c%23d/e%3Ff");
  });

  it("leaves a plain path untouched", () => {
    expect(encodePathSegments("notes/foo.md")).toBe("notes/foo.md");
  });

  it("escapes a path that is a single segment", () => {
    expect(encodePathSegments("a b.md")).toBe("a%20b.md");
  });
});

describe("basename", () => {
  it("returns the last segment", () => {
    expect(basename("notes/foo.md")).toBe("foo.md");
  });

  it("returns the input when there is no slash", () => {
    expect(basename("foo.md")).toBe("foo.md");
  });
});

describe("pdf and md companion paths", () => {
  it("pdfStem strips the .pdf and any directory", () => {
    expect(pdfStem("papers/foo.pdf")).toBe("foo");
    expect(pdfStem("foo.PDF")).toBe("foo");
  });

  it("assetsPrefix strips a known extension to the stem (md and pdf)", () => {
    // file.md: a file's images/history live in `.<stem>.assets/` beside
    // it, stem = basename minus the known extension. One helper for both
    // md and pdf, matching the server's single util::assets_prefix_for.
    expect(assetsPrefix("notes/foo.md")).toBe("notes/.foo.assets/");
    expect(assetsPrefix("papers/foo.pdf")).toBe("papers/.foo.assets/");
  });

  it("assetsPrefix handles a root-level file", () => {
    expect(assetsPrefix("foo.md")).toBe(".foo.assets/");
    expect(assetsPrefix("foo.pdf")).toBe(".foo.assets/");
  });

  it("pdfSidecarPath puts the annotations json inside the assets folder", () => {
    // file.md: PDF companions are a folder, not a sibling json.
    expect(pdfSidecarPath("papers/foo.pdf")).toBe("papers/.foo.assets/foo.json");
  });

  it("pdfSidecarPath handles a root-level pdf", () => {
    expect(pdfSidecarPath("foo.pdf")).toBe(".foo.assets/foo.json");
  });
});
