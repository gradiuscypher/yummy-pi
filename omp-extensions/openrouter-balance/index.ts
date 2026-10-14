import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { fetchBalances, formatBalances, updateBalance, type Balances } from "./balances.ts";

const STATUS_KEY = "openrouter-balance";
const REFRESH_MS = 60_000;

export default function (pi: ExtensionAPI) {
  let balances: Balances = { account: {}, key: {} };
  let identity = "";
  let attemptedAt: number | undefined;
  let generation = 0;
  let stopTimer: (() => void) | undefined;
  let pending: { controller: AbortController; done: Promise<void> } | undefined;

  function reset() {
    generation++;
    pending?.controller.abort();
    pending = undefined;
    identity = "";
    attemptedAt = undefined;
    balances = { account: {}, key: {} };
  }

  const eligible = (ctx: ExtensionContext) =>
    ctx.mode === "tui" && ctx.agent.kind === "main" && ctx.models.current()?.provider === "openrouter";

  function render(ctx: ExtensionContext) {
    ctx.ui.setStatus(STATUS_KEY, eligible(ctx) ? formatBalances(balances) : undefined);
  }

  async function refresh(ctx: ExtensionContext, force = false): Promise<void> {
    if (!eligible(ctx)) {
      reset();
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const model = ctx.models.current()!;
    const sessionId = ctx.sessionManager.getSessionId();
    const version = generation;
    let apiKey: string | undefined;
    try {
      // Session-aware resolution follows the same pinned/rotated account as inference.
      apiKey = await ctx.modelRegistry.getApiKey(model, sessionId);
    } catch {
      apiKey = undefined;
    }
    if (version !== generation) return;
    if (!eligible(ctx) || ctx.models.current()?.id !== model.id || ctx.sessionManager.getSessionId() !== sessionId) return;
    if (!apiKey) {
      reset();
      balances = { account: { error: "credential unavailable" }, key: { error: "credential unavailable" } };
      render(ctx);
      return;
    }
    const managementKey = process.env.OPENROUTER_MANAGEMENT_KEY?.trim() || undefined;
    const nextIdentity = createHash("sha256").update(JSON.stringify([sessionId, apiKey, managementKey])).digest("hex");
    if (nextIdentity !== identity) {
      reset();
      identity = nextIdentity;
    }
    render(ctx);
    if (pending) return pending.done;
    if (!force && attemptedAt !== undefined && Date.now() - attemptedAt < REFRESH_MS) return;
    attemptedAt = Date.now();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]);
    const requestGeneration = generation;
    const done = (async () => {
      try {
        const result = await fetchBalances(apiKey, managementKey, signal);
        if (requestGeneration !== generation || controller.signal.aborted) return;
        const now = Date.now();
        balances = {
          account: updateBalance(balances.account, result.account, now),
          key: updateBalance(balances.key, result.key, now),
        };
        render(ctx);
      } finally {
        if (requestGeneration === generation) pending = undefined;
      }
    })();
    pending = { controller, done };
    await done;
  }

  function start(ctx: ExtensionContext) {
    stopTimer?.();
    reset();
    ctx.ui.setStatus(STATUS_KEY, undefined);
    if (ctx.mode !== "tui" || ctx.agent.kind !== "main") return;
    // Context has no model-change event. Its lazy models.current() also detects idle switches.
    const timer = ctx.setInterval(() => refresh(ctx), 5_000);
    stopTimer = () => ctx.clearTimer(timer);
    ctx.setTimeout(() => refresh(ctx), 0);
  }

  pi.on("session_start", (_event, ctx) => start(ctx));
  pi.on("session_switch", (_event, ctx) => start(ctx));
  pi.on("session_branch", (_event, ctx) => start(ctx));
  pi.on("turn_end", (_event, ctx) => refresh(ctx, true));
  pi.on("session_shutdown", (_event, ctx) => {
    stopTimer?.();
    reset();
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
  pi.registerCommand("openrouter-balance", {
    description: "Refresh OpenRouter account credits and the active key's spending allowance (read-only).",
    handler: async (_args, ctx) => {
      if (!eligible(ctx)) {
        ctx.ui.notify("Select an OpenRouter model in the main interactive session to view its balances.", "info");
        return;
      }
      await refresh(ctx, true);
      ctx.ui.notify(formatBalances(balances), "info");
    },
  });
}
