# tmux-pane — Pi extension for driving other tmux panes

Lets Pi send keystrokes to, capture output from, and run commands in other tmux panes — e.g. an SSH session on a remote host in the pane below.

**Pi will never touch tmux unless you explicitly arm it.** Use `/tmux-on` per session, or pass `--tmux-pane <target>` at launch.

## Setup

Install via the yummy-pi extension pack. Pi must run inside tmux (`$TMUX` set).

Pi itself needs extended keys to tell `Shift+Enter` from `Enter` inside tmux
(see Pi's `docs/tmux.md`). Add to `~/.tmux.conf`:

```tmux
set -g extended-keys on
# tmux 3.5+ only; this line is an error on 3.2–3.4:
set -g extended-keys-format csi-u
```

Tested with tmux 3.4 and Pi 1.0.4.

## Commands

| Command | Effect |
|---|---|
| `/tmux-on [target]` | Arm tmux access. If no target: auto-picks the only other pane in the window, otherwise shows picker. |
| `/tmux-off` | Disarm. Tools become unavailable. |
| `/tmux-target <tgt>` | Change target pane (e.g. `%12`, `mysess:1.1`). |
| `/tmux-status` | Show current armed state, target, and limits. |
| `/tmux-config maxBytes 32768` | Set session capture byte limit (default 8192). |
| `/tmux-config maxLines 2000` | Set session line limit (default 500). |

CLI flag: `pi --tmux-pane %12` pre-arms at launch.

Armed state is per run: it survives `/reload` but not resuming or forking a
session (pane IDs can be stale or reused), so re-run `/tmux-on` after `pi -r`.
Capture limits are restored.

## Tools (only when armed)

| Tool | Purpose |
|---|---|
| `tmux_run` | **Primary tool.** Send a command, wait for output, return captured result. |
| `tmux_send` | Type literal text (default: appends Enter). |
| `tmux_send_keys` | Send control keys: `C-c`, `Escape`, `Up`, etc. |
| `tmux_capture` | Read pane content (visible or scrollback). |
| `tmux_list_panes` | Enumerate all panes. |

## Safety

- **Cannot target Pi's own pane** — hard refusal, even when armed.
- Tools are deactivated until you run `/tmux-on`.
- A `tool_call` interceptor double-checks — blocked tools return a clear error.
- The LLM has no knowledge of tmux tools in its system prompt unless armed.

## Typical workflow

```
$ pi

(You) /tmux-on
(auto-picks the other pane in the window)

(You) Check disk usage of the remote host
→ Pi calls tmux_run "df -h", captures output, summarizes.

(You) /tmux-off
→ Disarmed. Pi no longer touches tmux.
```

## Tuning output size

Default capture is 8 KB / 500 lines. If output truncates:

- Per-call: ask Pi to use `maxBytes`/`maxLines` on `tmux_run` or `tmux_capture`.
- Per-session: `/tmux-config maxBytes 65536` / `/tmux-config maxLines 5000`.
