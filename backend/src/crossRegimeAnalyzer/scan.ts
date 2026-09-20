/** One full scan: pull the already-cached session breakdowns, flag underperformers, write/reinforce a pitch for each. */
import { getSettings } from "../core/config.js";
import { childLogger } from "../core/logger.js";
import { computeSessionPerformanceForAllSessions } from "../api/routes/analytics.js";
import { findUnderperformers } from "./analyze.js";
import { writeUnderperformerPitch } from "./alert.js";
import type { UnderperformerBucket } from "./types.js";

const logger = childLogger("crossRegimeAnalyzer");

export interface ScanResult {
  flagged: UnderperformerBucket[];
  pitchIds: number[];
}

export async function runScan(): Promise<ScanResult> {
  const settings = getSettings();
  const sessionPerformance = await computeSessionPerformanceForAllSessions();
  const flagged = findUnderperformers(sessionPerformance, {
    minSampleSize: settings.crossRegimeMinSampleSize,
    maxAvgR: settings.crossRegimeMaxAvgR,
  });

  const pitchIds: number[] = [];
  for (const bucket of flagged) {
    const result = await writeUnderperformerPitch(bucket);
    pitchIds.push(result.pitchId);
    logger.info(
      { pitchId: result.pitchId, wasNew: result.wasNew, session: bucket.session, dimension: bucket.dimension, label: bucket.label, sampleSize: bucket.sampleSize, avgRMultiple: bucket.avgRMultiple },
      "cross_regime_underperformer_flagged"
    );
  }

  if (flagged.length === 0) {
    logger.info({ minSampleSize: settings.crossRegimeMinSampleSize, maxAvgR: settings.crossRegimeMaxAvgR }, "cross_regime_scan_clean");
  }

  return { flagged, pitchIds };
}
