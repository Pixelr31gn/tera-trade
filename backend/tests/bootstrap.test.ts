import { describe, expect, it } from "vitest";
import { inferStartingBalance } from "../src/engine/bootstrap.js";

describe("inferStartingBalance", () => {
  it("returns 0 for an Express account regardless of size tier", () => {
    expect(inferStartingBalance("$50K EXPRESS")).toBe("0");
    expect(inferStartingBalance("100K EXPRESS")).toBe("0");
  });

  it("returns the full size tier for a DLL Combine account", () => {
    expect(inferStartingBalance("50K DLL COMBINE")).toBe("50000");
    expect(inferStartingBalance("100K DLL COMBINE")).toBe("100000");
  });

  it("is case-insensitive for both the Express check and the size suffix", () => {
    expect(inferStartingBalance("50k express")).toBe("0");
    expect(inferStartingBalance("150k combine")).toBe("150000");
  });

  it("falls back to 50000 when no recognizable size tier is present", () => {
    expect(inferStartingBalance("Some Unrecognized Account Name")).toBe("50000");
  });
});
