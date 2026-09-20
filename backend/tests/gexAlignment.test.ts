import { describe, expect, it } from "vitest";
import { classifyGexRegime } from "../src/analytics/gexAlignment.js";

describe("classifyGexRegime", () => {
  it("is positive when spot is at or above the flip", () => {
    expect(classifyGexRegime(5850, 5830)).toBe("positive_gamma");
    expect(classifyGexRegime(5830, 5830)).toBe("positive_gamma");
  });

  it("is negative when spot is below the flip", () => {
    expect(classifyGexRegime(5820, 5830)).toBe("negative_gamma");
  });

  it("is unknown when no flip could be computed", () => {
    expect(classifyGexRegime(5850, null)).toBe("unknown");
  });
});
