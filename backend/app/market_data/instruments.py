"""Reference instrument definitions for the Phase-0 futures universe.

`data_symbol` is the Yahoo Finance continuous-contract ticker used for free
historical/live backfill. `contract_id` is left blank until the user has a
ProjectX Gateway account and can resolve the live front-month contract via
POST /api/Contract/searchById.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal


@dataclass(frozen=True)
class InstrumentSpec:
    symbol: str  # canonical Terra Trade symbol, e.g. "ES"
    data_symbol: str  # Yahoo Finance ticker, e.g. "ES=F"
    exchange: str
    tick_size: Decimal
    point_value: Decimal


DEFAULT_INSTRUMENTS: list[InstrumentSpec] = [
    InstrumentSpec("ES", "ES=F", "CME", Decimal("0.25"), Decimal("50")),
    InstrumentSpec("NQ", "NQ=F", "CME", Decimal("0.25"), Decimal("20")),
    InstrumentSpec("CL", "CL=F", "NYMEX", Decimal("0.01"), Decimal("1000")),
    InstrumentSpec("GC", "GC=F", "COMEX", Decimal("0.10"), Decimal("100")),
]

_BY_SYMBOL = {i.symbol: i for i in DEFAULT_INSTRUMENTS}


def get_instrument(symbol: str) -> InstrumentSpec:
    try:
        return _BY_SYMBOL[symbol]
    except KeyError as exc:
        raise ValueError(f"Unknown instrument symbol: {symbol}") from exc
