// Read-only connectivity check for the ProjectX Gateway broker (backend/src/brokers/
// projectXGatewayBroker.ts) -- confirms auth works and the configured account ID is real, without
// ever placing an order. This adapter has never made a single real API call before (see that
// file's own header comment) -- this script exists specifically to verify it before BROKER_KIND is
// ever switched to "projectx" for live trading.
//
// Usage (from backend/): npx tsx scripts/projectXConnectivityCheck.ts
// Requires PROJECTX_USERNAME / PROJECTX_API_KEY / PROJECTX_ACCOUNT_ID already set in backend/.env.
import "../src/env.js";
import { getSettings } from "../src/core/config.js";
import { ProjectXGatewayBroker } from "../src/brokers/projectXGatewayBroker.js";

async function main(): Promise<void> {
  const settings = getSettings();
  if (!settings.projectXUsername || !settings.projectXApiKey || !settings.projectXAccountId) {
    console.error("PROJECTX_USERNAME / PROJECTX_API_KEY / PROJECTX_ACCOUNT_ID must all be set in backend/.env first.");
    process.exitCode = 1;
    return;
  }

  const broker = new ProjectXGatewayBroker();

  console.log(`Connecting to ${settings.projectXBaseUrl} as "${settings.projectXUsername}"...`);
  await broker.connect();
  console.log("Auth OK -- got a real session token.\n");

  console.log("Fetching accounts (read-only)...");
  const accounts = await broker.getAccounts();
  console.log(`Found ${accounts.length} account(s):`);
  for (const a of accounts) {
    console.log(`  - id=${a.accountId} name=${a.name} balance=${a.balance.toString()} equity=${a.equity.toString()}`);
  }

  const configuredId = settings.projectXAccountId;
  const matched = accounts.find((a) => String(a.accountId) === String(configuredId));
  console.log(
    matched
      ? `\nPROJECTX_ACCOUNT_ID (${configuredId}) matches a real account above -- good.`
      : `\nWARNING: PROJECTX_ACCOUNT_ID (${configuredId}) does NOT match any account returned above -- double-check this value before going any further.`
  );

  if (matched) {
    console.log("\nFetching open positions (read-only) for the configured account...");
    const positions = await broker.getPositions(String(configuredId));
    console.log(`Found ${positions.length} open position(s).`);
    for (const p of positions) {
      console.log(`  - ${p.symbol} ${p.side} qty=${p.quantity} avgPrice=${p.avgPrice.toString()}`);
    }
  }

  await broker.disconnect();
  console.log("\nDone -- no orders were placed. This only confirms auth + read access.");
}

main().catch((err) => {
  console.error("Connectivity check FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
