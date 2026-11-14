import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import { sanitizeClaudeHistory } from "../src/assistant/claudeLoop.js";

type M = Anthropic.Beta.BetaMessageParam;
const use = (id: string): Anthropic.Beta.BetaContentBlockParam => ({ type: "tool_use", id, name: "get_positions", input: {} });
const result = (id: string): Anthropic.Beta.BetaContentBlockParam => ({ type: "tool_result", tool_use_id: id, content: "[]" });

describe("Claude assistant history replay (2026-11-14)", () => {
  it("drops thinking blocks from earlier turns but keeps text and paired tool calls", () => {
    const history: M[] = [
      { role: "user", content: "what's open?" },
      { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "Checking." }, use("t1")] },
      { role: "user", content: [result("t1")] },
      { role: "assistant", content: [{ type: "text", text: "Nothing is open." }] },
    ];
    const out = sanitizeClaudeHistory(history);
    expect(out).toHaveLength(4);
    expect(JSON.stringify(out)).not.toContain("thinking");
    expect((out[1]!.content as Anthropic.Beta.BetaContentBlockParam[]).map((b) => b.type)).toEqual(["text", "tool_use"]);
  });

  it("removes a tool call left unanswered by a crash, and an orphan result at the window's front edge", () => {
    const history: M[] = [
      { role: "user", content: [result("old")] }, // its tool_use fell outside the window
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: "close ES" },
      { role: "assistant", content: [{ type: "text", text: "Closing." }, use("t2")] }, // no result followed
      { role: "user", content: "did it work?" },
    ];
    const out = sanitizeClaudeHistory(history);
    expect(out[0]).toEqual({ role: "user", content: [{ type: "text", text: "close ES" }] });
    expect(out[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "Closing." }] });
    expect(out.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "did it work?" }] });
  });

  it("starts with a user turn and drops empty text", () => {
    const out = sanitizeClaudeHistory([
      { role: "assistant", content: [{ type: "text", text: "stray" }] },
      { role: "user", content: [{ type: "text", text: "  " }] },
      { role: "user", content: "hello" },
    ]);
    expect(out).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
  });
});
