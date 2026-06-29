import { describe, expect, it } from "vitest";
import { resolveTitle } from "./wiki_link_resolver.ts";
import type { PageMeta } from "coconote/type/page";

// Mirrors the server resolver.rs resolve_title contract: title-by-name,
// `tag/title` disambiguation, 1 -> hit / 0 -> missing / >1 -> ambiguous.
function pm(id: string, title: string, tags: string[] = []): PageMeta {
  return {
    id,
    kind: "md",
    title,
    tags,
    created: "",
    lastModified: "",
    perm: "rw",
  };
}

const pages: PageMeta[] = [
  pm("uniqueid00000000", "Unique"),
  pm("dupid10000000000", "Dup", ["note"]),
  pm("dupid20000000000", "Dup", ["paper"]),
];

describe("resolveTitle", () => {
  it("resolves a unique title to its id (hit)", () => {
    expect(resolveTitle("Unique", pages)).toEqual({
      state: "hit",
      id: "uniqueid00000000",
    });
  });

  it("returns missing when no file has the title", () => {
    expect(resolveTitle("Nope", pages)).toEqual({ state: "missing" });
  });

  it("returns ambiguous when several files share the title", () => {
    const r = resolveTitle("Dup", pages);
    expect(r.state).toBe("ambiguous");
    if (r.state === "ambiguous") {
      expect(r.candidates.map((c) => c.id)).toEqual([
        "dupid10000000000",
        "dupid20000000000",
      ]);
    }
  });

  it("disambiguates a shared title by tag prefix", () => {
    expect(resolveTitle("paper/Dup", pages)).toEqual({
      state: "hit",
      id: "dupid20000000000",
    });
    expect(resolveTitle("note/Dup", pages)).toEqual({
      state: "hit",
      id: "dupid10000000000",
    });
  });

  it("is case-sensitive on the title", () => {
    expect(resolveTitle("unique", pages)).toEqual({ state: "missing" });
  });
});
