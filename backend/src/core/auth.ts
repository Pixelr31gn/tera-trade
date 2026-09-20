import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { getSettings } from "./config.js";

export const SESSION_COOKIE_NAME = "tera_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days -- local single-operator app, re-login monthly is enough

// Same scrypt "salt:hash" hex format is duplicated in scripts/exe-setup.cjs
// and scripts/setPassword.mjs (both dependency-free-by-convention, see
// exe-setup.cjs's header comment) -- keep all three in sync if this changes.
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, hash] = storedHash.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

// Deliberately just an HMAC-signed expiry, not a JWT/opaque-token/DB-backed
// session -- there is exactly one credential (the shared dashboard password)
// and no per-user state to look up. If a second login factor (TOTP) lands
// later, it plugs in as an extra check before this gets called, not as a
// change to the token shape itself.
export function createSessionToken(): string {
  const settings = getSettings();
  const payload = String(Date.now() + SESSION_TTL_MS);
  return `${payload}.${sign(payload, settings.sessionSecret)}`;
}

export function verifySessionToken(token: string | undefined | null): boolean {
  if (!token) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;

  const settings = getSettings();
  if (!settings.sessionSecret) return false;

  const expectedSig = Buffer.from(sign(payload, settings.sessionSecret));
  const providedSig = Buffer.from(signature);
  if (expectedSig.length !== providedSig.length || !timingSafeEqual(expectedSig, providedSig)) return false;

  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && Date.now() < expiresAt;
}

// Fastify has no cookie parser registered (see server.ts -- kept
// dependency-free rather than adding @fastify/cookie for the one cookie this
// app has), so reading the single session cookie back out of the raw header
// is done by hand here.
export function getCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export function serializeSessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

export function serializeExpiredSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}
