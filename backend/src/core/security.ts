import type { FastifyReply, FastifyRequest } from "fastify";
import { getSettings } from "./config.js";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function requireApiKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const settings = getSettings();
  const provided = request.headers["x-api-key"];
  if (typeof provided !== "string" || !timingSafeEqual(provided, settings.apiKey)) {
    await reply.code(401).send({ error: "Invalid or missing API key" });
  }
}

export function isValidWsApiKey(key: string | null): boolean {
  const settings = getSettings();
  return key !== null && timingSafeEqual(key, settings.apiKey);
}
