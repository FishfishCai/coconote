import { describe, expect, it } from "vitest";
import { isInRefs } from "./refs_gate.ts";

// Pins the client reachability rule (see refs_gate.ts header): jumpability
// is ONE HOP - the target id must be directly in this file's `refs` (an id
// list). The server's `id_closure` is transitive; this gate is not. If
// jumpability ever becomes multi-hop, this test and the server change
// together.
describe("isInRefs is a single hop over ids", () => {
  const B = "bbbb0000bbbb0000";
  const C = "cccc0000cccc0000";

  it("allows a target id directly in refs", () => {
    expect(isInRefs(B, [B])).toBe(true);
  });

  it("blocks when refs is empty or missing", () => {
    expect(isInRefs(B, [])).toBe(false);
    expect(isInRefs(B, undefined)).toBe(false);
  });

  it("blocks when the target id is undefined", () => {
    expect(isInRefs(undefined, [B])).toBe(false);
  });

  it("does NOT follow a second hop (no transitive closure)", () => {
    // a refs b, b refs c. From a, c is not jumpable even though the
    // server's transitive closure would reach it.
    expect(isInRefs(C, [B])).toBe(false);
  });
});
