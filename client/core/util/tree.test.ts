import { describe, expect, it } from "vitest";
import {
  addParentPointers,
  findNodeMatching,
  findNodeOfType,
  findParentMatching,
  nodeAtPos,
  type ParseTree,
  renderToText,
} from "./tree.ts";

// A small parse tree mirroring the lezer/markdown shape: a paragraph with
// a text leaf, and an ATX heading made of a HeaderMark plus text.
function sampleTree(): ParseTree {
  return {
    type: "Doc",
    from: 0,
    to: 11,
    children: [
      {
        type: "Para",
        from: 0,
        to: 5,
        children: [{ text: "hello", from: 0, to: 5 }],
      },
      {
        type: "Heading",
        from: 6,
        to: 11,
        children: [
          {
            type: "HeaderMark",
            from: 6,
            to: 7,
            children: [{ text: "#", from: 6, to: 7 }],
          },
          { text: " abc", from: 7, to: 11 },
        ],
      },
    ],
  };
}

describe("renderToText", () => {
  it("concatenates the text leaves in document order", () => {
    expect(renderToText(sampleTree())).toBe("hello# abc");
  });

  it("returns empty string for an undefined tree", () => {
    expect(renderToText(undefined)).toBe("");
  });

  it("returns a lone text leaf verbatim", () => {
    expect(renderToText({ text: "solo", from: 0, to: 4 })).toBe("solo");
  });
});

describe("findNodeOfType", () => {
  it("finds a nested node by type", () => {
    expect(findNodeOfType(sampleTree(), "HeaderMark")?.type).toBe("HeaderMark");
  });

  it("returns the tree itself when it matches", () => {
    const t = sampleTree();
    expect(findNodeOfType(t, "Doc")).toBe(t);
  });

  it("returns null when no node matches", () => {
    expect(findNodeOfType(sampleTree(), "CodeBlock")).toBeNull();
  });
});

describe("findNodeMatching", () => {
  it("returns the first node satisfying the predicate (pre-order)", () => {
    const node = findNodeMatching(sampleTree(), (t) => t.from === 6);
    expect(node?.type).toBe("Heading");
  });

  it("returns null when nothing matches", () => {
    expect(findNodeMatching(sampleTree(), () => false)).toBeNull();
  });
});

describe("addParentPointers + findParentMatching", () => {
  it("wires parent pointers so ancestors are reachable", () => {
    const tree = sampleTree();
    addParentPointers(tree);
    const mark = findNodeOfType(tree, "HeaderMark")!;
    expect(mark.parent?.type).toBe("Heading");
    expect(findParentMatching(mark, (t) => t.type === "Doc")?.type).toBe("Doc");
  });

  it("findParentMatching returns null when no ancestor matches", () => {
    const tree = sampleTree();
    addParentPointers(tree);
    const mark = findNodeOfType(tree, "HeaderMark")!;
    expect(findParentMatching(mark, (t) => t.type === "CodeBlock")).toBeNull();
  });
});

describe("nodeAtPos", () => {
  it("returns the parent element of the text node at a position", () => {
    // A text leaf is never returned directly: the caller wants the
    // enclosing element node.
    expect(nodeAtPos(sampleTree(), 8)?.type).toBe("Heading");
    expect(nodeAtPos(sampleTree(), 0)?.type).toBe("Para");
  });

  it("returns null for an out-of-range position", () => {
    expect(nodeAtPos(sampleTree(), 99)).toBeNull();
  });

  it("treats `to` as exclusive", () => {
    // Position 11 == Doc.to, so it falls outside the [from, to) range.
    expect(nodeAtPos(sampleTree(), 11)).toBeNull();
  });
});
