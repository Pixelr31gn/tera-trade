import { describe, expect, it } from "vitest";
import { validateConfidenceTierInputs, ModeChangeError, type ConfidenceTierInput } from "../src/execution/mode.js";

function tiers(a: ConfidenceTierInput, b: ConfidenceTierInput, c: ConfidenceTierInput): [ConfidenceTierInput, ConfidenceTierInput, ConfidenceTierInput] {
  return [a, b, c];
}

describe("validateConfidenceTierInputs", () => {
  it("accepts valid, strictly ascending tiers and returns them sorted by threshold", () => {
    const result = validateConfidenceTierInputs(tiers({ threshold: 0.85, quantity: 3 }, { threshold: 0.65, quantity: 1 }, { threshold: 0.75, quantity: 2 }));
    expect(result.map((t) => t.threshold)).toEqual([0.65, 0.75, 0.85]);
    expect(result.map((t) => t.quantity)).toEqual([1, 2, 3]);
  });

  it("accepts the operator's real live config (29/76/85%)", () => {
    const result = validateConfidenceTierInputs(tiers({ threshold: 0.29, quantity: 2 }, { threshold: 0.76, quantity: 3 }, { threshold: 0.85, quantity: 4 }));
    expect(result).toEqual([{ threshold: 0.29, quantity: 2 }, { threshold: 0.76, quantity: 3 }, { threshold: 0.85, quantity: 4 }]);
  });

  // Regression coverage for the 2026-08-11 finding: the settings page has
  // always claimed "thresholds must be strictly ascending," but nothing
  // ever actually enforced it until now.
  it("rejects two tiers sharing the exact same threshold", () => {
    expect(() => validateConfidenceTierInputs(tiers({ threshold: 0.65, quantity: 1 }, { threshold: 0.65, quantity: 2 }, { threshold: 0.85, quantity: 3 }))).toThrow(ModeChangeError);
  });

  it("rejects all three tiers sharing the same threshold", () => {
    expect(() => validateConfidenceTierInputs(tiers({ threshold: 0.5, quantity: 1 }, { threshold: 0.5, quantity: 2 }, { threshold: 0.5, quantity: 3 }))).toThrow(/strictly ascending/);
  });

  it("rejects a threshold at or below 0", () => {
    expect(() => validateConfidenceTierInputs(tiers({ threshold: 0, quantity: 1 }, { threshold: 0.5, quantity: 2 }, { threshold: 0.9, quantity: 3 }))).toThrow(ModeChangeError);
  });

  it("rejects a threshold at or above 1", () => {
    expect(() => validateConfidenceTierInputs(tiers({ threshold: 0.5, quantity: 1 }, { threshold: 0.8, quantity: 2 }, { threshold: 1, quantity: 3 }))).toThrow(ModeChangeError);
  });

  it("rejects a non-integer quantity", () => {
    expect(() => validateConfidenceTierInputs(tiers({ threshold: 0.5, quantity: 1.5 }, { threshold: 0.7, quantity: 2 }, { threshold: 0.9, quantity: 3 }))).toThrow(/positive integer/);
  });

  it("rejects a quantity below 1", () => {
    expect(() => validateConfidenceTierInputs(tiers({ threshold: 0.5, quantity: 0 }, { threshold: 0.7, quantity: 2 }, { threshold: 0.9, quantity: 3 }))).toThrow(/positive integer/);
  });
});
