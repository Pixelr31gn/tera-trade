/**
 * Shadow-mode GEX observation log -- 2026-08-28, gamma-desk research brief's
 * recommended first deliverable: accumulate a real live sample of "what was
 * the GEX regime/levels when this setup reached a consensus decision" before
 * proposing any change to a live gate or score. The prior dealer-GEX
 * proximity gate was removed 2026-08-12 for vetoing good setups -- this is
 * deliberately NOT a gate or a scoring input. It only ever reads values the
 * caller already computed and writes one row; it can never affect which
 * trades execute.
 *
 * Every write is wrapped so a DB hiccup here can never interrupt the trading
 * loop, same posture as engine/dealerGexCache.ts's own fetch failure
 * handling. Live only -- not called from replay/decisionCore.ts, since GEX
 * data is always null there anyway (CBOE's historical chain can't be
 * backfilled, same fidelity limit .claude/rules/replay-harness.md already
 * documents for orderFlowSnapshot).
 */
import { Decimal } from "decimal.js";
import { prisma } from "../db/client.js";
import { childLogger } from "../core/logger.js";
import type { TradingSession } from "../analytics/session.js";
import type { StrategyVersion } from "../scoring/ruleScorer.js";
import type { GatedScore } from "../scoring/gate.js";
import type { DealerLevelResult } from "../marketData/dealerGex.js";
import { classifyGexRegime } from "../analytics/gexAlignment.js";

const logger = childLogger("shadowGexSignalLogger");

export interface ShadowGexSignalInput {
  at: Date;
  symbol: string;
  session: TradingSession;
  side: "long" | "short";
  strategyId: string;
  closePrice: Decimal;
  /** Null when GEX data was unavailable this tick (CBOE fetch failure, stale spot, etc.) -- see engine/dealerGexCache.ts. */
  dealerLevels: DealerLevelResult | null;
  gatedByVersion: Map<StrategyVersion, GatedScore>;
  consensusTaken: boolean;
  consensusAverageProbability: number;
}

/** Never throws -- a failure here is logged and swallowed, never surfaced to the caller. */
export async function logShadowGexSignal(input: ShadowGexSignalInput): Promise<void> {
  try {
    const spotPriceNum = input.dealerLevels?.spotPrice.toNumber() ?? input.closePrice.toNumber();
    const gammaFlipNum = input.dealerLevels?.gammaFlip?.toNumber() ?? null;
    const gexRegime = classifyGexRegime(spotPriceNum, gammaFlipNum);

    const versionScores: Record<string, { probability: number; decision: string; modelUsed: string }> = {};
    for (const [version, gated] of input.gatedByVersion) {
      versionScores[version] = { probability: gated.probability, decision: gated.decision, modelUsed: gated.modelUsed };
    }

    await prisma.shadowGexSignal.create({
      data: {
        time: input.at,
        symbol: input.symbol,
        session: input.session,
        side: input.side,
        strategyId: input.strategyId,
        closePrice: input.closePrice.toString(),
        callWall: input.dealerLevels?.callWall?.toString(),
        putWall: input.dealerLevels?.putWall?.toString(),
        gammaFlip: input.dealerLevels?.gammaFlip?.toString(),
        gexRegime,
        consensusTaken: input.consensusTaken,
        consensusAverageProbability: input.consensusAverageProbability.toString(),
        versionScores,
      },
    });
  } catch (err) {
    logger.warn({ symbol: input.symbol, err: err instanceof Error ? err.message : String(err) }, "shadow_gex_signal_log_failed");
  }
}
