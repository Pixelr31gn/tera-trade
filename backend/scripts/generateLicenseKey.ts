/**
 * Run this to issue a new license key: `npm run license:generate -- "Jane Doe" [expiresAt]`
 *
 * Uses DEFAULT_LICENSE_SIGNING_SECRET (the constant baked into
 * core/license.ts -- see its comment for why that's the one that actually
 * matters for anyone you distribute the software to) unless
 * LICENSE_SIGNING_SECRET is set in backend/.env, which overrides it. This
 * tool is for you (the licensor) -- don't ship it or its output secret to a
 * licensee, only the two LICENSED_TO/LICENSE_KEY lines it prints.
 */
import { issueLicenseKey, DEFAULT_LICENSE_SIGNING_SECRET } from "../src/core/license.js";

function main(): void {
  const [licensedTo, expiresAtArg] = process.argv.slice(2);
  if (!licensedTo) {
    console.error('Usage: npm run license:generate -- "Licensee Name or Email" [expiresAt=YYYY-MM-DD]');
    process.exit(1);
  }

  const secret = process.env.LICENSE_SIGNING_SECRET || DEFAULT_LICENSE_SIGNING_SECRET;

  const expiresAt = expiresAtArg ? new Date(expiresAtArg).toISOString() : null;
  const key = issueLicenseKey({ licensedTo, issuedAt: new Date().toISOString(), expiresAt }, secret);

  console.log("");
  console.log(`Licensed to:  ${licensedTo}`);
  console.log(`Expires:      ${expiresAt ?? "never"}`);
  console.log("");
  console.log("Give the licensee these two lines for their backend/.env:");
  console.log("");
  console.log(`LICENSED_TO=${licensedTo}`);
  console.log(`LICENSE_KEY=${key}`);
  console.log("");
}

main();
