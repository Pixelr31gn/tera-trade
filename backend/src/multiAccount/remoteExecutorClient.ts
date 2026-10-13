/**
 * Master-side HTTP client for one remote executor. Implements RemoteExecutor,
 * so FanOutBroker treats it exactly like the in-process fake used in tests.
 *
 * A timeout is enforced per dispatch: a remote that hangs must not stall the
 * master's own order path. On any non-2xx or network error this throws, which
 * FanOutBroker records as that account's failure (and logs loudly) without
 * ever changing the master result.
 */
import type { OrderResult } from "../brokers/types.js";
import type { MirrorCommand, RemoteExecutor } from "./fanOutTypes.js";
import { decodeResult, encodeCommand } from "./wireCodec.js";

export interface RemoteExecutorClientOptions {
  name: string;
  /** Base URL of the executor, e.g. http://100.124.205.10:8787 */
  baseUrl: string;
  secret: string;
  timeoutMs?: number;
}

export class RemoteExecutorClient implements RemoteExecutor {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly timeoutMs: number;

  constructor(opts: RemoteExecutorClientOptions) {
    this.name = opts.name;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.secret = opts.secret;
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  async dispatch(command: MirrorCommand): Promise<OrderResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/mirror`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mirror-secret": this.secret,
        },
        body: JSON.stringify(encodeCommand(command)),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`executor ${this.name} HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      return decodeResult(await res.json());
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: controller.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
