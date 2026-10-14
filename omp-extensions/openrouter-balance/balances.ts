export type BalanceValue = number | "uncapped";
export type BalanceResult = { value: BalanceValue } | { error: string };
export type BalanceSnapshot = { value?: BalanceValue; checkedAt?: number; error?: string };
export type Balances = { account: BalanceSnapshot; key: BalanceSnapshot };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid response");
  return value as Record<string, unknown>;
}

function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid response");
  return value;
}

async function request(
  path: "credits" | "key", token: string, signal: AbortSignal, fetcher: typeof fetch,
): Promise<Record<string, unknown>> {
  const response = await fetcher(`https://openrouter.ai/api/v1/${path}`, {
    headers: { Authorization: `Bearer ${token}` }, signal, redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  return record(record(await response.json()).data);
}

export async function fetchBalances(
  apiKey: string, managementKey: string | undefined, signal: AbortSignal, fetcher: typeof fetch = fetch,
): Promise<{ account: BalanceResult; key: BalanceResult }> {
  const safely = async (read: () => Promise<BalanceValue>): Promise<BalanceResult> => {
    try { return { value: await read() }; }
    catch (error) {
      // Never display network errors, response bodies, or JSON parser excerpts: they may contain secrets.
      const message = error instanceof Error && /^HTTP \d{3}$/.test(error.message)
        ? error.message : "request failed";
      return { error: message };
    }
  };
  const [account, key] = await Promise.all([
    managementKey
      ? safely(async () => {
        const data = await request("credits", managementKey, signal, fetcher);
        return finite(data.total_credits) - finite(data.total_usage);
      })
      : Promise.resolve({ error: "management key required" }),
    safely(async () => {
      const data = await request("key", apiKey, signal, fetcher);
      // Only an explicit null cap establishes uncapped; absent fields are not evidence.
      if (data.limit === null) return "uncapped";
      finite(data.limit);
      return finite(data.limit_remaining);
    }),
  ]);
  return { account, key };
}

export function updateBalance(previous: BalanceSnapshot, result: BalanceResult, now: number): BalanceSnapshot {
  return "value" in result ? { value: result.value, checkedAt: now } : { ...previous, error: result.error };
}

export function formatBalances(balances: Balances, now = Date.now()): string {
  const format = (label: string, state: BalanceSnapshot) => {
    if (state.value === undefined) return `${label} unavailable (${state.error ?? "checking"})`;
    const value = typeof state.value === "number" ? `$${state.value.toFixed(2)}` : state.value;
    const stale = state.error || (state.checkedAt !== undefined && now - state.checkedAt >= 120_000);
    return `${label} ${value}${stale ? " [stale]" : ""}`;
  };
  return `OpenRouter · ${format("account", balances.account)} · ${format("key", balances.key)}`;
}
