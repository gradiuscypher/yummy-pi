/**
 * Review UI — interactive TUI component for reviewing and editing
 * plan steps before execution.
 *
 * Controls:
 *   ↑/↓       — Navigate steps
 *   Space     — Toggle step enabled/disabled
 *   Enter     — Edit selected step text
 *   Delete    — Remove selected step
 *   Ctrl+↑/↓  — Reorder selected step
 *   Ctrl+A    — Select all steps
 *   Ctrl+D    — Deselect all steps
 *   Ctrl+E    — Execute plan
 *   Ctrl+R    — Refine plan (send back to model)
 *   Ctrl+S    — Stay in plan mode
 *   Ctrl+Q    — Abort plan mode
 *   Escape    — Stay in plan mode
 *   ?         — Show help
 */

import type { PlanStep, ReviewAction } from "./types.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

/** Result returned when the review UI is dismissed. */
export interface ReviewResult {
	action: ReviewAction;
	steps: PlanStep[];
	refinementText: string;
}

/** State for the review TUI component. */
interface ReviewState {
	steps: PlanStep[];
	selectedIndex: number;
	showHelp: boolean;
	editing: boolean;
	editText: string;
	message: string;
	messageType: "info" | "error" | "success";
}

export class PlanReviewUI {
	private state: ReviewState;
	private theme: Theme;
	private resolve: (result: ReviewResult) => void;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(steps: PlanStep[], theme: Theme, resolve: (result: ReviewResult) => void) {
		this.state = {
			steps: steps.map((s) => ({ ...s })),
			selectedIndex: 0,
			showHelp: false,
			editing: false,
			editText: "",
			message: "",
			messageType: "info",
		};
		this.theme = theme;
		this.resolve = resolve;
	}

	handleInput(data: string): void {
		const { steps, selectedIndex, editing, showHelp } = this.state;

		// ── Help screen — any key dismisses ────────────────────────────
		if (showHelp) {
			this.state.showHelp = false;
			this.invalidate();
			return;
		}

		// ── Editing mode — handle text input ───────────────────────────
		if (editing) {
			if (matchesKey(data, "enter")) {
				// Save edit
				if (steps[selectedIndex] && this.state.editText.trim()) {
					steps[selectedIndex].text = this.state.editText.trim();
					this.setStateMessage("Step updated", "success");
				}
				this.state.editing = false;
				this.state.editText = "";
			} else if (matchesKey(data, "escape")) {
				this.state.editing = false;
				this.state.editText = "";
			} else if (matchesKey(data, "backspace")) {
				this.state.editText = this.state.editText.slice(0, -1);
			} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
				this.state.editText += data;
			}
			this.invalidate();
			return;
		}

