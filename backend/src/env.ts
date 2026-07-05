// Must be the very first import in src/index.ts so process.env is populated
// before any other module (config.ts, logger.ts, etc.) reads from it.
// Uses Node's built-in env file loader (stable since Node 20.6) -- no dotenv
// dependency needed.
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../../.env", import.meta.url));

try {
  process.loadEnvFile(envPath);
} catch {
  // .env not present (e.g. env vars supplied directly by the host) -- fine.
}
