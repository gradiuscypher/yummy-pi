/**
 * Provider Usage Extension for Pi
 *
 * Shows spend and remaining balance in the footer for whichever provider the
 * active model uses, and swaps when the model changes:
 *
 *   openrouter           ->  "$0.42 session · $84.03 credits"
 *   openai, openai-codex ->  "$0.00 session · 5h 12% (resets 3h10m) · wk 4% (resets 5d2h)"
 *   anything else        ->  "$0.42 session"
 *
 * Session spend is summed from the assistant messages on the current branch.
 * Balances are fetched with the key Pi already holds
 * (`ctx.modelRegistry.getApiKeyForProvider`). Every turn end refetches; start
 * and model swaps reuse a fetch younger than MIN_REFRESH_MS.
 *
 * ChatGPT limits come from the `openai-codex` login even while the active
 * model is on `openai` (Sign in with ChatGPT): the usage endpoint rejects the
 * `openai` token, so the Codex credential is used for that one read-only call.
 * Without it the footer falls back to session spend. This assumes both logins
 * draw on the same plan-wide 5-hour and weekly windows.
 *
 * To add a provider, add a SOURCES entry and map provider ids to it in
 * SOURCE_FOR_PROVIDER.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "provider-usage";
const MIN_REFRESH_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

type BalanceFetcher = (apiKey: string, signal: AbortSignal) => Promise<string>;

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const usd = (n: number) => `$${n.toFixed(2)}`;

async function getJson(url: string, apiKey: string, signal: AbortSignal): Promise<any> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return (await res.json()).data;
}

/** "3d12h", "4h27m", "12m" */
function formatReset(seconds: number): string {
  const m = Math.max(0, Math.round(seconds / 60));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m % 60}m`;
  return `${m}m`;
}

/** The Codex access token is a JWT; the usage endpoint wants its account id. */
function codexAccountId(token: string): string | undefined {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    return claims["https://api.openai.com/auth"]?.chatgpt_account_id;
  } catch {
    return undefined;
  }
}

interface Source {
  /** Pi provider whose stored credential authenticates the balance call. */
  credential: string;
  fetch: BalanceFetcher;
}

const SOURCES: Record<string, Source> = {
  chatgpt: {
    credential: "openai-codex",
    fetch: async (apiKey, signal) => {
      const accountId = codexAccountId(apiKey);
      if (!accountId) throw new Error("no chatgpt_account_id in token");
      const res = await fetch(CODEX_USAGE_URL, {
        headers: { Authorization: `Bearer ${apiKey}`, "ChatGPT-Account-Id": accountId },
        signal,
      });
      if (!res.ok) throw new Error(`${CODEX_USAGE_URL} -> ${res.status}`);
      const limits = (await res.json()).rate_limit;
      const parts: string[] = [];
      for (const [label, w] of [["5h", limits?.primary_window], ["wk", limits?.secondary_window]] as const) {
        if (typeof w?.used_percent !== "number") continue;
        parts.push(`${label} ${Math.round(w.used_percent)}% (resets ${formatReset(w.reset_after_seconds)})`);
      }
      if (parts.length === 0) throw new Error("no rate-limit windows in response");
      return parts.join(" · ");
    },
  },

  openrouter: {
    credential: "openrouter",
    fetch: async (apiKey, signal) => {
      const [credits, key] = await Promise.all([
        getJson("https://openrouter.ai/api/v1/credits", apiKey, signal),
        getJson("https://openrouter.ai/api/v1/key", apiKey, signal),
      ]);
      let text = `${usd(credits.total_credits - credits.total_usage)} credits`;
      // A per-key spending cap can bind before the account balance does.
      if (typeof key.limit_remaining === "number") text += ` · key ${usd(key.limit_remaining)} left`;
      return text;
    },
  },
};

const SOURCE_FOR_PROVIDER: Record<string, string> = {
  openai: "chatgpt",
  "openai-codex": "chatgpt",
  openrouter: "openrouter",
};

function sessionSpend(ctx: ExtensionContext): number {
  let total = 0;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    total += (entry.message as any).usage?.cost?.total ?? 0;
  }
  return total;
}

export default function (pi: ExtensionAPI) {
  // Last fetched balance text per source, so a model swap shows something
  // immediately instead of waiting on the network.
  const balances = new Map<string, { text: string; at: number }>();
  const inflight = new Set<string>();

  function render(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const provider = ctx.model?.provider;
    const source = provider ? SOURCE_FOR_PROVIDER[provider] : undefined;
    const parts = [`${usd(sessionSpend(ctx))} session`];
    const balance = source ? balances.get(source) : undefined;
    if (balance) parts.push(balance.text);
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", parts.join(" · ")));
  }

  async function refresh(ctx: ExtensionContext, force = false) {
    const provider = ctx.model?.provider;
    const sourceId = provider ? SOURCE_FOR_PROVIDER[provider] : undefined;
    const source = sourceId ? SOURCES[sourceId] : undefined;
    if (!sourceId || !source || inflight.has(sourceId)) return;
    const cached = balances.get(sourceId);
    if (!force && cached && Date.now() - cached.at < MIN_REFRESH_MS) return;

    inflight.add(sourceId);
    try {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(source.credential);
      if (!apiKey) return;
      const text = await source.fetch(apiKey, AbortSignal.timeout(FETCH_TIMEOUT_MS));
      balances.set(sourceId, { text, at: Date.now() });
    } catch {
      // Keep the last good value; a failed refresh must never disturb the session.
    } finally {
      inflight.delete(sourceId);
    }
    render(ctx);
  }

  const update = (force: boolean) => async (_event: unknown, ctx: ExtensionContext) => {
    render(ctx);
    await refresh(ctx, force);
  };

  // Start and model swaps may reuse a recent fetch; a finished turn has spent
  // money, so it always refetches.
  pi.on("session_start", update(false));
  pi.on("model_select", update(false));
  pi.on("turn_end", update(true));
}
