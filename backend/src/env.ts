// Must be the very first import in src/index.ts so process.env is populated
// before any other module (config.ts, logger.ts, etc.) reads from it.
// Uses Node's built-in env file loader (stable since Node 20.6) -- no dotenv
// dependency needed.
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isSea } from "node:sea";

// A Node Single Executable Application (see scripts/build-exe.mjs) injects
// the bundled JS as a blob inside a copy of node.exe -- `import.meta.url` no
// longer corresponds to a real on-disk sibling directory in that context, so
// the normal "../.env relative to this module" resolution below would throw
// (`ERR_INVALID_URL`) instead of silently falling through like a missing
// file would. Packaged mode resolves relative to the real executable's own
// directory instead; everything else (dev via tsx, `node dist/index.js`)
// keeps the original behavior unchanged.
const envPath = isSea()
  ? path.join(path.dirname(process.execPath), ".env")
  : fileURLToPath(new URL("../.env", import.meta.url));

try {
  process.loadEnvFile(envPath);
} catch {
  // .env not present (e.g. env vars supplied directly by the host) -- fine.
}
