/**
 * LSD Logger Extension
 *
 * Intercepts every LLM call Pi makes and POSTs a structured log entry to the
 * LLM Stats Dashboard (LSD) API for cost analysis and conversation debugging.
 *
 * Config (env vars):
 *   LSD_API_KEY   - API key with logs:write scope
 *   LSD_BASE_URL  - Base URL of the LSD API (default: http://localhost:8000/api/v1)
 *
 * Commands:
 *   /lsd          - Show status (enabled, endpoint, key prefix, session stats, last error)
 *   /lsd on       - Enable logging
 *   /lsd off      - Disable logging
 *   /lsd test     - Send a synthetic test entry to verify connectivity
 *
 * Status bar: shows "📊 N" (logged count) while enabled
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

// ── Config ─────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "http://localhost:8000/api/v1";
const MAX_CONTENT_BYTES = 900_000; // stay comfortably under 1 MB API limit

// ── Types ───────────────────────────────────────────────────────────────────

interface LsdLogPayload {
  provider: string;
  model: string;
  request: {
    messages: Array<{ role: string; content: string }>;
    params?: Record<string, unknown>;
  };
  response: {
    message: { role: string; content: string };
    finish_reason: string | null;
  };
  conversation_id?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  cost?: {
    total: number;
    currency: string;
  };
  status: "ok" | "error";
  error?: string | null;
  client_timestamp?: string;
  latency_ms?: number;
  tool_calls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    result?: unknown;
  }>;
  metadata?: Record<string, unknown>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Map Pi's stopReason to LSD's finish_reason */
function mapFinishReason(stopReason: string): string {
  switch (stopReason) {
    case "stop":      return "stop";
    case "length":    return "length";
    case "toolUse":   return "tool_calls";
    case "error":     return "error";
    case "aborted":   return "stop"; // treat user-aborted as stop
    default:          return stopReason;
  }
}

/** Flatten Pi content parts to a plain string */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => {
      if (part.type === "text")     return part.text ?? "";
      if (part.type === "thinking") return `[thinking: ${part.thinking ?? ""}]`;
      if (part.type === "image")    return "[image]";
      if (part.type === "toolCall") return `[tool_call: ${part.name}]`;
      return "";
    })
    .join("")
    .trim();
}

/** Convert a Pi AgentMessage to a plain {role, content} object for LSD */
function toRoleContent(msg: any): { role: string; content: string } | null {
  if (!msg || typeof msg !== "object") return null;
  const role: string = msg.role ?? "user";
  // Skip custom/extension-injected message types that don't have a proper role
  if (!["user", "assistant", "toolResult", "system"].includes(role)) return null;

  let content = "";
  if (role === "toolResult") {
    // Represent tool results as assistant-visible context
    const toolName = msg.toolName ?? "tool";
    const resultText = flattenContent(msg.content);
    content = `[Tool result: ${toolName}]\n${resultText}`;
    return { role: "tool", content };
  }

  content = flattenContent(msg.content);
  // Map toolResult → tool for LSD schema
  const lsdRole = role === "assistant" ? "assistant" : "user";
  return { role: lsdRole, content };
}

/** Truncate the entire payload to stay under MAX_CONTENT_BYTES */
function truncatePayload(payload: LsdLogPayload): LsdLogPayload {
  const json = JSON.stringify(payload);
  if (json.length <= MAX_CONTENT_BYTES) return payload;

  // Truncate message content proportionally
  const clone = JSON.parse(json) as LsdLogPayload;
  const overBy = json.length - MAX_CONTENT_BYTES;
  const msgCount = clone.request.messages.length + 1; // +1 for response
  const cutPer = Math.ceil(overBy / msgCount);

  clone.request.messages = clone.request.messages.map((m) => ({
    ...m,
    content: m.content.length > cutPer
      ? m.content.slice(0, m.content.length - cutPer) + " [truncated]"
      : m.content,
  }));
  if (clone.response.message.content.length > cutPer) {
    clone.response.message.content =
      clone.response.message.content.slice(
        0,
        clone.response.message.content.length - cutPer,
      ) + " [truncated]";
  }
  return clone;
}

