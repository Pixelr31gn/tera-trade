import { callOllamaChat } from "../src/assistant/ollamaClient.js";
import { getAvailableTools } from "../src/assistant/tools.js";

async function main() {
  const allTools = getAvailableTools(true);
  const tools = allTools.filter((t) => t.name === "set_daily_plan_zones");
  if (tools.length === 0) throw new Error("set_daily_plan_zones tool not found");

  const systemPrompt =
    "You are a trading analyst. You will be given real price data for ES and NQ. " +
    "Call set_daily_plan_zones once for ES and once for NQ with sensible zones based on the data given. " +
    "Do not call any other tool.";

  const userPrompt = `Current data:
ES: spot 7711.76, structural put wall (floor) 7650.00, structural call wall (ceiling) 7750.00.
NQ: spot 29433.43, structural put wall (floor) 29600.00 (already broken, price is below it), structural call wall (ceiling) 29500.00 (confirmed by price action).

Set daily plan zones for both ES and NQ now, one hard zone per symbol around the most relevant nearby level.`;

  const result = await callOllamaChat({ systemPrompt, userPrompt, tools });
  console.log("=== CONTENT ===");
  console.log(result.content);
  console.log("=== TOOL CALLS ===");
  console.log(JSON.stringify(result.toolCalls, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
