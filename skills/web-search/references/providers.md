# Search providers: setup and routing notes

Provider availability and cost change. The router must use configured per-account limits/rates as the source of truth; do not hard-code a claim that a provider is currently cheapest or free. A configured `free_credits_remaining` value is an operator-maintained hint unless fetched from a provider's authenticated usage API. Unknown means unknown, not zero or unlimited.

| Provider | API/docs | Adapter considerations |
|---|---|---|
| Exa | [Search docs](https://exa.ai/docs) | Search and content retrieval; strong semantic/research-oriented use cases. |
| Tavily | [Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search) | Search depth and returned content can affect credits/cost. |
| Scry | [HTTP API](https://scry.io/docs/sql-over-https) | Dedicated corpus SQL tools, not web-search routing: public context, bearer-authenticated schema and text/plain SQL query at `https://api.scry.io/v1/scry/`. Requires `scry` + `read` key scopes; pricing/balance remain operator-maintained hints. |
| Kagi Search | [API reference](https://kagi.com/api/docs/openapi) | Search API key and API billing are distinct from any consumer subscription; verify endpoint/auth configuration. |
| Ceramic | [Search quickstart](https://docs.ceramic.ai/api/search/quickstart) | `POST https://api.ceramic.ai/search`, bearer key; docs currently describe 1,000 signup credits, which should not be assumed to remain on an account. |
| Linkup | [Introduction](https://docs.linkup.so/pages/documentation/get-started/introduction) | Several endpoints/modes (Search, Fetch, Research); select based on task and check current tier pricing. |
| OpenAI | [Web search tool](https://platform.openai.com/docs/guides/tools-web-search) | OpenAI Responses API web-search tool; model/tool availability and billing differ from the ordinary ChatGPT plan. |
| OpenRouter | [Web search docs](https://openrouter.ai/docs/features/web-search) | Web search is model/provider-dependent and may have an additional search cost; inspect the chosen model's pricing/capabilities. |

## Cost/credit policy

At each tool call, consider only enabled providers with a usable credential. Choose in this order:

1. Explicit user/provider pin (if enabled and credentialed).
2. Providers with known, positive remaining free credits that support the requested task; cheapest adequate option first.
3. Other providers ordered by configured estimated marginal cost, then manual weight. The current implementation does not score task suitability or relevance.
4. If cost/credits are unknown, label them unknown and avoid claiming free. `allowUnknownCost: false` excludes them unless configured positive free credits are present. Zero free credits does not itself mean a provider is unavailable; known-cost paid use remains eligible.
5. Try at most `routing.maxAttempts` providers sequentially (default 2), falling back only on errors or empty URL results. Explicit provider pins never fall back. For irrelevant results, change the query or explicitly choose another provider. The current config has no automatic spending/deep-mode approval mechanism; ask before using an unusually costly mode.

Manual weights are non-negative routing preferences applied only after credit/cost ordering, never as a substitute for credentials or availability. `enabled: false` hard-disables a provider. Scry is excluded from web-search eligibility because its documented API uses corpus SQL; use `scry_context`, `scry_schema`, and `scry_query` explicitly. Keep provider implementation behind the common adapter interface so adding a backend does not require changing routing policy.

## Discovery versus retrieval

Search adapters normalize URL-bearing results. OpenAI/OpenRouter adapters extract citations and label generated answers as discovery-only rather than returning raw provider JSON. No adapter automatically verifies relevance, prices or claims. Most adapter API contracts remain initial implementations; unit fixtures are not live API compatibility tests.

`web_fetch` and `web_sitemap` use bounded public HTTP(S) retrieval independently of search credentials. They do not invoke paid provider content APIs. Use `web_search_status` or `/web-search-status` for eligibility and tool registration diagnostics; it does not validate credentials against providers. `web_search_usage` checks only the verified OpenRouter credits endpoint; other balances remain unknown.
