import { describe, expect, it } from "vitest";
import {
  parseDimensionFromAlias,
  parseTransclusion,
} from "./transclusion.ts";

describe("parseTransclusion", () => {
  it("parses a bare embed", () => {
    expect(parseTransclusion("![[foo]]")).toEqual({
      url: "foo",
      alias: "",
      dimension: undefined,
      align: undefined,
    });
  });

  it("parses an embed with a display alias", () => {
    expect(parseTransclusion("![[foo|My Alias]]")).toMatchObject({
      url: "foo",
      alias: "My Alias",
    });
  });

  it("parses width x height dimensions", () => {
    expect(parseTransclusion("![[img|300x200]]")).toMatchObject({
      url: "img",
      alias: "",
      dimension: { width: 300, height: 200 },
    });
  });

  it("parses width-only and height-only dimensions", () => {
    expect(parseTransclusion("![[img|300]]")?.dimension).toEqual({
      width: 300,
    });
    expect(parseTransclusion("![[img|x200]]")?.dimension).toEqual({
      height: 200,
    });
  });

  it("parses an alignment keyword", () => {
    expect(parseTransclusion("![[img|center]]")?.align).toBe("center");
  });

  it("parses alias, dimension and align together in any order", () => {
    expect(parseTransclusion("![[img|Caption|300x200|right]]")).toMatchObject({
      url: "img",
      alias: "Caption",
      dimension: { width: 300, height: 200 },
      align: "right",
    });
  });

  it("returns null when the text is not a wikilink", () => {
    expect(parseTransclusion("plain text")).toBeNull();
  });
});

describe("parseDimensionFromAlias", () => {
  it("classifies a pure dimension segment", () => {
    expect(parseDimensionFromAlias("300x200")).toEqual({
      alias: "",
      dimension: { width: 300, height: 200 },
    });
  });

  it("keeps the first non-special segment as the alias", () => {
    expect(parseDimensionFromAlias("Caption|left")).toEqual({
      alias: "Caption",
      align: "left",
    });
  });

  it("accepts segments in any order", () => {
    expect(parseDimensionFromAlias("x100|My Caption")).toEqual({
      alias: "My Caption",
      dimension: { height: 100 },
    });
  });

  it("only the first plain segment wins as alias", () => {
    expect(parseDimensionFromAlias("first|second").alias).toBe("first");
  });
});
