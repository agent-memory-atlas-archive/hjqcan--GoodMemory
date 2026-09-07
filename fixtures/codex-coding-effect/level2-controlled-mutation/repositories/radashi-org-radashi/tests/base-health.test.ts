import { describe, expect, it } from "bun:test";
import { capitalize, isEmpty, sum } from "../src/mod";

describe("visible base health", () => {
  it("keeps the untouched helpers working", () => {
    expect(sum([2, 3, 4])).toBe(9);
    expect(capitalize("health")).toBe("Health");
    expect(isEmpty([])).toBe(true);
  });
});
