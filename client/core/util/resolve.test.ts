import { describe, expect, it } from "vitest";
import { isLocalURL } from "./resolve.ts";

// isLocalURL classifies an image embed url as a local asset (a flat
// filename in the owner's `.<name>.assets/`, loaded via `?id=&asset=`) vs
// an external http(s) url loaded directly. Used by the image render path.
describe("isLocalURL", () => {
  it("treats a bare asset filename as local", () => {
    expect(isLocalURL("diagram.png")).toBe(true);
    expect(isLocalURL("pasted-abc.jpg")).toBe(true);
  });

  it("rejects an absolute http(s) URL", () => {
    expect(isLocalURL("https://example.com")).toBe(false);
    expect(isLocalURL("http://example.com/a")).toBe(false);
  });

  it("rejects mailto and tel schemes", () => {
    expect(isLocalURL("mailto:a@b.com")).toBe(false);
    expect(isLocalURL("tel:12345")).toBe(false);
  });

  it("rejects any explicit scheme via ://", () => {
    expect(isLocalURL("ftp://host/file")).toBe(false);
  });
});
