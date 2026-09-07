import { describe, expect, it } from "bun:test";
import { camelCase, kebabCase, upperFirst } from "../src/index";

describe("visible base health", () => {
  it("keeps the untouched case helpers working", () => {
    expect(camelCase("visible-health")).toBe("visibleHealth");
    expect(kebabCase("VisibleHealth")).toBe("visible-health");
    expect(upperFirst("health")).toBe("Health");
  });
});
