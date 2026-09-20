"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { apiFetch, fetcher } from "@/lib/api";
import { AssistantAction, AssistantContentPart, AssistantMessage, SystemState } from "@/lib/types";
import { Panel } from "@/components/Panel";
import { Badge } from "@/components/Badge";
import { useConfirm } from "@/components/ConfirmDialog";
import { ScoutPanel } from "@/components/ScoutPanel";
import { TaylorPanel } from "@/components/TaylorPanel";

const STARTER_PROMPTS = [
  "What's my current performance -- win rate, profit factor, and drawdown?",
  "Are there any open positions right now?",
  "Explain how the consensus rule decides whether a signal actually trades.",
  "What's the dealer gamma report for ES and NQ right now?",
];

/**
 * Normalizes whatever shape `message.content` actually is into
 * AssistantContentPart[]. The Gemini path (assistant/client.ts) always
 * persists a proper Part[] array, but the Ollama path
 * (assistant/ollamaLoop.ts, ASSISTANT_PROVIDER="ollama") persists a totally
 * different envelope -- {"messages": [{role, content: <string>}],
 * "__provider": "ollama"} -- which crashed this page outright ("parts.filter
 * is not a function", confirmed live 2026-09-03) the moment any
 * Ollama-backed reply landed in the transcript. Any other/malformed shape
 * falls back to an empty array rather than throwing, same "fail closed"
 * posture as every DOM extractor in this codebase.
 */
function normalizeContent(content: unknown): AssistantContentPart[] {
  if (Array.isArray(content)) return content as AssistantContentPart[];
  if (content && typeof content === "object" && (content as { __provider?: unknown }).__provider === "ollama") {
    const messages = (content as { messages?: unknown }).messages;
    if (Array.isArray(messages)) {
      return messages
        .filter((m): m is { content: string } => typeof (m as { content?: unknown })?.content === "string")
        .map((m) => ({ text: m.content }));
    }
  }
  return [];
}

