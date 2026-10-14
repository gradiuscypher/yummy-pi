import test from "node:test";
import assert from "node:assert/strict";
import { fetchBalances, formatBalances, updateBalance } from "../../omp-extensions/openrouter-balance/balances.ts";

const signal = () => AbortSignal.timeout(1_000);
const json = (data: unknown) => new Response(JSON.stringify({ data }));

test("account credits and capped key allowance use separate credentials and endpoints", async () => {
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(init?.redirect, "error");
    const authorization = new Headers(init?.headers).get("Authorization");
    if (String(input).endsWith("/credits")) {
      assert.equal(authorization, "Bearer management-secret");
      return json({ total_credits: 100, total_usage: 18.5 });
    }
    assert.equal(String(input), "https://openrouter.ai/api/v1/key");
    assert.equal(authorization, "Bearer inference-secret");
    return json({ limit: 25, limit_remaining: 6.25 });
  };
  assert.deepEqual(await fetchBalances("inference-secret", "management-secret", signal(), fetcher), {
    account: { value: 81.5 }, key: { value: 6.25 },
  });
});

test("an explicit null cap is uncapped, but missing or malformed limits are unknown", async () => {
  for (const [data, expected] of [
    [{ limit: null, limit_remaining: null }, { value: "uncapped" }],
    [{}, { error: "request failed" }],
    [{ limit: 20, limit_remaining: null }, { error: "request failed" }],
    [{ limit: 20, limit_remaining: "10" }, { error: "request failed" }],
    [{ limit: 20, limit_remaining: 0 }, { value: 0 }],
    [{ limit: 20, limit_remaining: -2 }, { value: -2 }],
  ]) {
    const result = await fetchBalances("key", undefined, signal(), async () => json(data));
    assert.deepEqual(result.key, expected);
    assert.deepEqual(result.account, { error: "management key required" });
  }
});

test("an account failure does not discard the successful key allowance or expose error bodies", async () => {
  const result = await fetchBalances("secret-key", "secret-management", signal(), async input =>
    String(input).endsWith("/credits")
      ? new Response("secret-management reflected by provider", { status: 403 })
      : json({ limit: 100, limit_remaining: 42 }),
  );
  assert.deepEqual(result, { account: { error: "HTTP 403" }, key: { value: 42 } });
});

test("parser and network failures cannot leak secret or server-controlled text", async () => {
  for (const fetcher of [
    async () => new Response("secret credential"),
    async () => { throw new Error("secret credential"); },
  ]) {
    const result = await fetchBalances("secret", "secret", signal(), fetcher);
    assert.deepEqual(result, { account: { error: "request failed" }, key: { error: "request failed" } });
  }
});

test("failed refreshes preserve last known balances as stale; recovery clears stale state", () => {
  const checked = updateBalance({}, { value: 18.5 }, 1_000);
  const failed = updateBalance(checked, { error: "HTTP 403" }, 2_000);
  assert.deepEqual(failed, { value: 18.5, checkedAt: 1_000, error: "HTTP 403" });
  assert.match(formatBalances({ account: failed, key: {} }, 2_000), /account \$18\.50 \[stale\]/);
  assert.match(formatBalances({ account: checked, key: {} }, 121_000), /account \$18\.50 \[stale\]/);
  const recovered = updateBalance(failed, { value: 17 }, 3_000);
  assert.deepEqual(recovered, { value: 17, checkedAt: 3_000 });
  assert.doesNotMatch(formatBalances({ account: recovered, key: { value: "uncapped", checkedAt: 3_000 } }, 3_000), /stale/);
});
