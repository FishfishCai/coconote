import { describe, expect, it } from "vitest";
import {
  emptySidecar,
  parseSidecar,
  type PdfSidecar,
  serializeSidecar,
} from "./pdf_sidecar.ts";

const sampleHighlight = {
  id: "hl-1",
  page: 3,
  rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04 }],
  color: "yellow" as const,
  text: "selected text",
};

describe("parseSidecar reads the named-highlight key", () => {
  it("reads the `names` key into the in-memory `anchors` field", () => {
    const text = JSON.stringify({
      metadata: { id: "pdfid0000000000a", title: "Paper", tags: ["x"], backrefs: [] },
      highlights: [sampleHighlight],
      names: [{ name: "fig3", highlightId: "hl-1" }],
      comments: [{ highlightId: "hl-1", body: "see this", ts: 1717000000000 }],
    });
    const sc = parseSidecar(text);
    expect(sc.anchors).toEqual([{ name: "fig3", highlightId: "hl-1" }]);
    expect(sc.highlights).toHaveLength(1);
    expect(sc.comments[0].body).toBe("see this");
    expect(sc.metadata.id).toBe("pdfid0000000000a");
  });

  it("returns an empty sidecar for empty / malformed json", () => {
    expect(parseSidecar("")).toEqual(emptySidecar());
    expect(parseSidecar("   ")).toEqual(emptySidecar());
    expect(parseSidecar("{not json")).toEqual(emptySidecar());
    expect(parseSidecar("null")).toEqual(emptySidecar());
  });
});

describe("serializeSidecar writes the spec `names` key", () => {
  it("emits `names` (not `anchors`) for the in-memory anchors", () => {
    const sc: PdfSidecar = {
      metadata: { id: "i", title: "t", tags: ["a"], backrefs: ["b"] },
      highlights: [sampleHighlight],
      anchors: [{ name: "fig3", highlightId: "hl-1" }],
      comments: [{ highlightId: "hl-1", body: "c", ts: 1 }],
    };
    const json = JSON.parse(serializeSidecar(sc));
    expect(json.names).toEqual([{ name: "fig3", highlightId: "hl-1" }]);
    expect(json.anchors).toBeUndefined();
    expect(Object.keys(json)).toEqual([
      "metadata",
      "highlights",
      "names",
      "comments",
    ]);
  });
});

describe("parse/serialize collab roundtrip", () => {
  it("survives a full sidecar unchanged through serialize -> parse", () => {
    const sc: PdfSidecar = {
      metadata: {
        id: "pdfid0000000000b",
        title: "Roundtrip",
        tags: ["t1", "t2"],
        backrefs: ["ref0000000000001"],
      },
      highlights: [
        sampleHighlight,
        { ...sampleHighlight, id: "hl-2", color: "blue", page: 1 },
      ],
      anchors: [
        { name: "intro", highlightId: "hl-1" },
        { name: "method", highlightId: "hl-2" },
      ],
      comments: [{ highlightId: "hl-2", body: "key point", ts: 1717000001234 }],
    };
    expect(parseSidecar(serializeSidecar(sc))).toEqual(sc);
  });

  it("is idempotent: serialize(parse(serialize(x))) === serialize(x)", () => {
    const sc: PdfSidecar = {
      metadata: { id: "x", title: "y", tags: [], backrefs: [] },
      highlights: [sampleHighlight],
      anchors: [{ name: "n", highlightId: "hl-1" }],
      comments: [],
    };
    const once = serializeSidecar(sc);
    expect(serializeSidecar(parseSidecar(once))).toBe(once);
  });

  it("an empty sidecar roundtrips to an empty sidecar", () => {
    expect(parseSidecar(serializeSidecar(emptySidecar()))).toEqual(
      emptySidecar(),
    );
  });
});
