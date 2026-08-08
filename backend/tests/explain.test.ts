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
    blockReason: null,
    v3Bucket: null,
  };
}

describe("explainScore", () => {
  it("mentions probability and threshold when taken", () => {
    const text = explainScore("ES", "long", gated("taken", 0.72), 0.65);
    // One decimal place, not whole-percent rounding -- see explainScore's
    // 2026-08-07 comment.
    expect(text).toContain("72.0%");
    expect(text).toContain("65%");
    expect(text).toContain("LONG ES");
  });

  it("says no trade taken when skipped", () => {
    const text = explainScore("ES", "long", gated("skipped_score", 0.4), 0.65);
    expect(text).toContain("no trade taken");
  });

  it("when taken, shows the strongest-supporting factors, not just the loudest numbers", () => {
    const g: GatedScore = {
      probability: 0.7,
      decision: "taken",
      modelUsed: "rule_v3",
      blockReason: null,
      v3Bucket: null,
      factors: [
        { name: "strongSupport", contribution: 18, description: "STRONG_SUPPORT" },
        { name: "weakDrag", contribution: 2, description: "WEAK_DRAG" },
        { name: "midSupport", contribution: 10, description: "MID_SUPPORT" },
        { name: "anotherWeak", contribution: 1, description: "ANOTHER_WEAK" },
      ],
    };
    const text = explainScore("NQ", "short", g, 0.65);
    expect(text).toContain("STRONG_SUPPORT");
    expect(text).toContain("MID_SUPPORT");
    expect(text).not.toContain("ANOTHER_WEAK");
  });

  it("when skipped, shows the biggest detractors -- not the highest-magnitude supporting factors -- so the explanation doesn't contradict the decision", () => {
    // Mirrors a real case: ADX/volume/ATR score high (support), but market
    // structure/EMA trend score low (why it was actually skipped). Before
    // this fix, the |contribution|-sorted explanation showed ADX/volume/ATR
    // for a *skipped* setup, reading as if strong evidence was ignored.
    const g: GatedScore = {
      probability: 0.61,
      decision: "skipped_score",
      modelUsed: "rule_v3",
      blockReason: null,
      v3Bucket: null,
      factors: [
        { name: "adx", contribution: 15.4, description: "ADX_STRONG" },
        { name: "volume", contribution: 15.0, description: "VOLUME_STRONG" },
        { name: "atr", contribution: 12.1, description: "ATR_STRONG" },
        { name: "structure", contribution: 5, description: "STRUCTURE_RANGING" },
        { name: "rsi", contribution: 4, description: "RSI_WEAK" },
        { name: "emaTrend", contribution: 8, description: "EMA_NEUTRAL" },
      ],
    };
    const text = explainScore("NQ", "short", g, 0.65);
    expect(text).toContain("STRUCTURE_RANGING");
    expect(text).toContain("RSI_WEAK");
    expect(text).toContain("EMA_NEUTRAL");
    expect(text).not.toContain("ADX_STRONG");
  });

  it("shows all 5 of v6's factors, not just the top 3 -- v6 is a fixed set of weighted criteria, not a variable-length list of minor adjustments", () => {
    const g: GatedScore = {
      probability: 0,
      decision: "skipped_score",
      modelUsed: "rule_v6",
      blockReason: null,
      v3Bucket: null,
      factors: [
        { name: "correctionLegBars", contribution: 0, description: "CORRECTION_BARS" },
        { name: "rising20EmaProximity", contribution: 0, description: "EMA_PROXIMITY" },
        { name: "fibRetracement", contribution: 0, description: "FIB_RETRACEMENT" },
        { name: "reversalBarQuality", contribution: 0, description: "REVERSAL_BAR" },
        { name: "marketSpeed", contribution: 0, description: "MARKET_SPEED" },
      ],
    };
    const text = explainScore("ES", "short", g, 0.65);
    expect(text).toContain("CORRECTION_BARS");
    expect(text).toContain("EMA_PROXIMITY");
    expect(text).toContain("FIB_RETRACEMENT");
    expect(text).toContain("REVERSAL_BAR");
    expect(text).toContain("MARKET_SPEED");
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
