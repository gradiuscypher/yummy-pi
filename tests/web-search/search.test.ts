import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig, providerStatus, rank, keyFor, type Config } from "../../extensions/web-search/config.ts";
import { normalizeResponse, runSearch, searchProvider } from "../../extensions/web-search/search.ts";

const config: Config = { providers: {
  exa: { apiKey: "test-exa", costPerSearchUsd: 0.01 },
  tavily: { apiKey: "test-tavily", costPerSearchUsd: 0.02 },
}, routing: { maxAttempts: 2 } };

test("eligibility explains disabled, missing, unsupported and cost-policy exclusions without secrets", () => {
  const cfg: Config = { providers: {
    exa: { apiKey: "secret", enabled: false }, tavily: {}, scry: { apiKey: "secret" },
    kagi: { apiKey: "secret", freeCreditsRemaining: 0 },
    linkup: { apiKey: "secret", freeCreditsRemaining: 2 },
  }, routing: { allowUnknownCost: false } };
  const status = providerStatus(cfg, {});
  const reason = (id: string) => status.find(x => x.id === id)?.reason;
  assert.equal(reason("exa"), "disabled");
  assert.equal(reason("tavily"), "missing credential");
  assert.equal(reason("scry"), "adapter not implemented");
  assert.equal(reason("kagi"), "unknown cost disallowed");
  assert.equal(reason("linkup"), "eligible");
  assert.ok(!JSON.stringify(status).includes("secret"));
});
test("config credentials take precedence; whitespace is not a credential", () => {
  assert.equal(keyFor("exa", { providers: { exa: { apiKey: " inline ", apiKeyEnv: "CUSTOM" } } }, { CUSTOM: "environment" }), "inline");
  assert.equal(keyFor("exa", { providers: { exa: { apiKey: " ", apiKeyEnv: "CUSTOM" } } }, { CUSTOM: "  " }), undefined);
});
test("free credits then cost then weight; zero credits are not free", () => {
  const cfg: Config = { providers: {
    exa: { freeCreditsRemaining: 0, costPerSearchUsd: 0.001, weight: 100 },
    tavily: { freeCreditsRemaining: 1, costPerSearchUsd: 0.02 },
    kagi: { freeCreditsRemaining: 1, costPerSearchUsd: 0.01 },
  } };
  assert.deepEqual(rank(["exa", "tavily", "kagi"], cfg), ["kagi", "tavily", "exa"]);
  cfg.routing = { preferKnownFreeCredits: false };
  assert.equal(rank(["exa", "tavily", "kagi"], cfg)[0], "exa");
});
test("validation errors do not echo secret values", () => {
  assert.throws(() => validateConfig({ providers: { exa: { apiKey: "secret", weight: "secret" } } }), error => error instanceof Error && !error.message.includes("secret"));
  for (const cfg of [{ routing: { maxAttempts: 0 } }, { routing: { maxResults: 999 } }, { providers: { exa: { costPerSearchUsd: -1 } } }, { providers: [] }]) assert.throws(() => validateConfig(cfg));
});
test("search falls back on empty results, reporting every attempted provider", async () => {
  const report = await runSearch("SOC 2 cost", config, undefined, undefined, async id => ({ results: id === "exa" ? [] : [{ title: "CPA", url: "https://example.com/cost", snippet: "quote-only" }] }));
  assert.equal(report.status, "success");
  assert.equal(report.provider, "tavily");
  assert.deepEqual(report.attempts.map(x => x.outcome), ["empty", "success"]);
});
test("nonempty results do not fan out; pinned providers never fall back", async () => {
  let calls = 0;
  await runSearch("pricing", config, undefined, undefined, async () => { calls++; return { results: [{ title: "source", url: "https://example.com", snippet: "" }] }; });
  assert.equal(calls, 1);
  calls = 0;
  const pinned = await runSearch("pricing", config, undefined, "exa", async () => { calls++; throw new Error("secret body"); });
  assert.equal(calls, 1);
  assert.equal(pinned.status, "failed");
  assert.ok(!JSON.stringify(pinned).includes("secret body"));
});
test("maxAttempts bounds escalation; cancellation does not call another provider", async () => {
  let calls = 0;
  const bounded = await runSearch("pricing", { ...config, routing: { maxAttempts: 1 } }, undefined, undefined, async () => { calls++; return { results: [] }; });
  assert.equal(calls, 1);
  assert.equal(bounded.status, "empty");
  const controller = new AbortController();
  calls = 0;
  await assert.rejects(runSearch("pricing", config, controller.signal, undefined, async () => { calls++; controller.abort(); throw new Error("aborted"); }));
  assert.equal(calls, 1);
});
test("provider HTTP failures never echo response bodies or credentials", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("private-secret echoed by provider", { status: 401 });
    await assert.rejects(searchProvider("exa", "pricing", "private-secret", config), error => error instanceof Error && error.message === "Provider HTTP 401");
    let query = "";
    globalThis.fetch = async input => {
      query = new URL(String(input)).searchParams.get("q") ?? "";
      return new Response(JSON.stringify({ data: [{ title: "CPA", url: "https://example.com", snippet: "quote-only" }] }), { headers: { "content-type": "application/json" } });
    };
    const result = await searchProvider("kagi", "SOC 2 Type I + pricing", "test-key", config);
    assert.equal(query, "SOC 2 Type I + pricing");
    assert.equal(result.results.length, 1);
  } finally { globalThis.fetch = original; }
});

test("all adapters normalize URLs; generated answers expose citations rather than raw JSON", () => {
  const cases = [
    ["exa", { results: [{ title: "A", url: "https://example.com", text: "price" }] }],
    ["tavily", { results: [{ title: "A", url: "https://example.com", content: "price" }] }],
    ["kagi", { data: [{ title: "A", url: "https://example.com", snippet: "price" }, { t: 2 }] }],
    ["ceramic", { result: { results: [{ title: "A", url: "https://example.com", description: "price" }] } }],
    ["linkup", { results: [{ name: "A", url: "https://example.com", content: "price" }] }],
  ] as const;
  for (const [id, json] of cases) assert.equal(normalizeResponse(id, json).results[0].snippet, "price");
  const openai = normalizeResponse("openai", { output: [{ content: [{ type: "output_text", text: "Generated estimate", annotations: [
    { type: "url_citation", title: "CPA", url: "https://example.com/#one" },
    { type: "url_citation", title: "duplicate", url: "https://example.com/#two" },
    { type: "url_citation", url: "javascript:alert(1)" },
  ] }] }] });
  assert.equal(openai.results.length, 1);
  assert.equal(openai.answer, "Generated estimate");
  const router = normalizeResponse("openrouter", { choices: [{ message: { content: "Estimate", annotations: [{ type: "url_citation", url_citation: { url: "https://example.com", title: "CPA" } }] } }], citations: ["https://example.com"] });
  assert.equal(router.results.length, 1);
  assert.equal(router.answer, "Estimate");
});
