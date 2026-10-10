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

## Personal UI colors

[`config/brighter-secondary-text.ts`](config/brighter-secondary-text.ts) is an opt-in customization for Pi's `system` theme:

- Brighter footer/status notices and thinking text.
- Slightly lighter blue user-message backgrounds.
- Dark steely-teal completed tool blocks (`#004B4B` when Pi selects 256-color mode).

It leaves normal message text, green text/accents, pending/error blocks, and general muted text unchanged. It temporarily wraps Pi's theme rendering methods and restores them on shutdown/reload. It selects `system` when the session starts and only adjusts that theme.

```sh
mkdir -p ~/.pi/agent/extensions
cp config/brighter-secondary-text.ts ~/.pi/agent/extensions/brighter-secondary-text.ts
```

Run `/reload` to apply it. This file is intentionally outside the package's auto-loaded extensions to avoid loading it twice alongside the personal copy. The completed-block tint uses RGB escape sequences even when Pi selects 256-color mode: use an RGB-capable terminal path (including tmux). The local tmux client used to tune these colors advertises RGB support.

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
