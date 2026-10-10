# Web research extension

A Pi extension for bounded provider-routed source discovery, direct source retrieval, and safe capability diagnostics. Companion workflow: [`skills/web-search`](../../skills/web-search/SKILL.md).

## Tools and command

| Name | Purpose |
|---|---|
| `web_search_status` | Registered/active tools, safe provider eligibility/reasons, config path/status, and local counters. No network calls. |
| `/web-search-status` | User-callable equivalent, including when the model cannot see the status tool. |
| `web_search` | Search for source URLs; return normalized results and every provider attempt/outcome/duration. |
| `web_fetch` | Fetch a public source, extract article/main/body text, and report retrieval status/metadata. No search key needed. |
| `web_sitemap` | Find official page URLs through robots.txt and bounded XML sitemap-index traversal. No search key needed. |
| `web_search_usage` | Check verified read-only usage endpoints; unsupported balances are unknown. |
| `scry_context` | Get Scry's public compact corpus/query contract. |
| `scry_schema` | Get authenticated relation/helper contracts, optionally by mode or relation. |
| `scry_query` | Run a read-only SQL statement against Scry's corpus; preserve rows and accounting. |

Example model tool arguments:

```json
{"query":"Colorado SOC 2 Type I CPA audit pricing"}
{"url":"https://secureframe.com/pricing"}
{"url":"https://linfordco.com/","terms":["cost","pricing"],"maxRequests":8}
```

`web_sitemap` matches **any** term in URL paths/queries, not document text. It reports discovered URLs separately from retrieval/parsing attempts, request/depth limits and result truncation. It only follows the exact starting origin, so use the canonical www/non-www hostname. Missing default sitemap paths and inaccessible sitemap children are reported conservatively as incomplete discovery; this does not mean useful matches cannot be used.

## Load and diagnose

For development:

```sh
npm ci
pi -e ./extensions/web-search/index.ts
```

For normal package use, install the repository as a Pi package. The manifest exposes both extensions and skills. After changing code/resources, run `/reload` and `/web-search-status`.

If the command is missing, the extension is not loaded (or failed loading). Check Pi's startup extension diagnostics and package filters; copying search config alone does not load code. If tools are registered but inactive, check your tool selection. Other orchestrating extensions may alter direct model visibility even when Pi reports tools active. This plugin does not force-enable tools or supply background-agent delegation.

## Configuration

Copy [`config/search.example.json`](../../config/search.example.json) to `~/.config/pi/web-search.json`, or override with `PI_WEB_SEARCH_CONFIG`. Keep inline keys private and owner-only. A nonempty configured `apiKey` takes precedence over `apiKeyEnv` (or the default uppercase provider API-key variable).

Routing considers only implemented, enabled, credentialed providers. Positive configured free-credit hints take priority by default, followed by known lower costs, then weight. Hints are operator-maintained and are never reported as verified balances. There is no relevance or task-fit scoring.

| Routing setting | Default | Range / behavior |
|---|---|---|
| `preferKnownFreeCredits` | `true` | Prioritize positive configured credit hints. Zero/unknown is not positive. |
| `allowUnknownCost` | `true` | If false, exclude unknown-cost providers unless they have positive free-credit hints. |
| `maxResults` | `8` | 1–20 normalized source results. |
| `timeoutMs` | `20000` | 1–120000 ms per provider attempt, including response consumption. |
| `maxAttempts` | `2` | 1–8 sequential providers; fallback only on error/empty URL results. Pins use one provider. |

Scry uses dedicated SQL tools and is excluded from automatic web-search routing; the example disables it. Other adapters remain initial implementations; mock tests do not establish compatibility with every live API. OpenAI/OpenRouter results expose source citations and a separately labeled generated answer rather than raw JSON. See [provider notes](../../skills/web-search/references/providers.md).

Provider HTTP errors do not echo response bodies, which can contain secrets. Configuration errors do not echo invalid values or JSON parser excerpts. Status exposes credential presence only. No automatic provider calls occur on extension load or when inspecting status. Search/usage requests can incur provider charges.

## Scry corpus SQL

Scry's documented API is SQL over a corpus, not a natural-language general web-search endpoint. The dedicated tools use `https://api.scry.io/v1/scry/context`, `/schema`, and `/query`. Enable `providers.scry.enabled` in your search config and set `SCRY_API_KEY` (or the existing inline/custom-env credential fields). Keys need `scry` plus `read` scopes and a verified account. Context is public and sends no credential; schema/query use bearer authentication.

