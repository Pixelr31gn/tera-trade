/**
 * Offline ML scoring model training pipeline.
 *
 * Fits a hand-rolled logistic regression (gradient descent + L2
 * regularization) on closed trades, labeled by whether the trade was
 * profitable. A full ML library (scikit-learn equivalent) isn't warranted at
 * this dataset size or model complexity -- logistic regression trained by
 * maximum likelihood is already a properly calibrated probabilistic model,
 * and hand-rolling it avoids any native-build dependency. Only meaningful
 * once `trades` has a non-trivial number of closed rows; until then
 * `scoring/gate.ts` keeps using the rule-based scorer.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { prisma } from "../db/client.js";
import { childLogger } from "../core/logger.js";
import type { SetupFeatures } from "./features.js";

const logger = childLogger("scoringTraining");

export const MODEL_PATH = fileURLToPath(new URL("./artifacts/trade-scorer.json", import.meta.url));
export const MIN_TRAINING_ROWS = 200;

export const FEATURE_COLUMNS = [
  "momentum10",
  "atrNormalizedRange",
  "distanceFromMa20Atr",
  "volumeZscore",
  "realizedVolZscore",
  "regimeConfidence",
  "adx",
  "slopeR2",
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

export async function trainModel(): Promise<TrainingReport> {
  const rows = await prisma.score.findMany({
    where: { trade: { status: "closed", pnl: { not: null } } },
    include: { trade: true },
  });

  if (rows.length < MIN_TRAINING_ROWS) {
    logger.info({ rows: rows.length, required: MIN_TRAINING_ROWS }, "insufficient_data");
    return { rowsUsed: rows.length, trained: false, holdoutAccuracy: null };
  }

  const X = rows.map((r) => toFeatureRow(r.features as Record<string, unknown>));
  const y = rows.map((r) => (Number(r.trade!.pnl) > 0 ? 1 : 0));

  // Simple holdout split (last 20%, data isn't shuffled since trades are naturally time-ordered).
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
  writeFileSync(MODEL_PATH, JSON.stringify(model, null, 2));

  logger.info({ rows: rows.length, accuracy }, "training_done");
  return { rowsUsed: rows.length, trained: true, holdoutAccuracy: accuracy };
}

export class MLScorer {
  private model: TrainedModel;

  constructor() {
    this.model = JSON.parse(readFileSync(MODEL_PATH, "utf-8")) as TrainedModel;
  }

  static isAvailable(): boolean {
    return existsSync(MODEL_PATH);
  }

  scoreProbability(features: SetupFeatures): number {
    const row = toFeatureRow(features as unknown as Record<string, unknown>);
    const z = row
      .map((v, j) => (v - this.model.featureMeans[j]!) / this.model.featureStds[j]!)
      .reduce((acc, xij, j) => acc + xij * this.model.weights[j]!, this.model.bias);
    return sigmoid(z);
  }
}
