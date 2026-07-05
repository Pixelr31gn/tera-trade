"""v1 trade-scoring model: a documented, weighted rule-based scorer.

There is no trade history to train a real model on yet, so Terra Trade ships
with a transparent heuristic instead of a black box. Every factor's
contribution is returned alongside the score so the explanation engine can
say *why* a setup scored the way it did. Once `trades` has enough labeled
rows, `app.scoring.training` can fit a calibrated ML model that supersedes
this scorer without changing anything downstream (both implement the same
`score(features) -> ScoreResult` contract).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from app.scoring.features import SetupFeatures

# Weights are hand-set, documented priors -- not fit to data. Magnitudes reflect
# how strongly each factor should move the pre-threshold probability; news risk
# dominates deliberately (never assume a clean setup outweighs event risk).
WEIGHTS = {
    "trend_alignment": 1.1,
    "momentum_alignment": 0.8,
    "adx_strength": 0.6,
    "volatility_regime": 0.5,
    "volume_confirmation": 0.4,
    "session": 0.3,
    "news_risk": 1.6,
    "historical_edge": 0.9,
}

BASE_LOGIT = -0.2  # slight negative prior so an empty/neutral setup scores below 0.5


@dataclass(frozen=True)
class FactorContribution:
    name: str
    contribution: float
    description: str


@dataclass(frozen=True)
class ScoreResult:
    probability: float
    factors: list[FactorContribution] = field(default_factory=list)


def _clip(x: float, lo: float = -1.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def score_setup(features: SetupFeatures) -> ScoreResult:
    direction = 1 if features.side == "long" else -1
    factors: list[FactorContribution] = []
    logit = BASE_LOGIT

    # 1. Trend alignment
    if features.trend_label == "none":
        raw = -0.3
        desc = "market is in a ranging regime, not clearly trending"
    elif (features.trend_label == "up" and direction == 1) or (features.trend_label == "down" and direction == -1):
        raw = 1.0
        desc = f"setup direction agrees with the prevailing {features.trend_label} trend"
    else:
        raw = -1.0
        desc = f"setup direction fights the prevailing {features.trend_label} trend"
    contrib = WEIGHTS["trend_alignment"] * raw
    logit += contrib
    factors.append(FactorContribution("trend_alignment", contrib, desc))

    # 2. Momentum alignment
    if features.momentum_10 is not None:
        raw = _clip(direction * features.momentum_10 * 20)
        desc = "recent momentum supports the setup" if raw > 0 else "recent momentum opposes the setup"
        contrib = WEIGHTS["momentum_alignment"] * raw
        logit += contrib
        factors.append(FactorContribution("momentum_alignment", contrib, desc))

    # 3. ADX trend strength (only rewarded when trend is aligned)
    if features.adx is not None and features.trend_label != "none":
        raw = _clip((features.adx - 20) / 30) if (features.trend_label == "up") == (direction == 1) else 0.0
        contrib = WEIGHTS["adx_strength"] * raw
        logit += contrib
        if raw:
            factors.append(FactorContribution("adx_strength", contrib, f"ADX={features.adx:.1f} confirms trend strength"))

    # 4. Volatility regime -- high vol adds noise/slippage risk, low vol is cleaner
    if features.vol_label == "high":
        raw = -0.6
        desc = "volatility regime is elevated, increasing noise and slippage risk"
    elif features.vol_label == "low":
        raw = 0.2
        desc = "volatility regime is low, favoring cleaner follow-through"
    else:
        raw = 0.0
        desc = "volatility regime is normal"
    contrib = WEIGHTS["volatility_regime"] * raw
    logit += contrib
    factors.append(FactorContribution("volatility_regime", contrib, desc))

    # 5. Volume confirmation
    if features.volume_zscore is not None:
        raw = _clip(features.volume_zscore / 2) if direction * (features.momentum_10 or 0) >= 0 else 0.0
        if raw:
            contrib = WEIGHTS["volume_confirmation"] * raw
            logit += contrib
            factors.append(FactorContribution("volume_confirmation", contrib, "above-average volume confirms the move"))

    # 6. Session
    raw = 0.3 if features.is_rth_session else -0.3
    desc = "regular trading hours favor liquidity and tighter spreads" if features.is_rth_session else "outside regular trading hours, liquidity is thinner"
    contrib = WEIGHTS["session"] * raw
    logit += contrib
    factors.append(FactorContribution("session", contrib, desc))

    # 7. News risk -- dominant, deliberately punitive
    if features.news_risk_flag:
        proximity = 1.0
        if features.news_minutes_to_event is not None:
            proximity = _clip(1 - abs(features.news_minutes_to_event) / 30, 0.0, 1.0) + 0.3
        raw = -_clip(proximity)
        contrib = WEIGHTS["news_risk"] * raw
        logit += contrib
        factors.append(FactorContribution("news_risk", contrib, "a high-impact news event is imminent or just released"))

    # 8. Strategy's own historical edge, if we have enough trades to know it
    if features.strategy_historical_win_rate is not None:
        raw = _clip((features.strategy_historical_win_rate - 0.5) * 2)
        contrib = WEIGHTS["historical_edge"] * raw
        logit += contrib
        factors.append(
            FactorContribution(
                "historical_edge", contrib, f"this strategy's historical win rate is {features.strategy_historical_win_rate:.0%}"
            )
        )

    probability = 1 / (1 + math.exp(-logit))
    return ScoreResult(probability=round(probability, 5), factors=factors)
