import { eligible, keyFor, rank, type Config, type Provider } from "./config.ts";

export type SearchResult = { title: string; url: string; snippet: string };
export type SearchResponse = { results: SearchResult[]; answer?: string };
export type Attempt = { provider: Provider; outcome: "success" | "empty" | "error"; durationMs: number; resultCount?: number; error?: string };
export type SearchReport = SearchResponse & { provider?: Provider; attempts: Attempt[]; status: "success" | "empty" | "failed"; evidenceKind: "discovery-only" };

export function publicUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return;
    url.hash = "";
    return url.href;
  } catch { return; }
}
function normalize(rows: unknown): SearchResult[] {
  if (!Array.isArray(rows)) return [];
  const seen = new Set<string>();
  return rows.flatMap(row => {
    const url = publicUrl(row?.url);
    if (!url || seen.has(url)) return [];
    seen.add(url);
    return [{ title: String(row.title ?? "").slice(0, 500), url, snippet: String(row.snippet ?? "").slice(0, 2400) }];
  });
}
export function normalizeResponse(id: Provider, json: any): SearchResponse {
  let rows: unknown = [];
  let answer: string | undefined;
  if (id === "exa") rows = json.results?.map((x: any) => ({ ...x, snippet: x.text }));
  if (id === "tavily") rows = json.results?.map((x: any) => ({ ...x, snippet: x.content }));
  if (id === "kagi") rows = json.data?.filter((x: any) => x.url);
  if (id === "ceramic") rows = (json.result?.results ?? json.results)?.map((x: any) => ({ ...x, snippet: x.description }));
  if (id === "linkup") rows = json.results?.map((x: any) => ({ ...x, title: x.name ?? x.title, snippet: x.content ?? x.snippet }));
  if (id === "openai") {
    const texts = (json.output ?? []).flatMap((x: any) => x.content ?? []).filter((x: any) => x.type === "output_text");
    answer = texts.map((x: any) => x.text).join("\n").slice(0, 12000);
    rows = texts.flatMap((x: any) => (x.annotations ?? []).filter((a: any) => a.type === "url_citation").map((a: any) => ({ title: a.title, url: a.url, snippet: "Citation from a generated answer; fetch the source before relying on it." })));
  }
  if (id === "openrouter") {
    const message = json.choices?.[0]?.message;
    answer = typeof message?.content === "string" ? message.content.slice(0, 12000) : undefined;
    rows = [
      ...(message?.annotations ?? []).filter((a: any) => a.type === "url_citation").map((a: any) => ({ title: a.url_citation?.title, url: a.url_citation?.url, snippet: a.url_citation?.content })),
      ...(json.citations ?? []).map((url: string) => ({ url, title: "Cited source", snippet: "Citation from a generated answer; fetch before relying on it." })),
    ];
  }
  return { results: normalize(rows), ...(answer ? { answer } : {}) };
}
export async function searchProvider(id: Provider, query: string, key: string, cfg: Config, signal?: AbortSignal): Promise<SearchResponse> {
  const combined = AbortSignal.any([AbortSignal.timeout(cfg.routing?.timeoutMs ?? 20000), ...(signal ? [signal] : [])]);
  let url: string, headers: Record<string, string>, body: unknown;
  switch (id) {
    case "exa": url = "https://api.exa.ai/search"; headers = { "x-api-key": key }; body = { query, type: "auto", numResults: cfg.routing?.maxResults ?? 8, contents: { text: { maxCharacters: 1200 } } }; break;
    case "tavily": url = "https://api.tavily.com/search"; headers = {}; body = { api_key: key, query, max_results: cfg.routing?.maxResults ?? 8, include_answer: false }; break;
    case "ceramic": url = "https://api.ceramic.ai/search"; headers = { authorization: `Bearer ${key}` }; body = { query }; break;
    case "linkup": url = "https://api.linkup.so/v1/search"; headers = { authorization: `Bearer ${key}` }; body = { query, depth: "standard", outputType: "searchResults" }; break;
    case "kagi": url = "https://kagi.com/api/v0/search"; headers = { authorization: `Bot ${key}` }; body = undefined; break;
    case "scry": throw new Error("Scry adapter is not implemented.");
    case "openai": url = "https://api.openai.com/v1/responses"; headers = { authorization: `Bearer ${key}` }; body = { model: cfg.providers?.openai?.model ?? "gpt-4.1-mini", tools: [{ type: "web_search_preview" }], input: query }; break;
    case "openrouter": url = "https://openrouter.ai/api/v1/chat/completions"; headers = { authorization: `Bearer ${key}` }; body = { model: cfg.providers?.openrouter?.model ?? "perplexity/sonar", messages: [{ role: "user", content: query }] }; break;
  }
  const endpoint = new URL(url);
  if (id === "kagi") endpoint.searchParams.set("q", query);
  let response: Response;
  try {
    response = await fetch(endpoint, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: combined });
  } catch {
    signal?.throwIfAborted();
    throw new Error("Provider network request failed or timed out.");
  }
  // Provider error bodies may echo auth headers or request bodies. Never expose them.
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Provider HTTP ${response.status}`); }
  try {
    return normalizeResponse(id, await response.json());
  } catch {
    signal?.throwIfAborted();
    throw new Error("Provider returned an unreadable or unsupported response.");
  }
}
export type SearchAdapter = typeof searchProvider;
export async function runSearch(query: string, cfg: Config, signal?: AbortSignal, requested?: string, adapter: SearchAdapter = searchProvider): Promise<SearchReport> {
  if (!query.trim()) throw new Error("Search query must not be empty.");
  signal?.throwIfAborted();
  const available = eligible(cfg);
  if (requested && !available.includes(requested as Provider)) throw new Error("Requested provider is not eligible. Run web_search_status for reasons.");
  if (!available.length) throw new Error("No eligible search provider. Run web_search_status or /web-search-status; see config/search.example.json.");
  const order = requested ? [requested as Provider] : rank(available, cfg).slice(0, cfg.routing?.maxAttempts ?? 2);
  const attempts: Attempt[] = [];
  for (const id of order) {
    const start = Date.now();
    try {
      const response = await adapter(id, query.trim(), keyFor(id, cfg)!, cfg, signal);
      signal?.throwIfAborted();
      const results = response.results.slice(0, cfg.routing?.maxResults ?? 8);
      attempts.push({ provider: id, outcome: results.length ? "success" : "empty", resultCount: results.length, durationMs: Date.now() - start });
      if (results.length) return { ...response, results, provider: id, attempts, status: "success", evidenceKind: "discovery-only" };
      if (requested || id === order.at(-1)) return { ...response, results, provider: id, attempts, status: "empty", evidenceKind: "discovery-only" };
    } catch (error) {
      signal?.throwIfAborted();
      // Only our controlled adapter error vocabulary is safe to publish.
      const message = error instanceof Error && /^(Provider HTTP \d+|Provider network request failed or timed out\.|Provider returned an unreadable or unsupported response\.)$/.test(error.message) ? error.message : "Provider search failed.";
      attempts.push({ provider: id, outcome: "error", durationMs: Date.now() - start, error: message });
    }
  }
  return { results: [], attempts, status: "failed", evidenceKind: "discovery-only" };
}
