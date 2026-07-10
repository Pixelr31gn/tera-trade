/**
 * Offline ML scoring model training pipeline.
 *
 * Fits a hand-rolled logistic regression (gradient descent + L2
 * regularization) per trading session -- New York, London, and Asian are
 * modeled entirely separately since each has fundamentally different price
 * action, volume, volatility, and false-breakout frequency (see
 * analytics/session.ts). A single universal model would blur those
 * differences away.
 *
 * Trains on *every* labeled setup, not just executed trades: a skipped setup
 * that would have won or lost (see engine/outcomeEvaluator.ts's
 * missed_win/missed_loss labels) is just as informative for "should this kind
 * of setup be taken" as a real trade's outcome is. Rows still pending
 * evaluation (outcomeLabel null) or that never resolved either way
 * (no_resolution) are excluded -- there's no clear label to learn from.
 *
 * A full ML library (scikit-learn equivalent) isn't warranted at this dataset
 * size or model complexity -- logistic regression trained by maximum
 * likelihood is already a properly calibrated probabilistic model, and
 * hand-rolling it avoids any native-build dependency. Each session's model
 * only activates once that session has enough labeled rows;
 * `scoring/gate.ts` falls back to the rule-based scorer for any session that
 * isn't trained yet.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { prisma } from "../db/client.js";
import { childLogger } from "../core/logger.js";
import { TradingSession } from "../analytics/session.js";
import type { SetupFeatures } from "./features.js";

const logger = childLogger("scoringTraining");

export const MIN_TRAINING_ROWS_PER_SESSION = 200;

const ALL_SESSIONS: TradingSession[] = [TradingSession.NEW_YORK, TradingSession.LONDON, TradingSession.ASIAN];

// A setup "worked" if it was a real winning trade or a skipped setup that
// simulation shows would have won; symmetrically for "didn't work". Anything
// else (still pending, or resolved to neither stop nor target) isn't used.
const POSITIVE_OUTCOME_LABELS = new Set(["executed_win", "missed_win"]);
const NEGATIVE_OUTCOME_LABELS = new Set(["executed_loss", "missed_loss"]);

function modelPath(session: TradingSession): string {
  return fileURLToPath(new URL(`./artifacts/trade-scorer-${session}.json`, import.meta.url));
}

export const FEATURE_COLUMNS = [
  "momentum10",
  "atrNormalizedRange",
  "distanceFromMa20Atr",
  "volumeZscore",
  "realizedVolZscore",
  "regimeConfidence",
  "adx",
  "slopeR2",
  "dailyTrendConfidence",
  "longTargetWinRate",
  "hourOfDayUtc",
  "newsRiskFlag",
  "openingRangeBreakoutProbability",
  "openingRangeSampleSize",
] as const;

interface TrainedModel {
  weights: number[];
  bias: number;
  featureMeans: number[];
  featureStds: number[];
  featureColumns: readonly string[];
}

export interface TrainingReport {
  session: TradingSession;
  rowsUsed: number;
  trained: boolean;
  holdoutAccuracy: number | null;
}

function toFeatureRow(features: Record<string, unknown>): number[] {
  return FEATURE_COLUMNS.map((col) => {
    const v = features[col];
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number" && !Number.isNaN(v)) return v;
    return 0;
  });
}

function standardize(X: number[][]): { Z: number[][]; means: number[]; stds: number[] } {
  const n = X.length;
  const d = X[0]?.length ?? 0;
  const means = new Array(d).fill(0);
  const stds = new Array(d).fill(1);

  for (let j = 0; j < d; j++) {
    const col = X.map((row) => row[j]!);
    const m = col.reduce((a, b) => a + b, 0) / n;
    const variance = col.reduce((acc, v) => acc + (v - m) ** 2, 0) / n;
    means[j] = m;
    stds[j] = Math.sqrt(variance) || 1;
  }

  const Z = X.map((row) => row.map((v, j) => (v - means[j]!) / stds[j]!));
  return { Z, means, stds };
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

function trainLogisticRegression(X: number[][], y: number[], opts: { epochs?: number; lr?: number; l2?: number } = {}) {
  const { epochs = 500, lr = 0.1, l2 = 0.01 } = opts;
  const n = X.length;
  const d = X[0]?.length ?? 0;
  let weights = new Array(d).fill(0);
  let bias = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW = new Array(d).fill(0);
    let gradB = 0;

    for (let i = 0; i < n; i++) {
      const z = X[i]!.reduce((acc, xij, j) => acc + xij * weights[j]!, bias);
      const pred = sigmoid(z);
      const error = pred - y[i]!;
      for (let j = 0; j < d; j++) gradW[j] += error * X[i]![j]!;
      gradB += error;
    }

    for (let j = 0; j < d; j++) {
      weights[j] -= lr * (gradW[j] / n + l2 * weights[j]!);
    }
    bias -= lr * (gradB / n);
  }

  return { weights, bias };
}

async function trainModelForSession(session: TradingSession): Promise<TrainingReport> {
  // strategyVersion: "v1" only -- v1 and v2 shadow-score the exact same
  // signal (identical features/entry/outcome, see engine/loop.ts), so
  // including both would just train on the same examples twice.
  const rows = await prisma.score.findMany({
    where: { session, strategyVersion: "v1", outcomeLabel: { in: [...POSITIVE_OUTCOME_LABELS, ...NEGATIVE_OUTCOME_LABELS] } },
  });

  if (rows.length < MIN_TRAINING_ROWS_PER_SESSION) {
    logger.info({ session, rows: rows.length, required: MIN_TRAINING_ROWS_PER_SESSION }, "insufficient_data");
    return { session, rowsUsed: rows.length, trained: false, holdoutAccuracy: null };
  }

  const X = rows.map((r) => toFeatureRow(r.features as Record<string, unknown>));
  const y = rows.map((r) => (POSITIVE_OUTCOME_LABELS.has(r.outcomeLabel!) ? 1 : 0));

  // Simple holdout split (last 20%, data isn't shuffled since rows are naturally time-ordered).
  const splitAt = Math.floor(X.length * 0.8);
  const { Z, means, stds } = standardize(X);
  const trainX = Z.slice(0, splitAt);
  const trainY = y.slice(0, splitAt);
  const testX = Z.slice(splitAt);
  const testY = y.slice(splitAt);

  const { weights, bias } = trainLogisticRegression(trainX, trainY);

  let correct = 0;
  for (let i = 0; i < testX.length; i++) {
    const z = testX[i]!.reduce((acc, xij, j) => acc + xij * weights[j]!, bias);
    const predicted = sigmoid(z) >= 0.5 ? 1 : 0;
    if (predicted === testY[i]) correct++;
  }
  const accuracy = testX.length ? correct / testX.length : null;

  const model: TrainedModel = { weights, bias, featureMeans: means, featureStds: stds, featureColumns: FEATURE_COLUMNS };
  mkdirSync(new URL("./artifacts", import.meta.url), { recursive: true });
  writeFileSync(modelPath(session), JSON.stringify(model, null, 2));

  logger.info({ session, rows: rows.length, accuracy }, "training_done");
  return { session, rowsUsed: rows.length, trained: true, holdoutAccuracy: accuracy };
}

export async function trainModel(): Promise<TrainingReport[]> {
  const reports: TrainingReport[] = [];
  for (const session of ALL_SESSIONS) {
    reports.push(await trainModelForSession(session));
  }
  return reports;
}

export class MLScorer {
  private model: TrainedModel;

  constructor(session: TradingSession) {
    this.model = JSON.parse(readFileSync(modelPath(session), "utf-8")) as TrainedModel;
  }

  static isAvailable(session: TradingSession): boolean {
    return existsSync(modelPath(session));
  }

  scoreProbability(features: SetupFeatures): number {
    const row = toFeatureRow(features as unknown as Record<string, unknown>);
    const z = row
      .map((v, j) => (v - this.model.featureMeans[j]!) / this.model.featureStds[j]!)
      .reduce((acc, xij, j) => acc + xij * this.model.weights[j]!, this.model.bias);
    return sigmoid(z);
  }
}
