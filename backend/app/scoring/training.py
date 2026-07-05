"""Offline ML scoring model training pipeline.

Fits a HistGradientBoostingClassifier (scikit-learn, no external C++ build
dependency -- LightGBM was considered but adds Windows build friction for
what is, at this dataset size, an equivalent model) with isotonic probability
calibration on closed trades, labeled by whether the trade was profitable.
Only meaningful once `trades` has a non-trivial number of closed rows; until
then `get_active_scorer()` keeps using the rule-based scorer.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.model_selection import train_test_split
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.db.models import Score, Trade
from app.scoring.features import SetupFeatures

logger = get_logger(__name__)

MODEL_PATH = Path(__file__).parent / "artifacts" / "trade_scorer.joblib"
MIN_TRAINING_ROWS = 200

FEATURE_COLUMNS = [
    "momentum_10",
    "atr_normalized_range",
    "distance_from_ma20_atr",
    "volume_zscore",
    "realized_vol_zscore",
    "regime_confidence",
    "adx",
    "slope_r2",
    "hour_of_day_utc",
    "news_risk_flag",
]


@dataclass(frozen=True)
class TrainingReport:
    rows_used: int
    trained: bool
    holdout_accuracy: float | None
    holdout_auc: float | None


async def _load_training_frame(session: AsyncSession) -> pd.DataFrame:
    rows = (
        await session.execute(
            select(Score.features, Trade.pnl)
            .join(Trade, Score.trade_id == Trade.id)
            .where(Trade.status == "closed", Trade.pnl.is_not(None))
        )
    ).all()
    if not rows:
        return pd.DataFrame()

    records = []
    for features, pnl in rows:
        record = {col: features.get(col) for col in FEATURE_COLUMNS}
        record["label"] = 1 if float(pnl) > 0 else 0
        records.append(record)
    return pd.DataFrame(records)


def _prepare_xy(df: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    df = df.copy()
    df["news_risk_flag"] = df["news_risk_flag"].astype(float)
    X = df[FEATURE_COLUMNS].apply(pd.to_numeric, errors="coerce").fillna(0.0).to_numpy()
    y = df["label"].to_numpy()
    return X, y


async def train_model(session: AsyncSession) -> TrainingReport:
    df = await _load_training_frame(session)
    if len(df) < MIN_TRAINING_ROWS:
        logger.info("scoring.training.insufficient_data", rows=len(df), required=MIN_TRAINING_ROWS)
        return TrainingReport(rows_used=len(df), trained=False, holdout_accuracy=None, holdout_auc=None)

    X, y = _prepare_xy(df)
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)

    base = HistGradientBoostingClassifier(max_depth=4, learning_rate=0.05, max_iter=200, random_state=42)
    model = CalibratedClassifierCV(base, method="isotonic", cv=3)
    model.fit(X_train, y_train)

    accuracy = float(model.score(X_test, y_test))
    try:
        from sklearn.metrics import roc_auc_score

        auc = float(roc_auc_score(y_test, model.predict_proba(X_test)[:, 1]))
    except ValueError:
        auc = None

    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, MODEL_PATH)
    logger.info("scoring.training.done", rows=len(df), accuracy=accuracy, auc=auc)
    return TrainingReport(rows_used=len(df), trained=True, holdout_accuracy=accuracy, holdout_auc=auc)


class MLScorer:
    """Loads the persisted calibrated model, if one has been trained."""

    def __init__(self) -> None:
        self._model = joblib.load(MODEL_PATH)

    @staticmethod
    def is_available() -> bool:
        return MODEL_PATH.exists()

    def score_probability(self, features: SetupFeatures) -> float:
        row = {col: getattr(features, col, None) for col in FEATURE_COLUMNS}
        row["news_risk_flag"] = float(bool(row["news_risk_flag"]))
        X = pd.DataFrame([row])[FEATURE_COLUMNS].apply(pd.to_numeric, errors="coerce").fillna(0.0).to_numpy()
        return float(self._model.predict_proba(X)[0, 1])
