# yummy-pi

My [pi.dev](https://pi.dev) setup.

## Local extension

### [tmux-pane](extensions/tmux-pane/)

Lets Pi drive an existing tmux pane when explicitly armed with `/tmux-on`.

### Web search

[`extensions/web-search/`](extensions/web-search/README.md) provides provider-routed search plus direct source retrieval and sitemap discovery. The companion [`web-search` skill](skills/web-search/SKILL.md) is included in the package, with [provider notes](skills/web-search/references/providers.md) and an [evidence ledger](skills/web-search/references/evidence.md).

- `web_search_status` and `/web-search-status`: tool registration/activation, safe provider eligibility, config diagnostics, and local efficiency counters—no network calls or exposed secrets.
- `web_search`: normalized source URLs and provider-attempt reporting; default at most two sequential attempts, with fallback only on errors or empty URL results.
- `web_fetch`: public page retrieval with final URL, HTTP/content status, readable article text and block warnings. No search key needed.
- `web_sitemap`: bounded official sitemap discovery when searches or guessed links fail. No search key needed.
- `web_search_usage`: verified read-only account endpoints where supported; other balances remain unknown.

If the command is missing, load/install the extension and `/reload`; a config file alone cannot register tools. For development, run `npm ci` then `pi -e ./extensions/web-search/index.ts`. This extension does not supply a background-agent tool or force inactive tools into the model's loadout.

Recommended per-user configuration: `~/.config/pi/web-search.json`. Copy [`config/search.example.json`](config/search.example.json) there, edit costs/credits/weights, and enter provider API keys in the `apiKey` fields if you want this file to be self-contained. Alternatively, set `apiKeyEnv` to an environment-variable name.

```sh
mkdir -p ~/.config/pi
cp config/search.example.json ~/.config/pi/web-search.json
chmod 600 ~/.config/pi/web-search.json
```

Override the path with `PI_WEB_SEARCH_CONFIG`. Keys stored in `apiKey` are secrets: keep this file owner-only (`chmod 600`), never commit it, and remember that copying it copies account credentials. Alternatively, `apiKeyEnv` names an environment variable (defaults are shown in the example). A provider is only eligible if implemented, enabled, credentialed, and permitted by cost policy. Set `enabled: false` to hard-disable it. `allowUnknownCost: false` excludes unknown-cost providers unless configured positive free credits are present. `maxAttempts` bounds sequential fallback (default 2); explicit provider pins never fall back. `freeCreditsRemaining` and `costPerSearchUsd` are manually maintained routing hints; usage checks query only verified read-only endpoints. `weight` nudges routing only after known credit/cost ordering; it never enables a disabled backend. `null` means unknown.

**Adapter status:** Exa, Tavily, Kagi, Ceramic, Linkup, OpenAI web search, and OpenRouter web-search-model requests have initial adapters. Scry has dedicated `scry_context`, `scry_schema`, and `scry_query` tools for its documented corpus SQL API; it is disabled in the example and excluded from automatic web-search routing. Review provider docs and test each API before relying on it; APIs and search modes evolve. Provider-specific free credits are not inferred from plan names. OpenAI and OpenRouter search billing is separate from ordinary chat-plan assumptions.

Research workflow: `/skill:web-search`. Snippets and generated search answers are discovery aids, not verified evidence. The skill separates published offers, starting prices, market estimates, quote-only services and planning assumptions, and stops when remaining unknowns require scoped quotes rather than more browsing.

Direct retrieval rejects private/reserved destinations and unsafe redirects, detects common interstitials, and bounds downloads/output. It does not execute JavaScript, parse PDFs or bypass CAPTCHA. See the [extension README](extensions/web-search/README.md) for limits and diagnostic counter semantics.

Validation: `npm test` and `npm run typecheck` (search extension and tests).

## UI colors

[`extensions/ui-colors/`](extensions/ui-colors/index.ts) loads automatically with yummy-pi in interactive sessions and selects Pi's terminal-adaptive `system` theme with our color adjustments:

- Brighter footer/status notices and thinking text.
- Slightly lighter blue user-message backgrounds.
- Dark steely-teal completed tool blocks (`#004B4B` when Pi selects 256-color mode).

It leaves normal message text, green text/accents, pending/error blocks, and general muted text unchanged. It temporarily wraps Pi's theme rendering methods and restores them on shutdown/reload. It selects `system` when the session starts and only adjusts that theme; choosing another theme through `/settings` leaves that theme unchanged. Print, JSON, and RPC sessions are unaffected.

No separate theme installation or personal extension copy is needed. For an existing installation, update the package and reload:

```sh
pi update git:github.com/gradiuscypher/yummy-pi
```

Then run `/reload`. If you previously copied `config/brighter-secondary-text.ts` to `~/.pi/agent/extensions/brighter-secondary-text.ts`, remove that old personal copy after updating the package so the bundled extension is the only source. New copies share a single rendering patch and safely release it when the last copy shuts down.

The completed-block tint uses RGB escape sequences even when Pi selects 256-color mode: use an RGB-capable terminal path (including tmux). The local tmux client used to tune these colors advertises RGB support. To opt out, disable `extensions/ui-colors/index.ts` in `pi config`.

## omp: OpenRouter balance footer

[`omp-extensions/openrouter-balance/index.ts`](omp-extensions/openrouter-balance/index.ts) is an omp-only extension. The package's separate `omp.extensions` manifest loads it without loading the Pi extensions; Pi continues using `pi.extensions`.

Try it from this checkout:

```sh
omp -e ./omp-extensions/openrouter-balance/index.ts
```

Or link the package for future omp sessions:

```sh
omp plugin link .
```

Restart omp after linking. Select an OpenRouter model and run `/openrouter-balance` to force a refresh. With the default `statusLine.showHookStatus: true`, balances appear in the footer. For a custom status line that hides hook statuses, include `status` in `statusLine.leftSegments` or `statusLine.rightSegments`. The existing `usage` segment remains responsible for subscription quotas.

The display separates:

- **Account:** purchased credits minus account usage, from `GET /api/v1/credits`.
- **Key:** the active inference key's reported `limit_remaining`, from `GET /api/v1/key`. An explicitly uncapped key is labeled `uncapped`; this does not mean unlimited account credits or exemption from other budgets.

OpenRouter's [credits endpoint](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits) currently requires a management key. To enable the account figure, supply `OPENROUTER_MANAGEMENT_KEY` in the environment inherited by omp. It must belong to the same OpenRouter account as the inference key; the extension cannot independently verify that association. Treat this as a privileged secret: do not commit it, paste it into chat, or put it in a shell command that will be saved in history. This extension only sends it to the credits endpoint using GET, but the key itself may authorize management operations elsewhere. Without it, account credits are explicitly unavailable and the key allowance still works.

The inference key is resolved through omp's session-aware model registry, including its pinned/rotated account. No duplicated inference credential configuration is needed. Requests go only to OpenRouter's fixed HTTPS endpoints, reject redirects, and time out after five seconds. Errors never display response bodies or credential values. See the [current-key API](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key).

Balances refresh on startup and turn completion, or at most once per minute while idle. A managed five-second check detects model/credential changes; the footer is hidden outside the main interactive OpenRouter session. Cache state is cleared on credential/session changes and shutdown, and is never persisted. Each figure updates independently. Failed refreshes preserve the last successful value with `[stale]`; values at least two minutes old are also marked stale. The extension adds no model tools, makes no completion requests, and does not change provider configuration or subscription usage reporting.

Validation: `npm test` includes balance parsing, separate credential use, partial failures, secret-safe errors, and stale-state recovery. `npm run typecheck` includes the omp extension.

## Community packages

Pi packages can't depend on other pi packages, so these are installed separately into your Pi settings:

```bash
pi install npm:@narumitw/pi-plan-mode
pi install npm:@juicesharp/rpiv-ask-user-question
pi install npm:@tmustier/pi-usage-extension
```

## Install this repo

```bash
pi install git:github.com/gradiuscypher/yummy-pi
```

## License

MIT
