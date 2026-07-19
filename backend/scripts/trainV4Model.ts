/**
 * Run this to (re)train v4's per-session logistic regression models from
 * accumulated real/simulated outcome data: `npm run train:v4`.
 *
 * Writes artifacts to src/scoring/artifacts/trade-scorer-v4-<session>.json,
 * which scoring/training.ts's MLScorer reads at runtime -- once a session's
 * artifact exists, v4 stops falling back and starts actually scoring that
 * session with the trained model. Re-run this periodically as more labeled
 * outcomes accumulate; it always retrains from scratch, never incrementally.
 */
import { trainModel } from "../src/scoring/training.js";

async function main(): Promise<void> {
  const reports = await trainModel();
  console.log("");
  for (const r of reports) {
    if (r.trained) {
      console.log(`${r.session}: trained on ${r.rowsUsed} rows, holdout accuracy ${((r.holdoutAccuracy ?? 0) * 100).toFixed(1)}%`);
    } else {
      console.log(`${r.session}: not trained -- only ${r.rowsUsed} labeled rows (need 200+)`);
    }
  }
  console.log("");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