		// ── Normal navigation mode ─────────────────────────────────────
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.state.selectedIndex = Math.max(0, selectedIndex - 1);
		} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.state.selectedIndex = Math.min(steps.length - 1, selectedIndex + 1);
		} else if (matchesKey(data, "space")) {
			if (steps[selectedIndex]) {
				steps[selectedIndex].enabled = !steps[selectedIndex].enabled;
			}
		} else if (matchesKey(data, "enter")) {
			if (steps[selectedIndex]) {
				this.state.editing = true;
				this.state.editText = steps[selectedIndex].text;
			}
		} else if (matchesKey(data, "delete") || matchesKey(data, "d")) {
			if (steps.length > 0 && steps[selectedIndex]) {
				steps.splice(selectedIndex, 1);
				// Reindex
				for (let i = 0; i < steps.length; i++) {
					steps[i].index = i + 1;
				}
				if (this.state.selectedIndex >= steps.length) {
					this.state.selectedIndex = Math.max(0, steps.length - 1);
				}
				this.setStateMessage("Step removed", "info");
			}
		} else if (matchesKey(data, "ctrl+up")) {
			if (selectedIndex > 0 && steps[selectedIndex]) {
				const step = steps[selectedIndex];
				steps.splice(selectedIndex, 1);
				steps.splice(selectedIndex - 1, 0, step);
				// Reindex
				for (let i = 0; i < steps.length; i++) {
					steps[i].index = i + 1;
				}
				this.state.selectedIndex--;
				this.invalidate();
			}
		} else if (matchesKey(data, "ctrl+down")) {
			if (selectedIndex < steps.length - 1 && steps[selectedIndex]) {
				const step = steps[selectedIndex];
				steps.splice(selectedIndex, 1);
				steps.splice(selectedIndex + 1, 0, step);
				// Reindex
				for (let i = 0; i < steps.length; i++) {
					steps[i].index = i + 1;
				}
				this.state.selectedIndex++;
				this.invalidate();
			}
		} else if (matchesKey(data, "ctrl+a")) {
			for (const step of steps) step.enabled = true;
			this.setStateMessage("All steps selected", "success");
		} else if (matchesKey(data, "ctrl+d")) {
			for (const step of steps) step.enabled = false;
			this.setStateMessage("All steps deselected", "info");
		} else if (matchesKey(data, "ctrl+e")) {
			this.resolve({ action: "execute", steps, refinementText: "" });
		} else if (matchesKey(data, "ctrl+r")) {
			this.resolve({ action: "refine", steps, refinementText: "" });
		} else if (matchesKey(data, "ctrl+s") || matchesKey(data, "escape")) {
			this.resolve({ action: "stay", steps, refinementText: "" });
		} else if (matchesKey(data, "ctrl+q")) {
			this.resolve({ action: "abort", steps, refinementText: "" });
		} else if (data === "?") {
			this.state.showHelp = true;
		}
		this.invalidate();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;
		const { steps, selectedIndex, editing, editText, showHelp, message, messageType } = this.state;

		// ── Help screen ─────────────────────────────────────────────────
		if (showHelp) {
			lines.push("");
			lines.push(truncateToWidth(`  ${th.fg("accent", th.bold("Keyboard Controls"))}`, width));
			lines.push("");
			for (const [key, desc] of HELPTEXT) {
				lines.push(truncateToWidth(`  ${th.fg("accent", key.padEnd(12))} ${th.fg("dim", desc)}`, width));
			}
			lines.push("");
			lines.push(truncateToWidth(`  ${th.fg("dim", "Press any key to return")}`, width));
			lines.push("");
			this.cachedWidth = width;
			this.cachedLines = lines;
			return lines;
		}

		// ── Edit mode ───────────────────────────────────────────────────
		if (editing) {
			const step = steps[selectedIndex];
			lines.push("");
			lines.push(truncateToWidth(`  ${th.fg("accent", th.bold(`Editing step #${step?.index ?? "?"}`))}`, width));
			lines.push("");
			lines.push(truncateToWidth(`  ${th.fg("dim", "Enter new description:")}`, width));
			lines.push("");
			lines.push(truncateToWidth(`  ▐ ${th.fg("text", editText)}${th.fg("dim", "│")}`, width));
			lines.push("");
			lines.push(truncateToWidth(`  ${th.fg("dim", "Enter: save  │  Escape: cancel")}`, width));
			lines.push("");
			this.cachedWidth = width;
			this.cachedLines = lines;
			return lines;
		}

		// ── Header ──────────────────────────────────────────────────────
		const enabled = steps.filter((s) => s.enabled).length;
		const total = steps.length;

		lines.push("");
		const headerLeft = th.fg("accent", th.bold(" 📋 Review Plan "));
		const headerRight = th.fg("muted", `${enabled}/${total} steps enabled`);
		const padding = Math.max(2, width - headerLeft.length - headerRight.length - 4);
		lines.push(truncateToWidth(`  ${headerLeft}${"─".repeat(padding)}${headerRight}`, width));
		lines.push("");

		// ── Steps ───────────────────────────────────────────────────────
		const visibleStart = Math.max(0, selectedIndex - Math.floor(8));
		const visibleEnd = Math.min(steps.length, visibleStart + 16);

		if (visibleStart > 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", `... ${visibleStart} earlier steps ...`)}`, width));
		}

		for (let i = visibleStart; i < visibleEnd; i++) {
			const step = steps[i];
			const isSelected = i === selectedIndex;
			const prefix = isSelected ? th.fg("accent", "▶") : " ";

			// Status icon
			let icon: string;
			if (!step.enabled) {
				icon = th.fg("dim", "✕");
			} else if (step.completed) {
				icon = th.fg("success", "✓");
			} else {
				icon = th.fg("dim", "○");
			}

			// Step index
			const idx = th.fg("muted", `${step.index}.`.padEnd(4));

			// Step text
			let stepText = step.text;
			if (stepText.length > width - 16) {
				stepText = stepText.slice(0, width - 19) + "...";
			}

			let line: string;
			if (isSelected) {
				// Highlighted line
				if (step.completed) {
					line = ` ${prefix}${idx}${icon} ${th.fg("success", stepText)}`;
				} else if (!step.enabled) {
					line = ` ${prefix}${idx}${icon} ${th.fg("dim", th.strikethrough(stepText))}`;
				} else {
					line = ` ${prefix}${idx}${icon} ${th.fg("text", th.bold(stepText))}`;
				}
			} else {
				// Normal line
				if (step.completed) {
					line = ` ${prefix}${idx}${icon} ${th.fg("success", stepText)}`;
				} else if (!step.enabled) {
					line = ` ${prefix}${idx}${icon} ${th.fg("dim", th.strikethrough(stepText))}`;
				} else {
					line = ` ${prefix}${idx}${icon} ${th.fg("muted", stepText)}`;
				}
			}
			lines.push(truncateToWidth(line, width));
		}

		if (visibleEnd < steps.length) {
			lines.push(
				truncateToWidth(`  ${th.fg("dim", `... ${steps.length - visibleEnd} more steps ...`)}`, width),
			);
		}

		// ── Empty state ─────────────────────────────────────────────────
		if (steps.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No steps to review.")}`, width));
			lines.push("");
		}

		// ── Message ─────────────────────────────────────────────────────
		if (message) {
			lines.push("");
			const msgColor = messageType === "error" ? "error" : messageType === "success" ? "success" : "muted";
			lines.push(truncateToWidth(`  ${th.fg(msgColor, message)}`, width));
		}

		// ── Footer controls ─────────────────────────────────────────────
		lines.push("");
		const footerItems = [
			{ key: "↑↓", desc: "navigate" },
			{ key: "Space", desc: "toggle" },
			{ key: "Enter", desc: "edit" },
			{ key: "Del", desc: "remove" },
			{ key: "Ctrl+E", desc: "execute" },
			{ key: "Ctrl+R", desc: "refine" },
			{ key: "Ctrl+S", desc: "stay" },
			{ key: "?", desc: "help" },
		];

		let footer = "";
		for (const { key, desc } of footerItems) {
			const segment = ` ${th.fg("accent", key)} ${th.fg("dim", desc)} `;
			if (footer.length + segment.length > width - 2) break;
			footer += segment;
		}
		lines.push(truncateToWidth(`  ${footer}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private setStateMessage(text: string, type: "info" | "error" | "success"): void {
		this.state.message = text;
		this.state.messageType = type;
		// Auto-clear after 3 seconds
		setTimeout(() => {
			if (this.state.message === text) {
				this.state.message = "";
				this.invalidate();
			}
		}, 3000);
	}
}

const HELPTEXT: [string, string][] = [
	["↑/↓ or j/k", "Navigate steps"],
	["Space", "Toggle step enabled/disabled"],
	["Enter", "Edit selected step text"],
	["Delete", "Remove selected step"],
	["Ctrl+↑/Ctrl+↓", "Reorder selected step"],
	["Ctrl+A", "Select all steps"],
	["Ctrl+D", "Deselect all steps"],
	["Ctrl+E", "Approve & execute plan"],
	["Ctrl+R", "Send back for refinement"],
	["Ctrl+S / Escape", "Stay in plan mode"],
	["Ctrl+Q", "Abort plan mode entirely"],
	["?", "Show this help"],
];
