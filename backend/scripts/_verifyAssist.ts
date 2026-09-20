import "../src/env.js";
import { sendChatMessage } from "../src/assistant/client.js";
import { prisma } from "../src/db/client.js";

const start = Date.now();
const result = await sendChatMessage("Quick check -- are you responsive? No tool calls needed, just confirm.");
console.log("elapsed ms:", Date.now() - start);
console.log("reply:", JSON.stringify(result.reply));
await prisma.$disconnect();
