import type { FastifyReply, FastifyRequest } from "fastify";
import { getCookie, verifySessionToken, SESSION_COOKIE_NAME } from "./auth.js";
import { getSettings } from "./config.js";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Accepts either credential: the X-API-Key header (non-browser callers --
// scripts, curl, future integrations) or the httpOnly session cookie issued
// by POST /api/auth/login once someone's entered the dashboard password (see
// core/auth.ts). The dashboard itself now only ever uses the latter -- see
// frontend/lib/api.ts's 2026-08-14 change dropping the API key that used to
// be baked into its public JS bundle.
export async function requireApiKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const settings = getSettings();
  const provided = request.headers["x-api-key"];
  if (typeof provided === "string" && timingSafeEqual(provided, settings.apiKey)) return;

  if (verifySessionToken(getCookie(request.headers.cookie, SESSION_COOKIE_NAME))) return;

  await reply.code(401).send({ error: "Not authenticated" });
}

export function isValidWsApiKey(key: string | null, cookieHeader?: string): boolean {
  const settings = getSettings();
  if (key !== null && timingSafeEqual(key, settings.apiKey)) return true;
  return verifySessionToken(getCookie(cookieHeader, SESSION_COOKIE_NAME));
}
