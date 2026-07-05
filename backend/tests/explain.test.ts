import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { explainKillSwitch, explainNewsPause, explainRiskRejection, explainScore, explainTradeExit } from "../src/explain/engine.js";
import type { GatedScore } from "../src/scoring/gate.js";
import type { RiskAssessment } from "../src/risk/engine.js";

function gated(decision: "taken" | "skipped_score", probability = 0.7): GatedScore {
  return {
    probability,
    decision,
    factors: [{ name: "trendAlignment", contribution: 1.1, description: "setup direction agrees with the prevailing up trend" }],
    modelUsed: "rule_v1",
  };
}

describe("explainScore", () => {
  it("mentions probability and threshold when taken", () => {
    const text = explainScore("ES", "long", gated("taken", 0.72), 0.65);
    expect(text).toContain("72%");
    expect(text).toContain("65%");
    expect(text).toContain("LONG ES");
  });

  it("says no trade taken when skipped", () => {
    const text = explainScore("ES", "long", gated("skipped_score", 0.4), 0.65);
    expect(text).toContain("no trade taken");
  });
});

describe("explainRiskRejection", () => {
  it("includes the risk engine's reason", () => {
    const assessment: RiskAssessment = {
      approved: false, quantity: 0, stopPrice: null, takeProfitPrice: null, trailTicks: null, stopDistancePoints: null,
      reason: "blocked by news risk window: 'CPI' (high impact) in 5 min", tripKillSwitch: false,
    };
    expect(explainRiskRejection("ES", "long", assessment)).toContain("CPI");
  });
});

describe("explainTradeExit", () => {
  it("distinguishes a stop loss from a target hit", () => {
    const stopText = explainTradeExit("ES", "long", "stop", new Decimal(4995), new Decimal(-250));
    const targetText = explainTradeExit("ES", "long", "target", new Decimal(5010), new Decimal(500));
    expect(stopText).toContain("loss");
    expect(targetText).toContain("gain");
  });
});

describe("explainNewsPause / explainKillSwitch", () => {
  it("renders both plainly", () => {
    expect(explainNewsPause("ES", "CPI", "high", 10)).toContain("10 minutes");
    expect(explainKillSwitch("daily loss of 4.00% has reached the 3% daily loss limit")).toContain("Kill switch engaged");
  });
});
