import { describe, expect, it } from "vitest";
import {
  extractFrontmatter,
  setFrontmatterList,
} from "./frontmatter.ts";

describe("extractFrontmatter parses the id-addressed fields", () => {
  it("reads id, title, tags, refs, backrefs", () => {
    const md = [
      "---",
      "id: xsx7pgxrgx7zkc67",
      "title: My Note",
      "tags: [research, draft]",
      "refs: [aaaa0000aaaa0000, bbbb0000bbbb0000]",
      "backrefs: [cccc0000cccc0000]",
      "---",
      "body",
    ].join("\n");
    expect(extractFrontmatter(md)).toEqual({
      id: "xsx7pgxrgx7zkc67",
      title: "My Note",
      tags: ["research", "draft"],
      refs: ["aaaa0000aaaa0000", "bbbb0000bbbb0000"],
      backrefs: ["cccc0000cccc0000"],
    });
  });

  it("strips a trailing yaml comment from the id scalar", () => {
    const md = "---\nid: abcd1234abcd1234 # minted\n---\nx";
    expect(extractFrontmatter(md).id).toBe("abcd1234abcd1234");
  });
});

describe("setFrontmatterList writes refs as an id list", () => {
  it("creates the refs field on a file that has frontmatter", () => {
    const md = "---\nid: i\ntitle: T\n---\nbody";
    const out = setFrontmatterList(md, "refs", ["aaaa0000aaaa0000"]);
    expect(extractFrontmatter(out).refs).toEqual(["aaaa0000aaaa0000"]);
    // The body is untouched.
    expect(out.endsWith("body")).toBe(true);
  });

  it("drops the field when the id list is empty", () => {
    const md = "---\nrefs: [aaaa0000aaaa0000]\n---\nbody";
    const out = setFrontmatterList(md, "refs", []);
    expect(extractFrontmatter(out).refs).toBeUndefined();
  });
});
