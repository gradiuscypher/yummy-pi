# yummy-pi

My [pi.dev](https://pi.dev) setup. Most of what used to live here was replaced
by community packages; the one extension that has no equivalent is kept.

## Local extension

### [tmux-pane](extensions/tmux-pane/)

Lets Pi drive an existing tmux pane (for example an SSH session): send
keystrokes, capture output, run commands. Gated behind `/tmux-on`.

No community package covers this: `@ogulcancelik/pi-tmux` only manages panes it
creates itself, and `@getpipher/term` targets QA harnesses.

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
