# spend-tracker — Pi extension for model spend & token stats

Tracks model cost and token usage across all providers and models. Persists historical data across sessions.

## Commands

| Command | Effect |
|---|---|
| `/stats` | Current session stats + all-time summary |
| `/stats all` | All-time stats across every session |
| `/stats models` | Per-model cost, token breakdown, and request count |
| `/stats sessions` | Per-session cost, token breakdown, and date |
| `/stats reset` | Wipe all tracking data (with confirmation) |

**Legacy alias:** `/spend`

## Status bar

Shows current-session cost + input/output token counts, e.g.:

```
📊 $0.042  ↑12.3K ↓4.5K
```

## Data location

All data lives at `~/.pi/agent/spend/spend.json`. The extension is safe to move or copy — the data path is anchored to your home directory, not the extension's location.
