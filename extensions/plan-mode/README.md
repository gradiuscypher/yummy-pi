# Plan Mode Extension for pi

A lightweight plan/implement toggle. Enter planning mode to explore and
design — exit to build.

## How it works

1. **Enter plan mode** (`Ctrl+Alt+P` or `/plan`)
   - A context prompt is injected into the conversation instructing the model: explore, plan, do not build
   - All tools stay active (prompt-only guardrails)
   - No model swapping — you use your current model

2. **Create a plan**
   - Ask the model to explore and write a numbered plan
   - The model can use the questionnaire tool to ask you clarifying questions

3. **Save the plan** (`Ctrl+Alt+S` or `/plan-save`)
   - Saves the last assistant message to `./plans/<timestamp>-<slug>.md`

4. **Exit plan mode** (`Ctrl+Alt+P` or `/plan`)
   - Simply stops prepending the planning guardrails
   - pi resumes normal operation with the same model and context

## Commands

| Command | Description |
|---------|-------------|
| `/plan` | Toggle plan mode on/off |
| `/plan-save` | Save current plan to `./plans/` |

## Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+Alt+P` | Toggle plan mode |
| `Ctrl+Alt+S` | Save plan to file |

## Plan files

Plan files are written to `./plans/<YYYY-MM-DD-HHmm>-<slug>.md` with a
metadata header. The slug is derived from the first heading or plan step.
If you save again during the same planning session, the same file is
overwritten.

## Installation

Copy into `.pi/extensions/plan-mode/`:

```
.pi/extensions/plan-mode/
├── index.ts
├── prompts.ts
└── README.md
```

The `questionnaire` extension is recommended but optional — it allows
the model to ask you clarifying questions during planning.
