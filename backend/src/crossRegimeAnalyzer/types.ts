/** Shared shapes for the Cross-Regime Analyzer (see this directory's other files). */
import type { TradingSession } from "../analytics/session.js";

export type BucketDimension = "marketStructure" | "liquidity" | "priceAction";

export interface UnderperformerBucket {
  session: TradingSession;
  dimension: BucketDimension;
  label: string;
  sampleSize: number;
  avgRMultiple: number;
}
