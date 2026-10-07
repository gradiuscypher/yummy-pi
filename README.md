# yummy-pi

My [pi.dev](https://pi.dev) setup. Most of what used to live here was replaced
by community packages; the one extension that has no equivalent is kept.

## Local extension

### [tmux-pane](extensions/tmux-pane/)

Lets Pi drive an existing tmux pane (for example an SSH session): send
keystrokes, capture output, run commands. Gated behind `/tmux-on`.

No community package covers this: `@ogulcancelik/pi-tmux` only manages panes it
creates itself, and `@getpipher/term` targets QA harnesses.

### [provider-usage](extensions/provider-usage/)

Footer status that follows the active model's provider. Session spend always;
plus remaining OpenRouter credits (account balance, and the key's cap if it has
one), or the ChatGPT subscription's 5-hour and weekly usage for `openai` and
`openai-codex` models. Other providers show session spend only.

The subscription numbers are read with Pi's Codex login (`/login`, Codex),
because the usage endpoint rejects the "Sign in with ChatGPT" token used by the
`openai` provider. Models can stay on `openai`; the Codex login is only used
for that one read-only call. Without it the footer shows session spend only, so
the second login is optional per host. Add a provider by adding a `SOURCES`
entry and mapping provider ids to it in `SOURCE_FOR_PROVIDER`.

## Community packages

Pi packages can't depend on other pi packages, so these are installed
separately into your Pi settings:

```bash
pi install npm:@narumitw/pi-plan-mode               # /plan, read-only planning
pi install npm:@juicesharp/rpiv-ask-user-question   # structured questions for the model
pi install npm:@tmustier/pi-usage-extension         # token and cost dashboard
```

How they were chosen: downloads, publish recency, and a static scan of each
tarball (no install scripts; narrow use of exec, network and file access).
Runners-up: `@plannotator/pi-extension` (browser plan review),
`@mrclrchtr/supi-ask-user`, `pi-local-stats`.

## Install this repo

```bash
pi install git:github.com/gradiuscypher/yummy-pi
```

## License

MIT
