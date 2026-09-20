import type { FastifyInstance } from "fastify";
import {
  createSessionToken,
  getCookie,
  serializeExpiredSessionCookie,
  serializeSessionCookie,
  SESSION_COOKIE_NAME,
  verifyPassword,
  verifySessionToken,
} from "../../core/auth.js";
import { getSettings } from "../../core/config.js";

// Small in-memory lockout, not per-IP/per-account -- there is exactly one
// password and one process (a local desktop app, see docs/ARCHITECTURE.md),
// so this just slows down brute-force guessing without needing a database
// row or a rate-limit dependency for a single shared secret.
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000;
let failedAttempts = 0;
let lockedUntil = 0;

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { password?: string } }>("/api/auth/login", async (request, reply) => {
    if (Date.now() < lockedUntil) {
      return reply.code(429).send({ error: "Too many attempts -- try again in a minute" });
    }

    const settings = getSettings();
    if (!settings.authPasswordHash) {
      return reply.code(500).send({ error: "No login password configured -- run `npm run auth:set-password` in backend/" });
    }

    const password = request.body?.password ?? "";
    if (!verifyPassword(password, settings.authPasswordHash)) {
      failedAttempts += 1;
      if (failedAttempts >= MAX_ATTEMPTS) {
        lockedUntil = Date.now() + LOCKOUT_MS;
        failedAttempts = 0;
      }
      return reply.code(401).send({ error: "Incorrect password" });
    }

    failedAttempts = 0;
    reply.header("Set-Cookie", serializeSessionCookie(createSessionToken()));
    return { status: "ok" };
  });

  app.get("/api/auth/session", async (request) => {
    const authenticated = verifySessionToken(getCookie(request.headers.cookie, SESSION_COOKIE_NAME));
    return { authenticated };
  });

  app.post("/api/auth/logout", async (_request, reply) => {
    reply.header("Set-Cookie", serializeExpiredSessionCookie());
    return { status: "ok" };
  });
}
