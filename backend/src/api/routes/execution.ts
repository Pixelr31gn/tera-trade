import type { FastifyInstance } from "fastify";
import { requireApiKey } from "../../core/security.js";
import { getExecutionOpportunitiesSnapshot } from "../../execution/executionDecisionEngine.js";

export async function executionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  // Live, in-memory Execution Decision Engine state -- distinct from
  // /api/recommendations, which only ever shows the per-version score
  // explanation captured at scoring time and a trade id once filled. A
  // resting/building opportunity has neither yet, so this is the only place
  // that shows "the EDE is actually working this signal right now."
  app.get("/api/execution/opportunities", async () => getExecutionOpportunitiesSnapshot());
}