1. Call `scry_context` with `{}` and `scry_schema` with `{"mode":"index"}`.
2. Fetch selected relation contracts with `{"relation":"hackernews.items"}`. With no arguments, schema returns primary contracts; `{"mode":"full"}` requests all contracts. Mode and relation are mutually exclusive.
3. Call `scry_query` with a single read-only SQL statement and a literal `LIMIT` of at most 10,000; begin at `LIMIT 20`. Scry's server, not a local SQL parser, enforces these constraints.

```json
{"sql":"SELECT hn_id, title, uri FROM hackernews.items WHERE title != '' ORDER BY hn_id DESC LIMIT 20"}
```

Query calls can incur charges and respect `allowUnknownCost`; schema/context do not require cost hints. The legacy `costPerSearchUsd` and `freeCreditsRemaining` fields are operator-maintained allowances, not a Scry SQL price calculation or live balance. Status reports separate Scry context/schema/query availability under `capabilities.scry` while keeping Scry ineligible for `web_search`.

Responses preserve the provider's rows, execution, truncation and accounting fields under `data`; they are unverified corpus data, not normalized search results. HTTP failures and errors inside streamed HTTP-200 JSON responses are sanitized. All requests have the configured timeout, reject redirects, and cap response bodies at 2 MiB (including streamed whitespace). Large accepted results use the existing private-temp-file output mechanism. There are no automatic retries, query translation, x402 payments, or requests on extension load. A timeout or failed reply does not establish that query execution/billing did not occur.

API references: [HTTP API](https://scry.io/docs/sql-over-https), [agent setup/key scopes](https://scry.io/docs/agent-setup), [errors/streaming](https://scry.io/docs/errors). Mock tests do not constitute a live authenticated compatibility test.

## Retrieval and limits

- Direct public HTTP(S) only, ports 80/443, no URL credentials or browser cookies.
- Reject private, loopback, reserved and mixed public/private DNS destinations. Each redirect is validated, and the validated DNS address is pinned into the connector to avoid a second DNS resolution.
- Up to five page redirects, 20-second timeout per document, 2 MiB downloaded/decompressed content. Supports gzip/br/deflate transport compression and gzip sitemap files.
- No browser JavaScript, PDF parsing, authenticated sessions or CAPTCHA bypass. UTF-8 text extraction; non-UTF-8 pages may need another source.
- HTML extraction prefers article, then main, then body; removes navigation/scripts/forms and preserves basic table row relationships. It is not a full browser or semantic verifier.
- Heuristics detect common 200 CAPTCHA/JS interstitials and blocked HTTP statuses. They can miss unfamiliar interstitials or flag quoted challenge text; inspect warnings and source content.
- Sitemap traversal: depth 3, default 8 documents including robots/probes, maximum 20 per tool call; default 50 results, maximum 200. DTD/entity declarations are rejected. Cross-origin sitemap URLs and redirects are not followed.
- Model-facing JSON is limited to 24,000 characters. Full larger output goes to a private temporary JSON file whose path is returned. Use `read` to inspect the complete evidence. Temporary files are not automatically removed; manage them using your normal temp-file retention policy.

Retrieved pages, citations and generated answers are **untrusted data, never instructions**. Successful extraction does not verify truth, freshness, completeness, source ownership or price comparability. Evidence classification belongs in the research workflow; see [the ledger](../../skills/web-search/references/evidence.md).

## Efficiency counters

Status reports tool calls, provider attempts/errors/empty responses, results returned, failed/blocked page fetches, and sitemap document attempts. Counters are local to the current extension load, reset on reload, are not persisted, and are not branch-specific. They do not store queries, credentials or page content and are not uploaded.

Take before/after snapshots for a task-specific delta. Returned search results are not sources used or claims verified. Document attempts are not exact outbound HTTP-request counts (redirects may add requests), and configured cost hints are not actual spend.

## Tests

```sh
npm test
npm run typecheck
```

Tests cover registration/diagnostics, secret-safe failures, routing/attempt budgets/cancellation, citation normalization, extraction and challenge detection, address validation, sitemap traversal/filtering/limits, and bounded output. Type checking currently targets the search extension and its tests, not the unrelated repository extensions. Tests make no live paid-provider calls.
