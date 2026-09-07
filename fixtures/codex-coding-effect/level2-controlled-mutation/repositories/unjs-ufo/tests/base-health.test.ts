import { describe, expect, it } from "bun:test";
import { cleanDoubleSlashes, hasProtocol, withTrailingSlash } from "../src/index";

describe("visible base health", () => {
  it("keeps the untouched url helpers working", () => {
    expect(withTrailingSlash("/docs")).toBe("/docs/");
    expect(hasProtocol("https://example.com")).toBe(true);
    expect(cleanDoubleSlashes("/a//b")).toBe("/a/b");
  });
});