/** POST to LSD with up to 3 retries on 429/5xx. Never throws. */
async function postLog(
  payload: LsdLogPayload,
  baseUrl: string,
  apiKey: string,
  onError: (err: string) => void,
): Promise<boolean> {
  const url = `${baseUrl.replace(/\/$/, "")}/logs`;
  const body = JSON.stringify(truncatePayload(payload));

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        body,
      });

      if (res.status === 201) return true;

      // No retry on client errors
      if (res.status < 500 && res.status !== 429) {
        const text = await res.text().catch(() => "");
        onError(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        return false;
      }

      // Retry on 429 / 5xx
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }

      onError(`HTTP ${res.status} after ${attempt + 1} attempts`);
      return false;
    } catch (err: any) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      onError(err?.message ?? String(err));
      return false;
    }
  }
  return false;
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Runtime config ────────────────────────────────────────────────────
  const baseUrl = process.env.LSD_BASE_URL ?? DEFAULT_BASE_URL;
  const apiKey = process.env.LSD_API_KEY ?? "";
  // Disable logging at startup if no API key is configured
  let enabled = apiKey !== "";

  // ── Session state ──────────────────────────────────────────────────────
  let conversationId: string | undefined;
  let sessionFile: string | null = null;
  let sessionCwd = "";
  let currentProvider = "";
  let currentModel = "";

  // ── Per-turn state ─────────────────────────────────────────────────────
  let turnStartMs: number | undefined;
  // Snapshot of context messages from the `context` event (what was sent to LLM)
  let pendingContextMessages: Array<{ role: string; content: string }> = [];
  // Accumulated tool results for the current turn, keyed by toolCallId
  const pendingToolResults = new Map<string, { content: string; isError: boolean }>();

  // A tool-call turn payload that is waiting for its tool results before being shipped.
  // Keyed by toolCallId so results can be matched back to the right call.
  let deferredPayload: LsdLogPayload | null = null;
  let deferredCtx: Parameters<Parameters<typeof pi.on>[1]>[1] | null = null;

  // ── Stats ──────────────────────────────────────────────────────────────
  let sessionLoggedCount = 0;
  let sessionErrorCount = 0;
  let lastError: string | null = null;

  // ── Status bar ────────────────────────────────────────────────────────
  function updateStatus(ctx: { ui: { setStatus: (key: string, val: string) => void } }) {
    if (!enabled) {
      ctx.ui.setStatus("lsd", "");
      return;
    }
    const label = sessionErrorCount > 0
      ? `📊 ${sessionLoggedCount} (⚠ ${sessionErrorCount} err)`
      : `📊 ${sessionLoggedCount}`;
    ctx.ui.setStatus("lsd", label);
  }

  // ── Events ─────────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    conversationId = ctx.sessionManager.getSessionId();
    sessionFile = ctx.sessionManager.getSessionFile() ?? null;
    sessionCwd = ctx.cwd;

    if (ctx.model) {
      currentProvider = ctx.model.provider;
      currentModel = ctx.model.id;
    }

    // Reset per-session stats
    sessionLoggedCount = 0;
    sessionErrorCount = 0;
    lastError = null;

    updateStatus(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    currentProvider = event.model.provider;
    currentModel = event.model.id;
    updateStatus(ctx);
  });

  pi.on("turn_start", async (event, _ctx) => {
    turnStartMs = event.timestamp;
    pendingContextMessages = [];
    pendingToolResults.clear();
    // Note: deferredPayload is intentionally NOT cleared here — it persists
    // until the context event of this next turn so we can backfill tool results.
  });

  /** Snapshot the messages array sent to the LLM this turn */
  pi.on("context", async (event, ctx) => {
    pendingContextMessages = (event.messages as any[])
      .map(toRoleContent)
      .filter((m): m is { role: string; content: string } => m !== null);

    // If we have a deferred tool-call payload, backfill its tool results now.
    // The context for this turn contains toolResult messages whose content holds
    // the output from each tool call made in the previous turn.
    if (deferredPayload && deferredPayload.tool_calls && deferredPayload.tool_calls.length > 0) {
      const ctxToUse = deferredCtx ?? ctx;

      // Build a map of toolCallId → result text from the incoming context messages.
      // Pi surfaces tool results as messages with role "toolResult" (mapped to "tool"
      // by toRoleContent), whose content is "[Tool result: <name>]\n<output>".
      // We can also match directly from the raw event messages.
      const rawMessages: any[] = event.messages as any[];
      const resultByCallId = new Map<string, { content: string; isError: boolean }>();
      for (const raw of rawMessages) {
        if (raw?.role === "toolResult" && raw?.toolCallId) {
          const text = flattenContent(raw.content);
          resultByCallId.set(raw.toolCallId, { content: text, isError: raw.isError ?? false });
        }
      }

      // Attach results to each deferred tool call
      for (const tc of deferredPayload.tool_calls) {
        const res = resultByCallId.get(tc.id);
        if (res) {
          tc.result = { content: res.content, isError: res.isError };
        }
      }

      const payloadToShip = deferredPayload;
      deferredPayload = null;
      deferredCtx = null;

      // Fire and forget
      (async () => {
        const success = await postLog(payloadToShip, baseUrl, apiKey, (err) => {
          lastError = err;
          sessionErrorCount++;
        });
        if (success) sessionLoggedCount++;
        updateStatus(ctxToUse);
      })();
    }
  });

  /** Accumulate tool results so we can attach them to tool_calls in the log */
  pi.on("tool_result", async (event, _ctx) => {
    const text = event.content
      .map((p: any) => (p.type === "text" ? p.text : ""))
      .join("")
      .trim();
    pendingToolResults.set(event.toolCallId, { content: text, isError: event.isError });
  });

  /** Core: build + ship log on every finalized assistant message */
  pi.on("message_end", async (event, ctx) => {
    if (!enabled) return;
    if (event.message.role !== "assistant") return;

    const msg = event.message as AssistantMessage;
    if (!msg.usage) return;
    // Skip zero-usage messages (e.g. cached/empty responses)
    if (msg.usage.totalTokens === 0 && (!msg.usage.cost || msg.usage.cost.total === 0)) return;

    const latencyMs = turnStartMs !== undefined
      ? Math.round(msg.timestamp - turnStartMs)
      : undefined;

    // ── Extract text content and tool calls from the assistant message ──
    const textParts: string[] = [];
    const toolCallsInMessage: Array<{
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      result?: unknown;
    }> = [];

    for (const part of msg.content) {
      if (part.type === "text") {
        textParts.push(part.text);
      } else if (part.type === "toolCall") {
        const result = pendingToolResults.get(part.id);
        toolCallsInMessage.push({
          id: part.id,
          name: part.name,
          arguments: part.arguments,
          result: result ? { content: result.content, isError: result.isError } : undefined,
        });
      }
    }

    const responseContent = textParts.join("").trim();
    const isError = msg.stopReason === "error";

    const payload: LsdLogPayload = {
      provider: msg.provider ?? currentProvider,
      model: msg.responseModel ?? msg.model ?? currentModel,
      conversation_id: conversationId,
      request: {
        messages: pendingContextMessages,
      },
      response: {
        message: {
          role: "assistant",
          content: responseContent,
        },
        finish_reason: mapFinishReason(msg.stopReason ?? "stop"),
      },
      usage: {
        prompt_tokens: msg.usage.input,
        completion_tokens: msg.usage.output,
        total_tokens: msg.usage.totalTokens,
      },
      status: isError ? "error" : "ok",
      error: isError ? (msg.errorMessage ?? "Unknown error") : null,
      client_timestamp: new Date(msg.timestamp).toISOString(),
      latency_ms: latencyMs,
      metadata: {
        cwd: sessionCwd,
        session_file: sessionFile,
        pi_api: msg.api,
        cache_read_tokens: msg.usage.cacheRead,
        cache_write_tokens: msg.usage.cacheWrite,
      },
    };

    if (msg.usage.cost) {
      payload.cost = { total: msg.usage.cost.total, currency: "USD" };
    }

    if (toolCallsInMessage.length > 0) {
      payload.tool_calls = toolCallsInMessage;
    }

    // If this turn ended with tool calls, the tool results haven't arrived yet —
    // they come back in the *next* turn's context. Defer shipping until then.
    if (msg.stopReason === "toolUse" && toolCallsInMessage.length > 0) {
      deferredPayload = payload;
      deferredCtx = ctx;
      return;
    }

    // Fire and forget — never let logging break Pi
    (async () => {
      const success = await postLog(payload, baseUrl, apiKey, (err) => {
        lastError = err;
        sessionErrorCount++;
      });
      if (success) {
        sessionLoggedCount++;
      }
      updateStatus(ctx);
    })();
  });

  // ── /lsd command ────────────────────────────────────────────────────────

  pi.registerCommand("lsd", {
    description: "LSD Logger — status / on / off / test",
    handler: async (args, ctx: ExtensionCommandContext) => {
      const arg = (args ?? "").trim().toLowerCase();

      if (arg === "on") {
        if (!apiKey) {
          ctx.ui.notify("Cannot enable: LSD_API_KEY environment variable is not set", "error");
          return;
        }
        enabled = true;
        updateStatus(ctx);
        ctx.ui.notify("LSD Logger enabled", "info");
        return;
      }

      if (arg === "off") {
        enabled = false;
        ctx.ui.setStatus("lsd", "");
        ctx.ui.notify("LSD Logger disabled", "info");
        return;
      }

      if (arg === "test") {
        ctx.ui.notify("Sending test log entry…", "info");
        const testPayload: LsdLogPayload = {
          provider: "test",
          model: "pi-lsd-extension",
          conversation_id: conversationId ?? "test-session",
          request: {
            messages: [{ role: "user", content: "LSD Logger connectivity test from Pi" }],
          },
          response: {
            message: { role: "assistant", content: "Test entry from yummy-pi lsd-logger extension" },
            finish_reason: "stop",
          },
          usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 },
          status: "ok",
          client_timestamp: new Date().toISOString(),
          metadata: { source: "lsd-logger-test", cwd: sessionCwd },
        };
        const ok = await postLog(testPayload, baseUrl, apiKey, (err) => {
          ctx.ui.notify(`Test failed: ${err}`, "error");
        });
        if (ok) ctx.ui.notify("✅ Test log entry accepted (201)", "info");
        return;
      }

      // Default: show status
      const keyPrefix = apiKey ? apiKey.split("_").slice(0, 2).join("_") + "_***" : "(not set — LSD_API_KEY missing)";
      const stateLabel = !apiKey
        ? "⛔ disabled (LSD_API_KEY not set)"
        : enabled ? "✅ enabled" : "⛔ disabled";
      const lines = [
        `LSD Logger status`,
        `─────────────────────────────────────────`,
        `State       : ${stateLabel}`,
        `Endpoint    : ${baseUrl}`,
        `API key     : ${keyPrefix} (${process.env.LSD_API_KEY ? "from env" : "not configured"})`,
        `Conv ID     : ${conversationId ?? "(none)"}`,
        ``,
        `This session`,
        `  Logged    : ${sessionLoggedCount}`,
        `  Errors    : ${sessionErrorCount}`,
        `  Last error: ${lastError ?? "none"}`,
        ``,
        `Commands: /lsd on | /lsd off | /lsd test`,
      ];

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
