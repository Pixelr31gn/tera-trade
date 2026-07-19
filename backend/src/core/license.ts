/**
 * License key gate -- the app refuses to start without a valid key, issued
 * per-licensee via scripts/generateLicenseKey.ts.
 *
 * Honest limitation, stated plainly rather than oversold: this is
 * source-distributed TypeScript, not a compiled/obfuscated binary. Anyone
 * willing to read license.ts can find LICENSE_SIGNING_SECRET and mint their
 * own keys -- no local, offline verification scheme can prevent that (a
 * phone-home license server could, at the cost of requiring hosted
 * infrastructure and an internet dependency, which was explicitly not
 * wanted here). What this mechanism actually provides:
 *   1. A real, practical barrier for the overwhelming majority of casual
 *      copying -- most people will not dig through source for a signing key.
 *   2. Each issued key is tied to a specific named licensee, so a copy found
 *      running under someone else's name is a clear, provable breach of the
 *      license agreement (see ../../LICENSE.md) -- the actual enforcement
 *      mechanism is contractual/legal, not cryptographic.
 * Verification is symmetric (HMAC): whatever secret signs a key must also be
 * present to verify it. `.env` never ships in a distributed package (it's
 * where the real secrets live) -- so the *only* thing that reaches every
 * recipient's copy is this source file itself. That means the real signing
 * secret has to live in the constant below, not just in your own local
 * .env -- an env-only secret would let you issue keys that verify on your
 * own machine but fail for everyone you actually send the software to.
 * The LICENSE_SIGNING_SECRET env var still overrides this (useful if you'd
 * rather not have it sit in source control at all -- see the note in
 * generateLicenseKey.ts), but whatever value is baked in here at the moment
 * you build a distributable package (scripts/package.ps1) is what every
 * recipient's copy will actually verify against.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const DEFAULT_LICENSE_SIGNING_SECRET = "5c7f50a497bacd85efdb05156aa0cee3530c4aaac64090c093c0ad293a6a1688";

export interface LicensePayload {
  licensedTo: string;
  issuedAt: string; // ISO date
  expiresAt: string | null; // ISO date, or null for no expiry
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

export function issueLicenseKey(payload: LicensePayload, secret: string): string {
  const payloadB64 = base64url(JSON.stringify(payload));
  const signature = sign(payloadB64, secret);
  return `${payloadB64}.${signature}`;
}

export type LicenseCheckResult =
  | { valid: true; payload: LicensePayload }
  | { valid: false; reason: string };

export function verifyLicenseKey(key: string, expectedLicensedTo: string, secret: string): LicenseCheckResult {
  const parts = key.split(".");
  if (parts.length !== 2) return { valid: false, reason: "malformed license key" };
  const [payloadB64, signature] = parts as [string, string];

  const expectedSignature = sign(payloadB64, secret);
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return { valid: false, reason: "signature does not match -- key was not issued for this build, or has been tampered with" };
  }

  let payload: LicensePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return { valid: false, reason: "malformed license payload" };
  }

  if (payload.licensedTo !== expectedLicensedTo) {
    return { valid: false, reason: `key was issued to "${payload.licensedTo}", not "${expectedLicensedTo}" -- set LICENSED_TO to match your license exactly` };
  }

  if (payload.expiresAt && new Date(payload.expiresAt).getTime() < Date.now()) {
    return { valid: false, reason: `license expired on ${payload.expiresAt}` };
  }

  return { valid: true, payload };
}
