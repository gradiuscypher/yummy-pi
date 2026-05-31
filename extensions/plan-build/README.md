# Plan/Build Mode Extension for pi

A multi-phase workflow for planning, reviewing, and executing code changes safely.

## Overview

Plan/Build mode adds a structured workflow to your pi sessions:

```
PLAN (read-only)  →  REVIEW (TUI)  →  BUILD (full tools)  →  SUMMARY
```

| Phase | Tools | What happens |
|-------|-------|-------------|
| **Plan** | `read`, `bash`, `grep`, `find`, `ls`, `questionnaire` | Model explores codebase, asks clarifying questions, creates numbered plan |
| **Review** | N/A (TUI) | Interactive inspection, editing, approval |
| **Build** | All tools + `questionnaire` | Model executes steps with progress tracking |
| **Summary** | N/A | Report of completed vs. remaining work |

## UI Indicators

When plan/build mode is active, you'll see a bold indicator next to the model name on the right side of the footer:

| Phase | Footer indicator |
|-------|-----------------|
| Plan | `[PLAN MODE ACTIVE] model-name (branch)` |
| Review | `[REVIEW] model-name (branch)` |
| Build | `[BUILD 2/5] model-name (branch)` |
| Summary | `[PLAN DONE 5/5] model-name (branch)` |

The step list widget uses full terminal width with proper word wrapping — no truncation.

If you have your own custom footer, the plan status chip still appears in the status bar.

## Installation

Copy `index.ts`, `types.ts`, `safety.ts`, `plan-parser.ts`, and `review-ui.ts` into:

```
.pi/extensions/plan-build/
```

The `questionnaire` tool extension must also be installed for the LLM to ask clarifying questions during planning:

```
.pi/extensions/questionnaire/index.ts
```

(See `../questionnaire/README.md` for details.)

## Quick Start

1. Enable plan mode:
   ```
   /plan-build
   ```
   or press `Ctrl+Alt+P`

2. Ask the model to plan:
   ```
   Add user authentication to this Express app
   ```
   The model will explore the codebase (read-only), possibly ask clarifying questions via the questionnaire tool, and create a numbered plan.

3. Review the plan in the interactive TUI:
   - Navigate with `↑/↓`
   - Toggle steps with `Space`
   - Edit steps with `Enter`
   - Remove steps with `Delete`
   - Reorder with `Ctrl+↑`/`Ctrl+↓`

4. Execute:
   - Press `Ctrl+E` to approve and start execution
   - The model will work through each step
   - Mark completion with `[DONE:n]` tags

5. Summary shows completed vs. remaining steps.

## Toggle Semantics

| Action | Behavior |
|--------|----------|
| `/plan-build` while in plan/review | Confirm → exits plan mode, **plan preserved** |
| `/plan-build` while in build | Confirm → aborts build, **plan discarded** |
| `Ctrl+Alt+P` while in plan/review | Instant exit, **plan preserved** (no confirm) |
| `Ctrl+Alt+P` while in build | Notification — use `/pb-abort` instead |
| `/pb-abort` | Always discards the plan |
| Resume session with `pi -c` | Restores plan state and phase correctly |

## Commands

| Command | Description |
|---------|-------------|
| `/plan-build` | Toggle plan/build mode on/off |
| `/pb-review` | Open the interactive plan review TUI |
| `/pb-status` | Show current plan progress |
| `/pb-execute` | Begin executing the plan |
| `/pb-abort` | Abort plan/build mode (discards plan) |

## Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+Alt+P` | Toggle plan/build mode (preserves plan) |
| `?` | Show help (in review TUI) |

## CLI Flag

Start directly in plan mode:

```bash
pi --plan-build "Add authentication to the app"
```

## Review TUI Controls

| Key | Action |
|-----|--------|
| `↑/↓` or `j/k` | Navigate steps |
| `Space` | Toggle step enabled/disabled |
| `Enter` | Edit selected step |
| `Delete` | Remove selected step |
| `Ctrl+↑/Ctrl+↓` | Reorder selected step |
| `Ctrl+A` | Enable all steps |
| `Ctrl+D` | Disable all steps |
| `Ctrl+E` | Approve & execute |
| `Ctrl+R` | Send back for refinement |
| `Ctrl+S` / `Escape` | Stay in plan mode |
| `Ctrl+Q` | Abort plan mode |

## Questionnaire Tool

During the plan phase, the LLM can ask you clarifying questions using the `questionnaire` tool. Multiple related questions are bundled into a tabbed dialog — navigate with `Tab`/`←→`, select options with `↑↓` + `Enter`, and submit all answers at once. This works like Claude Code's follow-up question interface.

The questionnaire extension is a standalone extension at `.pi/extensions/questionnaire/`. It works everywhere, not just in plan mode.

## Bash Safety (Plan Phase)

During the plan phase, bash commands are restricted to a read-only allowlist:

**Allowed (examples):**
- File viewing: `cat`, `head`, `tail`, `less`
- Search: `grep`, `rg`, `find`, `fd`
- Directory: `ls`, `pwd`, `tree`
- Git read: `git status`, `git log`, `git diff`
- Package info: `npm list`, `pip list`
- System info: `uname`, `ps`, `free`

**Blocked:**
- File modification: `rm`, `mv`, `cp`, `mkdir`, `touch`
- Git write: `git add`, `git commit`, `git push`
- Package install: `npm install`, `pip install`
- Privileged: `sudo`, `kill`, `reboot`
- Editors: `vim`, `nano`, `code`

## Plan Format

The model should create a plan with a "Plan:" header and numbered steps:

```
Plan:
1. Create auth middleware in src/middleware/auth.ts
2. Add login route to src/routes/auth.ts
3. Create User model with password hashing
4. Add session management with JWT tokens
5. Write tests for authentication flow
```

The parser also supports checkboxes (`- [ ] Step text`) and various numbering styles (`1)`, `1 -`, `1:`).

## Custom Footer

Plan/build mode installs a custom footer showing:
- Left: token stats (`↑in ↓out $cost`)
- Right: `[PLAN MODE ACTIVE] model-name (git-branch)`

This replaces the default footer. If you use another extension that also sets a custom footer, the last one to call `setFooter()` wins. To disable the plan/build footer while keeping the extension, comment out the `installFooter` call in `setPhase`.

## State Persistence

Plan/build state is saved in session entries. This means:
- Plan survives session resume (`/resume` or `pi -c`)
- Tree navigation (`/tree`) restores correct state
- Branching creates correct copies of plan state

## Configuration

Edit the safety patterns or behavior in `safety.ts` or extend via the extension system. See [pi extensions documentation](https://pi.dev/docs/extensions) for details.
