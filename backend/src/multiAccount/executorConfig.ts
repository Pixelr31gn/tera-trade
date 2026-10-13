/**
 * Environment config for the multi-account fan-out.
 *
 * Kept as its own small reader (rather than threaded through core/config.ts's
 * zod schema) so the whole feature stays additive and isolated while it's
 * being brought up. These are all non-secret endpoints/ports except the shared
 * secret, which is read from env and never logged by value.
 *
 * Executor (each remote PC) reads:
 *   EXECUTOR_PORT    (default 8787)
 *   EXECUTOR_HOST    (default 0.0.0.0 -- bind to the Tailscale IP to lock it down)
 *   EXECUTOR_SECRET  (required; the service refuses to start without it)
 *
 * Master (controller) reads:
 *   MIRROR_SECRET     (must match every executor's EXECUTOR_SECRET)
 *   MIRROR_EXECUTORS  (comma-separated name=url, e.g.
 *                      "pc2=http://100.124.205.10:8787,pc3=http://100.x.x.3:8787")
 */

export interface ExecutorServerConfig {
  host: string;
  port: number;
  secret: string;
}

export function loadExecutorServerConfig(): ExecutorServerConfig {
  const secret = (process.env.EXECUTOR_SECRET ?? "").trim();
  if (!secret) {
    throw new Error("EXECUTOR_SECRET must be set -- the executor service refuses to start without a shared secret");
  }
  const port = Number(process.env.EXECUTOR_PORT ?? 8787);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`EXECUTOR_PORT must be a valid port, got "${process.env.EXECUTOR_PORT}"`);
  }
  const host = (process.env.EXECUTOR_HOST ?? "0.0.0.0").trim();
  return { host, port, secret };
}

export interface MirrorTarget {
  name: string;
  url: string;
}

export interface MirrorClientConfig {
  secret: string;
  targets: MirrorTarget[];
}

export function loadMirrorClientConfig(): MirrorClientConfig {
  const secret = (process.env.MIRROR_SECRET ?? "").trim();
  const raw = (process.env.MIRROR_EXECUTORS ?? "").trim();
  const targets: MirrorTarget[] = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq <= 0) throw new Error(`MIRROR_EXECUTORS entry "${pair}" must be in the form name=url`);
      const name = pair.slice(0, eq).trim();
      const url = pair.slice(eq + 1).trim();
      if (!name || !url) throw new Error(`MIRROR_EXECUTORS entry "${pair}" must have both a name and a url`);
      return { name, url };
    });
  return { secret, targets };
}
