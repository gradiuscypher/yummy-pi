# yummy-pi

A [pi.dev](https://pi.dev) extension pack with structured workflows and interactive tools.

## Extensions

### [plan-build](extensions/plan-build/)

A multi-phase workflow for planning, reviewing, and executing code changes safely.

```
PLAN (read-only)  →  REVIEW (TUI)  →  BUILD (full tools)  →  SUMMARY
```

The model explores your codebase in read-only mode, creates a numbered plan, you review it in an interactive TUI, then the model executes each step with progress tracking.

**Commands:** `/plan-build`, `/pb-review`, `/pb-status`, `/pb-execute`, `/pb-abort`

**Shortcut:** `Ctrl+Alt+P`

### [questionnaire](extensions/questionnaire/)

Allows the LLM to ask clarifying questions through an interactive tab-based dialog — similar to Claude Code's follow-up question interface. Works everywhere, not just in plan mode.

### [spend-tracker](extensions/spend-tracker/)

Tracks model cost and token usage across all providers and models. Persists historical data to `~/.pi/agent/spend/spend.json` (safe to relocate — data path is independent of code location).

**Commands:** `/stats`, `/stats all`, `/stats models`, `/stats sessions`, `/stats reset`

**Legacy alias:** `/spend`

**Status bar:** Shows current-session cost + input/output token counts.

### [tmux-pane](extensions/tmux-pane/)

Lets Pi interact with other tmux panes — send keystrokes, capture output, run commands. Useful for driving SSH sessions or other terminal-based tools. Safety-gated: must run `/tmux-on` to activate.

**Commands:** `/tmux-on [target]`, `/tmux-off`, `/tmux-target <pane>`, `/tmux-status`, `/tmux-config`

**Tools:** `tmux_run`, `tmux_send`, `tmux_send_keys`, `tmux_capture`, `tmux_list_panes`

### [dev-guide](extensions/dev-guide/)

Injects extension development context into the system prompt so the agent always knows where extensions live and how to build new ones. Automatically resolves the repo root from its own install location — works regardless of where the repo is cloned.

## Install

```bash
pi install git:github.com/yourusername/yummy-pi
```

Or pin to a specific version:

```bash
pi install git:github.com/yourusername/yummy-pi@v1.0.0
```

## Update

```bash
pi update git:github.com/yourusername/yummy-pi
```

## Uninstall

```bash
pi remove git:github.com/yourusername/yummy-pi
```

## Per-Project Install

To share with a team, install to project settings (creates `.pi/settings.json`):

```bash
pi install -l git:github.com/yourusername/yummy-pi
```

Teammates get the extensions automatically on startup.

## License

MIT
