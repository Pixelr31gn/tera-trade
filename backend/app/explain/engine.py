"""Plain-English explanation rendering.

Every scored setup, skipped setup, sizing decision, stop placement, trailing
adjustment, and news-driven pause is rendered to a short, human-readable
sentence here and persisted next to the row it explains (scores.explanation,
trades.explanation). This is the one place that turns structured
score/risk/regime output into the sentence a trader would actually read.
"""
from __future__ import annotations

from decimal import Decimal

from app.risk.engine import RiskAssessment
from app.scoring.gate import GatedScore


def explain_score(symbol: str, side: str, gated: GatedScore, threshold: float) -> str:
    pct = f"{gated.probability:.0%}"
    top_factors = sorted(gated.factors, key=lambda f: abs(f.contribution), reverse=True)[:3]
    factor_text = "; ".join(f.description for f in top_factors)

    if gated.decision == "taken":
        return (
            f"{side.upper()} {symbol}: scored {pct} confidence (>= {threshold:.0%} threshold, model={gated.model_used}). "
            f"Key factors: {factor_text}."
        )
    return (
        f"{side.upper()} {symbol}: scored {pct} confidence, below the {threshold:.0%} threshold -- setup skipped, no trade taken. "
        f"Key factors: {factor_text}."
    )


def explain_risk_rejection(symbol: str, side: str, assessment: RiskAssessment) -> str:
    return f"{side.upper()} {symbol}: risk engine blocked this trade -- {assessment.reason}"


def explain_trade_entry(
    symbol: str,
    side: str,
    quantity: int,
    entry_price: Decimal,
    assessment: RiskAssessment,
    score_explanation: str,
) -> str:
    return (
        f"{score_explanation} Entered {side} {quantity} {symbol} @ {entry_price}. "
        f"Stop {assessment.stop_price} ({assessment.stop_distance_points} pts), "
        f"target {assessment.take_profit_price}, trailing after breakeven by {assessment.trail_ticks} ticks. "
        f"{assessment.reason}"
    )


def explain_trade_exit(symbol: str, side: str, exit_reason: str, exit_price: Decimal, pnl: Decimal) -> str:
    outcome = "a gain" if pnl >= 0 else "a loss"
    reason_text = {
        "stop": "the stop-loss was hit",
        "target": "the take-profit target was hit",
        "trailing_stop": "the trailing stop was hit, locking in a favorable move",
        "manual": "the position was closed manually",
        "kill_switch": "the risk engine's kill switch force-closed this position",
    }.get(exit_reason, exit_reason)
    return f"Closed {side} {symbol} @ {exit_price} for {outcome} of {pnl:.2f} -- {reason_text}."


def explain_news_pause(symbol: str, event_name: str, impact: str, minutes_to_event: float | None) -> str:
    when = f"in {minutes_to_event:.0f} minutes" if minutes_to_event and minutes_to_event > 0 else "moments ago"
    return (
        f"{symbol}: new entries paused because '{event_name}' ({impact} impact) releases {when}. "
        f"Trading will resume once the news risk window passes."
    )


def explain_kill_switch(reason: str) -> str:
    return f"Kill switch engaged: {reason}. All new entries are blocked until an operator reviews and clears it."
