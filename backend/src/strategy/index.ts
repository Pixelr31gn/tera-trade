import { BreakoutStrategy } from "./breakout.js";
import { MeanReversionStrategy } from "./meanReversion.js";
import { TrendFollowingStrategy } from "./trendFollowing.js";
import type { Strategy } from "./types.js";

export * from "./types.js";
export { BreakoutStrategy } from "./breakout.js";
export { MeanReversionStrategy } from "./meanReversion.js";
export { TrendFollowingStrategy } from "./trendFollowing.js";

export const ALL_STRATEGIES: Strategy[] = [new BreakoutStrategy(), new MeanReversionStrategy(), new TrendFollowingStrategy()];