/** A part-array's readable text, if it has any real text parts (as opposed to only functionCall/functionResponse parts). */
function textOf(parts: AssistantContentPart[]): string {
  return parts
    .filter((p) => typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

function toolCallsOf(parts: AssistantContentPart[]): { name: string; args: Record<string, unknown> }[] {
  return parts.filter((p) => p.functionCall?.name).map((p) => ({ name: p.functionCall!.name!, args: p.functionCall!.args ?? {} }));
}

function toolResultsOf(parts: AssistantContentPart[]): { name: string; isError: boolean }[] {
  return parts
    .filter((p) => p.functionResponse?.name)
    .map((p) => ({ name: p.functionResponse!.name!, isError: p.functionResponse!.response?.error !== undefined }));
}

function ChatBubble({ message }: { message: AssistantMessage }) {
  const parts = normalizeContent(message.content);
  const text = textOf(parts);
  const calls = toolCallsOf(parts);
  const results = toolResultsOf(parts);

  // A tool-result-only "user" turn (Gemini has no separate "tool" role --
  // function responses are echoed back as role "user") isn't a real thing
  // the operator typed, so it renders as a compact inline note instead of a
  // full chat bubble matching the actual user's own messages.
  if (results.length > 0 && text.length === 0) {
    return (
      <div className="flex justify-start">
        <div className="max-w-[80%] rounded-lg border border-white/5 bg-black/10 px-3 py-1.5 text-xs text-gray-500">
          {results.map((r, i) => (
            <span key={i} className="mr-2">
              {r.isError ? "✗" : "↩"} {r.name}
              {r.isError ? " failed" : ""}
            </span>
          ))}
        </div>
      </div>
    );
  }

  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] space-y-1.5 rounded-2xl px-4 py-2.5 text-sm ${
          isUser ? "bg-accent/20 text-white" : "border border-white/10 bg-white/[0.03] text-gray-200"
        }`}
      >
        {calls.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {calls.map((c, i) => (
              <span key={i} className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-gray-500">
                {"⚙"} {c.name}
              </span>
            ))}
          </div>
        )}
        {text && <p className="whitespace-pre-wrap">{text}</p>}
      </div>
    </div>
  );
}

function toneForAction(status: string): "good" | "bad" {
  return status === "success" ? "good" : "bad";
}

export default function AssistantPage() {
  const { data: systemState, mutate: mutateSystemState } = useSWR<SystemState>("/api/system/state", fetcher, { refreshInterval: 10000 });
  const { data: messages, mutate: mutateMessages } = useSWR<AssistantMessage[]>("/api/assistant/messages?limit=100", fetcher, {
    refreshInterval: 0,
  });
  const { data: actions } = useSWR<AssistantAction[]>("/api/assistant/actions?limit=50", fetcher, { refreshInterval: 5000 });
  const confirm = useConfirm();

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [togglingActions, setTogglingActions] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const assistantEnabled = systemState?.assistant.enabled ?? false;
  const actionsEnabled = systemState?.assistant.actionsEnabled ?? false;

  async function send(text: string) {
    if (!text.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      await apiFetch("/api/assistant/chat", { method: "POST", body: JSON.stringify({ message: text }) });
      setInput("");
      await mutateMessages();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  }

  async function toggleActionsEnabled() {
    const turningOn = !actionsEnabled;
    const msg = turningOn
      ? "Enable the assistant's write-tools? It will then be able to place real orders, close positions, and change trading settings on its own -- with NO confirmation step per action. This is the same live-money gate as the rest of the app."
      : "Disable the assistant's write-tools? It will go back to read-only (Q&A/analysis) immediately -- no restart needed.";
    if (!(await confirm(msg))) return;
    setTogglingActions(true);
    setError(null);
    try {
      await apiFetch("/api/system/assistant/actions-enabled", { method: "POST", body: JSON.stringify({ enabled: turningOn }) });
      await mutateSystemState();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to change the assistant actions gate");
    } finally {
      setTogglingActions(false);
    }
  }

  return (
    <div className="space-y-6">
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
      <Panel
        title="Assistant"
        action={
          <div className="flex items-center gap-2">
            <Badge text={assistantEnabled ? "enabled" : "disabled"} tone={assistantEnabled ? "good" : "neutral"} />
            <button
              onClick={toggleActionsEnabled}
              disabled={!assistantEnabled || togglingActions}
              className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors disabled:opacity-40 ${
                actionsEnabled ? "border-bad/30 bg-bad/15 text-bad hover:bg-bad/25" : "border-white/10 bg-white/10 text-gray-300 hover:bg-white/15"
              }`}
            >
              actions: {actionsEnabled ? "ON — click to disable" : "off — click to enable"}
            </button>
          </div>
        }
      >
        {!assistantEnabled ? (
          <p className="py-8 text-center text-sm text-gray-500">
            Assistant is disabled (ASSISTANT_ENABLED=false in backend/.env). Set a GEMINI_API_KEY and enable it to use this page.
          </p>
        ) : (
          <div className="flex h-[65vh] flex-col">
            <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto pr-1">
              {(!messages || messages.length === 0) && (
                <div className="space-y-2 py-6">
                  <p className="text-center text-sm text-gray-500">Ask it anything about the system, or try:</p>
                  <div className="flex flex-wrap justify-center gap-2">
                    {STARTER_PROMPTS.map((p) => (
                      <button
                        key={p}
                        onClick={() => send(p)}
                        className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-gray-300 hover:bg-white/5"
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {messages?.map((m) => <ChatBubble key={m.id} message={m} />)}
              {sending && <p className="text-xs text-gray-500">thinking...</p>}
            </div>

            {error && <p className="mt-2 text-xs text-bad">{error}</p>}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
              }}
              className="mt-3 flex gap-2"
            >
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={actionsEnabled ? "Ask, or tell it to do something -- it can act with no confirmation." : "Ask a question..."}
                disabled={sending}
                className="flex-1 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white placeholder:text-gray-600"
              />
              <button
                type="submit"
                disabled={sending || !input.trim()}
                className="rounded-lg bg-accent/90 px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-accent disabled:opacity-40"
              >
                Send
              </button>
            </form>
          </div>
        )}
      </Panel>

      <Panel title="Recent Actions" action={<Badge text={`${actions?.length ?? 0}`} tone="neutral" />}>
        <div className="max-h-[65vh] space-y-2 overflow-y-auto">
          {actions?.map((a) => (
            <div key={a.id} className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="font-mono font-medium text-white">{a.toolName}</span>
                <Badge text={a.status} tone={toneForAction(a.status)} />
              </div>
              <p className="text-gray-400">{a.resultSummary}</p>
              <div className="mt-1 flex items-center justify-between text-[10px] text-gray-600">
                {a.tradeId !== null && <span>trade #{a.tradeId}</span>}
                <span className="ml-auto">{new Date(a.createdAt).toLocaleTimeString()}</span>
              </div>
            </div>
          ))}
          {(!actions || actions.length === 0) && <p className="py-6 text-center text-sm text-gray-500">No actions taken yet.</p>}
        </div>
      </Panel>
    </div>

    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <ScoutPanel />
      <TaylorPanel />
    </div>
    </div>
  );
}
