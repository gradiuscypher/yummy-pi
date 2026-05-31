# Questionnaire Tool Extension

Allows the LLM to ask the user clarifying questions through an interactive tab-based dialog — similar to Claude Code's follow-up question interface.

## How It Works

The LLM calls the `questionnaire` tool with an array of questions, each having options the user can select from. Multiple questions are shown in a tab bar; the user navigates with `Tab`/`←→`, selects with `↑↓` + `Enter`, and submits all answers at once.

For single questions, a simpler option list is shown.

## Installation

Copy `index.ts` into `~/.pi/extensions/questionnaire/`:

```
~/.pi/extensions/questionnaire/index.ts
```

## Schema

```typescript
interface Question {
  id: string;           // Unique identifier (e.g., "scope", "priority")
  label?: string;       // Short tab-bar label (defaults to "Q1", "Q2", etc.)
  prompt: string;       // Full question text
  options: {
    value: string;      // Returned value when selected
    label: string;      // Display label
    description?: string; // Optional description below label
  }[];
  allowOther?: boolean; // Allow free-text "Type something" option (default: true)
}
```

## Keybindings

| Key | Action |
|-----|--------|
| `Tab` / `→` | Next question tab |
| `Shift+Tab` / `←` | Previous question tab |
| `↑` / `↓` | Navigate options |
| `Enter` | Select option / submit (on final tab) |
| `Escape` | Cancel questionnaire |

## Usage

No user commands needed. The LLM will call this tool automatically when it needs clarification. Bundle multiple related questions into a single call for the best experience.
