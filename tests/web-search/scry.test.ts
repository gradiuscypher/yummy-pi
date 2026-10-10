import test from "node:test";
import assert from "node:assert/strict";
import { requestScry, scryStatus } from "../../extensions/web-search/scry.ts";
import { providerStatus, type Config } from "../../extensions/web-search/config.ts";

const cfg: Config = { providers: { scry: { enabled: true, apiKey: "private-secret" } } };

test("Scry uses documented context/schema/query routes and preserves corpus metadata", async () => {
  const original = globalThis.fetch;
  const calls: { url: URL; init?: RequestInit }[] = [];
  const data = { rows: [{ title: "Corpus item", uri: "https://example.com" }], accounting: { spend_nanodollars: 1 }, truncated: false };
  try {
    globalThis.fetch = async (input, init) => {
      calls.push({ url: new URL(String(input)), init });
      return new Response(" \n" + JSON.stringify(data));
    };
    const context = await requestScry({ operation: "context" }, {});
    assert.equal(calls[0].url.href, "https://api.scry.io/v1/scry/context?mode=agent");
    assert.equal(calls[0].init?.method, "GET");
    assert.equal(new Headers(calls[0].init?.headers).has("authorization"), false);
    assert.equal(context.evidenceKind, "unverified-corpus-data");
    await requestScry({ operation: "schema", mode: "index" }, cfg);
    assert.equal(calls[1].url.searchParams.get("mode"), "index");
    await requestScry({ operation: "schema", mode: "full" }, cfg);
    assert.equal(calls[2].url.searchParams.get("mode"), "full");
    await requestScry({ operation: "schema", relation: "hackernews.items,other.relation" }, cfg);
    assert.equal(calls[3].url.searchParams.get("relation"), "hackernews.items,other.relation");
    await requestScry({ operation: "schema" }, cfg);
    assert.equal(calls[4].url.search, "");
    const sql = "SELECT title, uri FROM hackernews.items LIMIT 20";
    const report = await requestScry({ operation: "query", sql }, cfg);
    assert.equal(calls[5].url.href, "https://api.scry.io/v1/scry/query");
    assert.equal(calls[5].init?.method, "POST");
    assert.equal(calls[5].init?.body, sql);
    const headers = new Headers(calls[5].init?.headers);
    assert.equal(headers.get("authorization"), "Bearer private-secret");
    assert.equal(headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(calls[5].init?.redirect, "error");
    assert.deepEqual(report.data, data);
    assert.ok(!JSON.stringify(report).includes("private-secret"));
  } finally { globalThis.fetch = original; }
});

test("Scry policies block requests before networking; SQL is never automatically routed", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return new Response("{}"); };
    await assert.rejects(requestScry({ operation: "context" }, { providers: { scry: { enabled: false } } }), /disabled/);
    const previous = process.env.SCRY_API_KEY;
    try {
      delete process.env.SCRY_API_KEY;
      await assert.rejects(requestScry({ operation: "schema" }, {}), /API key/);
    } finally {
      if (previous === undefined) delete process.env.SCRY_API_KEY;
      else process.env.SCRY_API_KEY = previous;
    }
    const restricted = { ...cfg, routing: { allowUnknownCost: false } };
    await assert.rejects(requestScry({ operation: "query", sql: "SELECT 1 LIMIT 1" }, restricted), /unknown-cost/);
    assert.equal(scryStatus(restricted).schemaAvailable, true);
    assert.equal(scryStatus(restricted).queryAvailable, false);
    await assert.rejects(requestScry({ operation: "query", sql: "  " }, cfg), /SQL/);
    await assert.rejects(requestScry({ operation: "schema", mode: "index", relation: "items" }, cfg), /not both/);
    assert.equal(calls, 0);
    const status = providerStatus(cfg, {}).find(p => p.id === "scry")!;
    assert.equal(status.eligible, false);
    assert.equal(status.reason, "dedicated SQL tools only");
    for (const hint of [{ costPerSearchUsd: 0 }, { freeCreditsRemaining: 1 }]) {
      await requestScry({ operation: "query", sql: "SELECT 1 LIMIT 1" }, { providers: { scry: { ...cfg.providers!.scry, ...hint } }, routing: { allowUnknownCost: false } });
    }
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test("Scry errors, streaming failures, malformed and oversized responses are secret-safe with no retry", async () => {
  const original = globalThis.fetch;
  try {
    for (const response of [
      () => new Response("private-secret", { status: 401 }),
      () => new Response(JSON.stringify({ error: { message: "private-secret" } })),
      () => new Response("private-secret"),
      () => new Response("[]"),
      () => new Response(JSON.stringify({ text: "private-secret".repeat(200000) })),
    ]) {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return response(); };
      await assert.rejects(requestScry({ operation: "query", sql: "SELECT 1 LIMIT 1" }, cfg), error => error instanceof Error && !error.message.includes("private-secret"));
      assert.equal(calls, 1);
    }
    globalThis.fetch = async () => { throw new Error("private-secret"); };
    await assert.rejects(requestScry({ operation: "schema" }, cfg), /request failed or timed out/);
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response("{}"); };
    await assert.rejects(requestScry({ operation: "context" }, cfg, controller.signal), { name: "AbortError" });
    assert.equal(calls, 0);
    const active = new AbortController();
    globalThis.fetch = async () => { active.abort(); throw new Error("private-secret"); };
    await assert.rejects(requestScry({ operation: "schema" }, cfg, active.signal), { name: "AbortError" });
    // The timeout also covers body consumption, including streaming whitespace.
    globalThis.fetch = async (_input, init) => new Response(new ReadableStream({
      start(stream) {
        stream.enqueue(new TextEncoder().encode(" \n"));
        init?.signal?.addEventListener("abort", () => stream.error(new Error("private-secret")), { once: true });
      },
    }));
    // Keep the test process alive: AbortSignal.timeout timers are unref'ed.
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      await assert.rejects(requestScry({ operation: "query", sql: "SELECT 1 LIMIT 1" }, { ...cfg, routing: { timeoutMs: 10 } }), /Scry returned an error/);
    } finally { clearTimeout(keepAlive); }
  } finally { globalThis.fetch = original; }
});
