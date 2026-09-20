// dailyPlanScheduler.ts's refreshForSession follows ASSISTANT_PROVIDER like
// everything else now (2026-09-04, see that file's own header comment for
// the history of why it was hardcoded to Gemini before, and why that was
// reverted) -- this script just delegates to it, so it goes through
// whichever provider backend/.env currently configures.
import { getSessionStart } from "../src/analytics/session.js";
import { refreshForSession } from "../src/assistant/dailyPlanScheduler.js";

async function main() {
  const sessionStart = getSessionStart(new Date());
  console.log(`Refreshing daily plan for session starting ${sessionStart.toISOString()}...`);
  await refreshForSession(sessionStart);
  console.log("Done.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
