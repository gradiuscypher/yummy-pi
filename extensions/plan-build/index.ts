/**
 * Plan/Build Mode Extension for pi
 *
 * A multi-phase workflow for planning, reviewing, and executing code changes.
 * Plan mode uses a context prompt to nudge the model toward exploration and
 * planning only — no tool restrictions.
 *
 * Phases:
 *   1. PLAN   — Model explores and creates a numbered plan.
 *   2. REVIEW — Interactive TUI to inspect, edit, and approve plan steps.
 *   3. BUILD  — Model executes steps with progress tracking.
 *   4. SUMMARY — Report what was done vs. remaining.
 *
 * Usage:
 *   /plan-build     — Toggle plan mode
 *   /pb-review      — Review current plan
 *   /pb-status      — Show plan progress
 *   /pb-execute     — Begin executing the plan
 *   /pb-abort       — Abort plan/build mode (discards plan)
 *   Ctrl+Alt+P      — Toggle plan mode (shortcut, preserves plan)
 *   --plan-build    — Start in plan mode (CLI flag)
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, visibleWidth, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Phase, PersistedState, PlanStep } from "./types.ts";
import { extractPlanSteps, markCompletedSteps, formatSteps, getProgressSummary } from "./plan-parser.ts";
import { PlanReviewUI } from "./review-ui.ts";
import type { ReviewResult } from "./review-ui.ts";

// ── Type guards ─────────────────────────────────────────────────────────

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

// ── Custom entry types for persistence ─────────────────────────────────

const CUSTOM_TYPE_STATE = "plan-build-state";

// ── Extension ───────────────────────────────────────────────────────────

export default function planBuildExtension(pi: ExtensionAPI): void {
	// ── State ──────────────────────────────────────────────────────────
	let phase: Phase = "idle";
	let steps: PlanStep[] = [];
	let rawPlanText = "";
	let footerInstalled = false;
	const pendingReviews = new Set<string>(); // Re-entrancy guard for review UI

	// ── Widget caching ─────────────────────────────────────────────────
	let widgetRevision = 0;

	// ── CLI flag ───────────────────────────────────────────────────────
	pi.registerFlag("plan-build", {
		description: "Start in plan mode (read-only exploration with plan/build workflow)",
		type: "boolean",
		default: false,
	});

	// ══════════════════════════════════════════════════════════════════════
	// HELPERS
	// ══════════════════════════════════════════════════════════════════════

	function persistState(): void {
		const data: PersistedState = {
			phase,
			steps,
			createdAt: Date.now(),
			rawPlan: rawPlanText,
		};
		pi.appendEntry(CUSTOM_TYPE_STATE, data);
	}

	function uninstallFooter(ctx: ExtensionContext): void {
		if (!footerInstalled) return;
		ctx.ui.setFooter(undefined);
		footerInstalled = false;
	}

	function installFooter(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;

		// Re-install every time so phase/steps closures are fresh.
		// The old footer is automatically disposed.
		if (footerInstalled) {
			ctx.ui.setFooter(undefined);
		}

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsubBranch,
				invalidate() {},
				render(width: number): string[] {
					// ── Left side: token stats ──────────────────────────────
					let input = 0;
					let output = 0;
					let cost = 0;
					for (const e of ctx.sessionManager.getBranch()) {
						if (e.type === "message" && "message" in e && isAssistantMessage(e.message as AgentMessage)) {
							const m = e.message as AssistantMessage;
							input += m.usage.input;
							output += m.usage.output;
							cost += m.usage.cost.total;
						}
					}

					const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
					const left = theme.fg("dim", `↑${fmt(input)} ↓${fmt(output)} $${cost.toFixed(3)}`);

					// ── Centre: extension statuses (skip plan-build's own) ─
					const statuses = footerData.getExtensionStatuses();
					const extStatusParts: string[] = [];
					for (const [key, text] of statuses) {
						if (key !== "plan-build" && text.length > 0) {
							extStatusParts.push(text);
						}
					}
					const centre = extStatusParts.length > 0 ? extStatusParts.join("  ") : "";

					// ── Right side: mode indicator + model + branch ───────
					let indicator = "";
					switch (phase) {
						case "plan":
							indicator = theme.fg("warning", theme.bold("[PLAN MODE ACTIVE] "));
							break;
						case "review":
							indicator = theme.fg("warning", theme.bold("[REVIEW] "));
							break;
						case "build": {
							const done = steps.filter((s) => s.completed).length;
							const total = steps.length;
							indicator = theme.fg("accent", theme.bold(`[BUILD ${done}/${total}] `));
							break;
						}
						case "summary": {
							const done = steps.filter((s) => s.completed).length;
							const total = steps.length;
							indicator = theme.fg("success", theme.bold(`[PLAN DONE ${done}/${total}] `));
							break;
						}
					}

					const branch = footerData.getGitBranch();
					const branchStr = branch ? ` (${branch})` : "";
					const right = indicator + theme.fg("dim", `${ctx.model?.id || "no-model"}${branchStr}`);

					// Assemble: left · centre · right with padding between sections
					const leftVis = visibleWidth(left);
					const centreVis = centre ? visibleWidth(centre) + 3 : 0; // 3 = " · " separator
					const rightVis = visibleWidth(right);
					const totalVis = leftVis + centreVis + rightVis;

					if (totalVis <= width) {
						// Everything fits: distribute remaining space around centre
						const remaining = width - totalVis;
						const leftPad = " ".repeat(Math.floor(remaining / 2));
						const rightPad = " ".repeat(Math.ceil(remaining / 2));
						if (centre) {
							return [truncateToWidth(left + leftPad + theme.fg("dim", " · ") + centre + rightPad + right, width)];
						}
						return [truncateToWidth(left + leftPad + rightPad + right, width)];
					}

					// Doesn't all fit: place centre between left and right, let truncation handle overflow
					if (centre) {
						return [truncateToWidth(left + " " + centre + " " + right, width)];
					}
					return [truncateToWidth(left + " " + right, width)];
				},
			};
		});

		footerInstalled = true;
	}

	function updateUI(ctx: ExtensionContext): void {
		// ── Footer status chip (shown by default footer, or if user has a
		//     custom footer that reads getExtensionStatuses) ──────────────
		switch (phase) {
			case "idle":
				ctx.ui.setStatus("plan-build", undefined);
				break;
			case "plan":
				ctx.ui.setStatus(
					"plan-build",
					ctx.ui.theme.fg("warning", ctx.ui.theme.bold("[PLAN MODE ACTIVE]")),
				);
				break;
			case "review":
				ctx.ui.setStatus(
					"plan-build",
					ctx.ui.theme.fg("warning", ctx.ui.theme.bold("[REVIEW]")),
				);
				break;
			case "build": {
				const completed = steps.filter((s) => s.completed).length;
				const total = steps.length;
				ctx.ui.setStatus(
					"plan-build",
					ctx.ui.theme.fg("accent", ctx.ui.theme.bold(`[BUILD ${completed}/${total}]`)),
				);
				break;
			}
			case "summary": {
				const completed = steps.filter((s) => s.completed).length;
				const total = steps.length;
				ctx.ui.setStatus(
					"plan-build",
					ctx.ui.theme.fg("success", ctx.ui.theme.bold(`[PLAN DONE ${completed}/${total}]`)),
				);
				break;
			}
		}

		// ── Widget (step list) — using renderer function for full-width
		//     wrapping instead of the truncated string-array form ────────
		if ((phase === "build" || phase === "summary") && steps.length > 0) {
			widgetRevision++;
			const rev = widgetRevision;

			ctx.ui.setWidget("plan-build-steps", (_tui, theme) => {
				let cachedWidth = -1;
				let cachedRev = -1;
				let cachedLines: string[] | undefined;

				return {
					invalidate() {},
					render(width: number): string[] {
						if (cachedLines && cachedWidth === width && cachedRev === rev) {
							return cachedLines;
						}

						const lines: string[] = [];
						const nextIndex = steps.findIndex((s) => !s.completed && s.enabled);

						for (const step of steps) {
							const isNext = nextIndex === step.index - 1;

							// ── Icon ────────────────────────────────────────
							let icon: string;
							if (step.completed) {
								icon = theme.fg("success", "☑ ");
							} else if (!step.enabled) {
								icon = theme.fg("dim", "✕ ");
							} else {
								icon = theme.fg(isNext ? "accent" : "muted", "☐ ");
							}

							// ── Number ──────────────────────────────────────
							const num = theme.fg("muted", `${step.index}.`.padEnd(4));

							// ── Text ────────────────────────────────────────
							let styledText: string;
							if (step.completed) {
								styledText = theme.fg(
									"success",
									theme.strikethrough(step.text),
								);
							} else if (!step.enabled) {
								styledText = theme.fg(
									"dim",
									theme.strikethrough(step.text),
								);
							} else {
								styledText = theme.fg(
									isNext ? "text" : "muted",
									step.text,
								);
							}

							// ── Assemble prefix and compute layout ────────
							// icon (2 visible chars) + space + num (4) = 7
							const prefix = `${icon}${num}`;
							const prefixVis = 7;
							const pad = " ".repeat(prefixVis);

							const textWidth = Math.max(10, width - prefixVis);
							const wrapped = wrapTextWithAnsi(styledText, textWidth);

							if (wrapped.length > 0) {
								lines.push(truncateToWidth(prefix + wrapped[0], width));
								for (let i = 1; i < wrapped.length; i++) {
									lines.push(truncateToWidth(pad + wrapped[i], width));
								}
							}
						}

						cachedWidth = width;
						cachedRev = rev;
						cachedLines = lines;
						return lines;
					},
				};
			});
		} else if (phase === "plan" && steps.length > 0) {
			widgetRevision++;
			const rev = widgetRevision;

			ctx.ui.setWidget("plan-build-steps", (_tui, theme) => {
				let cachedWidth = -1;
				let cachedRev = -1;
				let cachedLines: string[] | undefined;

				return {
					invalidate() {},
					render(width: number): string[] {
						if (cachedLines && cachedWidth === width && cachedRev === rev) {
							return cachedLines;
						}

						const lines: string[] = [];
						for (const step of steps) {
							const icon = theme.fg("dim", "☐ ");
							const num = theme.fg("muted", `${step.index}.`.padEnd(4));
							const styledText = theme.fg("dim", step.text);

							const prefix = `${icon}${num}`;
							const prefixVis = 7;
							const pad = " ".repeat(prefixVis);
							const textWidth = Math.max(10, width - prefixVis);
							const wrapped = wrapTextWithAnsi(styledText, textWidth);

							if (wrapped.length > 0) {
								lines.push(truncateToWidth(prefix + wrapped[0], width));
								for (let i = 1; i < wrapped.length; i++) {
									lines.push(truncateToWidth(pad + wrapped[i], width));
								}
							}
						}

						cachedWidth = width;
						cachedRev = rev;
						cachedLines = lines;
						return lines;
					},
				};
			});
		} else {
			ctx.ui.setWidget("plan-build-steps", undefined);
		}
	}

	/**
	 * Central state transition. Sets tools, phase, persists, manages footer.
	 * Notifications are handled by callers.
	 */
	function setPhase(newPhase: Phase, ctx: ExtensionContext): void {
		phase = newPhase;
		updateUI(ctx);
		persistState();

		// Footer: install for non-idle phases, uninstall for idle
		if (newPhase === "idle") {
			uninstallFooter(ctx);
		} else {
			installFooter(ctx);
		}
	}

	/**
	 * Restore persisted state from session entries.
	 */
	function restoreState(ctx: ExtensionContext): void {
		const entries = ctx.sessionManager.getEntries();

		// Scan entries from the end to find the latest plan-build-state entry
		// AND capture its real index so we can later scan messages after it.
		let stateEntry: { data?: PersistedState } | undefined;
		let stateEntryIndex = -1;
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i] as { type: string; customType?: string; data?: PersistedState };
			if (e.type === "custom" && e.customType === CUSTOM_TYPE_STATE) {
				stateEntry = e;
				stateEntryIndex = i;
				break;
			}
		}

		if (!stateEntry?.data) return;

		const saved = stateEntry.data;

		// Always restore steps if they exist — even if phase is idle.
		// This handles resume-after-preserve: user exited plan mode with
		// exitPlanModeKeepingPlan (phase=idle, steps intact) and later
		// resumed the session.
		if (saved.steps.length > 0) {
			steps = saved.steps.map((s) => ({ ...s }));
			rawPlanText = saved.rawPlan;
		}

		// Check if there's a plan-execute-start entry after the state entry
		let wasInBuildPhase = false;
		for (let i = stateEntryIndex + 1; i < entries.length; i++) {
			const e = entries[i] as { type: string; customType?: string };
			if (e.customType === "plan-build-execute-start") {
				wasInBuildPhase = true;
				break;
			}
			if (e.customType === "plan-build-abort" || e.customType === "plan-build-complete") {
				break;
			}
		}

		// Re-scan messages after the plan-execute-start entry for [DONE:n] markers
		if (wasInBuildPhase && steps.length > 0) {
			const executeStartIndex = entries.findIndex(
				(e: { customType?: string }) => e.customType === "plan-build-execute-start",
			);
			const messages: AssistantMessage[] = [];
			for (let i = executeStartIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (
					entry.type === "message" &&
					"message" in entry &&
					isAssistantMessage(entry.message as AgentMessage)
				) {
					messages.push(entry.message as AssistantMessage);
				}
			}

			const allText = messages.map(getTextContent).join("\n");
			markCompletedSteps(allText, steps);
		}

		// Determine phase to restore
		if (saved.phase === "build" || saved.phase === "summary") {
			const allDone = steps.length > 0 && steps.every((s) => s.completed);
			setPhase(allDone ? "summary" : "build", ctx);
		} else if (saved.phase === "plan" || saved.phase === "review") {
			setPhase("plan", ctx);
		}
		// If saved.phase is "idle" with steps, don't re-enter plan mode,
		// but the steps are already restored above for later /plan-build use.
	}

	/**
	 * Start plan mode.
	 */
	function startPlanMode(ctx: ExtensionContext): void {
		setPhase("plan", ctx);
		if (steps.length > 0) {
			const stepList = steps.map((s) => `${s.index}. ☐ ${s.text}`).join("\n");
			pi.sendMessage(
				{
					customType: "plan-build-restored",
					content: `**Restored plan (${steps.length} steps):**\n\n${stepList}\n\nUse /pb-review to review, /plan-build to exit.`,
					display: true,
				},
				{ triggerTurn: false },
			);
			ctx.ui.notify(
				`Plan mode — ${steps.length} steps restored. Use /pb-review or ask the model to refine.`,
				"info",
			);
		} else {
			ctx.ui.notify("Plan mode active — explore the codebase and create a numbered plan.", "info");
		}
	}

	/**
	 * Exit plan mode cleanly but KEEP the plan (for re-entering later).
	 * Used by /plan-build toggle-off and Ctrl+Alt+P shortcut.
	 */
	function exitPlanModeKeepingPlan(ctx: ExtensionContext): void {
		const prevPhase = phase;
		setPhase("idle", ctx);
		if (prevPhase === "build") {
			ctx.ui.notify("Build paused. Plan preserved — use /plan-build to resume.", "warning");
		} else {
			ctx.ui.notify("Plan mode exited. Plan preserved — use /plan-build to resume.", "info");
		}
	}

	/**
	 * Abort plan/build mode entirely, discarding all state.
	 * Used by /pb-abort and confirmed build-phase abort.
	 */
	function abortPlanMode(ctx: ExtensionContext): void {
		pi.appendEntry("plan-build-abort", { timestamp: Date.now() });

		// Clear state BEFORE persisting so we don't write stale data
		steps = [];
		rawPlanText = "";

		// Set idle directly (not through setPhase) so the single persistState
		// call inside setPhase captures the cleared state in one shot.
		setPhase("idle", ctx);
		ctx.ui.notify("Plan/build mode disabled. Plan discarded.", "warning");
	}

	/**
	 * Start the review phase — show interactive TUI for plan review.
	 */
	async function startReview(ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("Review requires interactive mode", "error");
			return;
		}

		if (steps.length === 0) {
			ctx.ui.notify("No plan to review. Ask the model to create a plan first in plan mode.", "error");
			return;
		}

		setPhase("review", ctx);

		const originalStepCount = steps.length;
		const originalEnabledCount = steps.filter((s) => s.enabled).length;

		const reviewResult = await ctx.ui.custom<ReviewResult>((_tui, theme, _kb, done) => {
			return new PlanReviewUI(steps, theme, done);
		});

		if (!reviewResult) {
			// User dismissed UI
			setPhase("plan", ctx);
			return;
		}

		steps = reviewResult.steps;
		const enabledSteps = steps.filter((s) => s.enabled);

		switch (reviewResult.action) {
			case "execute": {
				if (enabledSteps.length === 0) {
					ctx.ui.notify("No steps enabled. Enable at least one step or refine the plan.", "error");
					setPhase("review", ctx);
					// Re-show review
					await startReview(ctx);
					return;
				}

				// Start build phase
				setPhase("build", ctx);

				// Mark entry for tracking
				pi.appendEntry("plan-build-execute-start", { timestamp: Date.now() });

				const stepList = enabledSteps
					.map((s) => `${s.index}. ${s.text}`)
					.join("\n");

				const msg = steps.length !== enabledSteps.length
					? `Execute the following plan steps (${enabledSteps.length}/${steps.length} selected).\n\n` +
					  `After completing each step, mark it with [DONE:n] where n is the step number.\n\n${stepList}`
					: `Execute the plan. After completing each step, mark it with [DONE:n] where n is the step number.\n\n${stepList}`;

				pi.sendMessage(
					{
						customType: "plan-build-execute",
						content: msg,
						display: true,
					},
					{ triggerTurn: true },
				);
				break;
			}
			case "refine": {
				setPhase("plan", ctx);
				const newCount = steps.length;
				const newEnabledCount = steps.filter((s) => s.enabled).length;
				const appliedChanges: string[] = [];

				if (newCount !== originalStepCount) {
					appliedChanges.push(`${newCount} steps (was ${originalStepCount})`);
				}
				if (newEnabledCount !== originalEnabledCount) {
					appliedChanges.push(`${newEnabledCount}/${newCount} enabled`);
				}

				const changesNote = appliedChanges.length > 0
					? ` (changes: ${appliedChanges.join(", ")})`
					: "";

				pi.sendMessage(
					{
						customType: "plan-build-refine",
						content: `Refine the plan${changesNote}. Current plan:\n\n${formatSteps(steps)}`,
						display: true,
					},
					{ triggerTurn: true },
				);
				break;
			}
			case "stay": {
				setPhase("plan", ctx);
				ctx.ui.notify("Plan preserved. Use /plan-build to exit or /pb-execute to execute.", "info");
				break;
			}
			case "abort": {
				abortPlanMode(ctx);
				break;
			}
		}
	}

	/**
	 * Complete plan/build mode after successful execution.
	 */
	function completeExecution(ctx: ExtensionContext): void {
		pi.appendEntry("plan-build-complete", { timestamp: Date.now() });
		setPhase("summary", ctx);

		const completed = steps.filter((s) => s.completed).length;
		const total = steps.length;
		const completedList = steps
			.map((s) => (s.completed ? `~~${s.text}~~` : s.text))
			.join("\n");

		pi.sendMessage(
			{
				customType: "plan-build-complete",
				content:
					`**Plan Complete!** ✓\n\n${completed}/${total} steps done.\n\n${completedList}` +
					(completed < total ? `\n\n${total - completed} steps remaining. Use /plan-build to create a follow-up plan.` : ""),
				display: true,
			},
			{ triggerTurn: false },
		);
	}

	// ══════════════════════════════════════════════════════════════════════
	// COMMANDS
	// ══════════════════════════════════════════════════════════════════════

	pi.registerCommand("plan-build", {
		description: "Toggle plan/build mode",
		handler: async (_args, ctx) => {
			if (phase !== "idle") {
				// If in plan/review phase, exit cleanly (keep plan)
				if (phase === "plan" || phase === "review") {
					const choice = await ctx.ui.select("Exit plan mode?", [
						"Yes, exit plan mode (plan preserved)",
						"No, stay in plan mode",
					]);
					if (choice?.startsWith("Yes")) {
						exitPlanModeKeepingPlan(ctx);
					}
				} else if (phase === "build") {
					const choice = await ctx.ui.select("Build in progress — abort?", [
						"Yes, abort execution and discard plan",
						"No, keep building",
					]);
					if (choice?.startsWith("Yes")) {
						abortPlanMode(ctx);
					}
				} else if (phase === "summary") {
					abortPlanMode(ctx);
				}
			} else {
				startPlanMode(ctx);
			}
		},
	});

	pi.registerCommand("pb-review", {
		description: "Review the current plan",
		handler: async (_args, ctx) => {
			if (phase === "idle") {
				ctx.ui.notify("Not in plan mode. Use /plan-build first.", "error");
				return;
			}
			if (phase === "build") {
				ctx.ui.notify("Cannot review during build phase. Wait for execution to complete or /plan-build to abort.", "error");
				return;
			}
			await startReview(ctx);
		},
	});

	pi.registerCommand("pb-status", {
		description: "Show current plan progress",
		handler: async (_args, ctx) => {
			if (phase === "idle") {
				ctx.ui.notify("Not in plan mode. Use /plan-build first.", "info");
				return;
			}

			const summary = getProgressSummary(steps);
			const phaseLabels: Record<Phase, string> = {
				idle: "Idle",
				plan: "Plan",
				review: "Review",
				build: "Build",
				summary: "Summary",
			};

			ctx.ui.notify(`Phase: ${phaseLabels[phase]}\n${summary}\n\n${formatSteps(steps)}`, "info");
		},
	});

	pi.registerCommand("pb-execute", {
		description: "Begin executing the plan",
		handler: async (_args, ctx) => {
			if (phase === "idle") {
				ctx.ui.notify("Not in plan mode. Use /plan-build first.", "error");
				return;
			}
			if (phase === "build") {
				ctx.ui.notify("Already executing.", "info");
				return;
			}
			if (phase === "summary") {
				ctx.ui.notify("Plan already complete. Use /plan-build to exit and create a new plan.", "info");
				return;
			}
			await startReview(ctx);
		},
	});

	pi.registerCommand("pb-abort", {
		description: "Abort plan/build mode (discards plan)",
		handler: async (_args, ctx) => {
			if (phase === "idle") {
				ctx.ui.notify("Not in plan mode.", "info");
				return;
			}
			if (phase === "build") {
				const ok = await ctx.ui.confirm("Abort execution?", "This will stop the current build and discard the plan.");
				if (!ok) return;
			}
			abortPlanMode(ctx);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan/build mode",
		handler: async (ctx) => {
			if (phase === "idle") {
				startPlanMode(ctx);
			} else if (phase === "build") {
				// Shortcut during build: notify but don't silently destroy
				ctx.ui.notify("Build in progress. Use /pb-abort to abort or /plan-build to exit.", "warning");
			} else {
				// plan or review: exit cleanly, keep the plan
				exitPlanModeKeepingPlan(ctx);
			}
		},
	});

	// ══════════════════════════════════════════════════════════════════════
	// EVENT HOOKS
	// ══════════════════════════════════════════════════════════════════════

	// ── Filter stale plan context when not in plan mode ──────────────────
	pi.on("context", async (event) => {
		if (phase !== "idle") return;

		// All customType entries that should be stripped when not in plan mode
		const stripCustomTypes = new Set([
			"plan-build-context",
			"plan-build-execute",
			"plan-build-execute-context",
			"plan-build-extracted",
			"plan-build-refine",
			"plan-build-nudge",
			"plan-build-complete",
			"plan-build-abort",
			"plan-build-execute-start",
		]);

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				return !(msg.customType && stripCustomTypes.has(msg.customType));
			}),
		};
	});

	// ── Inject phase-specific context before agent starts ──────────────
	pi.on("before_agent_start", async () => {
		if (phase === "plan") {
			return {
				message: {
					customType: "plan-build-context",
					content: `[PLAN MODE ACTIVE]

You are in **plan mode** — a planning phase. Your job is to explore the codebase, ask clarifying questions, and create a detailed implementation plan. Do NOT make any changes yet.

**Your task:**
1. Explore the codebase to understand the problem. Use whatever tools are helpful for reading and searching.
2. Ask clarifying questions using the **questionnaire** tool. Bundle multiple related questions into one call so the user can answer them all in a tabbed dialog before submitting.
3. Create a detailed, numbered implementation plan under a "Plan:" header like this:

Plan:
1. First step — clear, actionable description
2. Second step — clear, actionable description
3. ...

Each step should be a concrete, executable task. Do NOT include sub-steps or nested lists.

The user will review and approve the plan before any implementation begins. Wait for confirmation before making any code changes.`,
					display: false,
				},
			};
		}

		if (phase === "build" && steps.length > 0) {
			const remaining = steps.filter((s) => !s.completed && s.enabled);
			if (remaining.length === 0) return;

			const todoList = remaining.map((s) => `${s.index}. ${s.text}`).join("\n");
			return {
				message: {
					customType: "plan-build-execute-context",
					content: `[EXECUTING PLAN]

**Remaining steps:**
${todoList}

Execute each step in order. After completing a step, include a **[DONE:n]** tag in your response where n is the step number, e.g.:

[DONE:1]

This tracks progress automatically. Only mark steps as DONE when they are fully implemented.`,
					display: false,
				},
			};
		}
	});

	// ── Track [DONE:n] markers after each turn ─────────────────────────
	pi.on("turn_end", async (event, ctx) => {
		if (phase !== "build" || steps.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		if (markCompletedSteps(text, steps) > 0) {
			updateUI(ctx);
			persistState();
		}
	});

	// ── Handle agent end — extract plan, show review, detect completion ─
	pi.on("agent_end", async (event, ctx) => {
		// ── Check if build is complete ──────────────────────────────────
		if (phase === "build" && steps.length > 0) {
			const allEnabledDone = steps.every((s) => !s.enabled || s.completed);
			if (allEnabledDone) {
				completeExecution(ctx);
			}
			return;
		}

		// ── Extract plan after agent finishes in plan phase ────────────
		if (phase !== "plan") return;

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (!lastAssistant) return;

		const text = getTextContent(lastAssistant);
		const extracted = extractPlanSteps(text);

		if (extracted.length === 0) {
			// No plan found — prompt the model
			if (ctx.hasUI) {
				const choice = await ctx.ui.select("No plan detected. What would you like to do?", [
					"Ask model to create a plan",
					"Stay in plan mode",
					"Exit plan mode (plan preserved)",
				]);

				if (choice?.startsWith("Ask")) {
					pi.sendMessage(
						{
							customType: "plan-build-nudge",
							content: "Please create a numbered implementation plan under a 'Plan:' header with clear, actionable steps.",
							display: true,
						},
						{ triggerTurn: true },
					);
				} else if (choice?.startsWith("Exit")) {
					exitPlanModeKeepingPlan(ctx);
				}
			}
			return;
		}

		// Plan found — save it
		steps = extracted;
		rawPlanText = text;
		persistState();

		// Show plan summary and prompt for next action
		const stepList = steps.map((s, i) => `${i + 1}. ☐ ${s.text}`).join("\n");
		pi.sendMessage(
			{
				customType: "plan-build-extracted",
				content: `**Plan (${steps.length} steps):**\n\n${stepList}`,
				display: true,
			},
			{ triggerTurn: false },
		);

		if (ctx.hasUI) {
			const guardKey = `review-${Date.now()}`;
			if (pendingReviews.size > 0) return;
			pendingReviews.add(guardKey);
			try {
				await startReview(ctx as ExtensionCommandContext);
			} finally {
				pendingReviews.delete(guardKey);
			}
		}
	});

	// ══════════════════════════════════════════════════════════════════════
	// SESSION STARTUP
	// ══════════════════════════════════════════════════════════════════════

	pi.on("session_start", async (_event, ctx) => {
		// Check CLI flag
		if (pi.getFlag("plan-build") === true && phase === "idle") {
			startPlanMode(ctx);
			return;
		}

		// Restore persisted state (may install footer via setPhase)
		restoreState(ctx);

		// Ensure footer is installed if we're in a non-idle phase
		if (phase !== "idle" && !footerInstalled) {
			installFooter(ctx);
		}
	});
}
