/**
 * Plan parser — extracts numbered steps from model output and detects
 * [DONE:n] completion markers.
 *
 * Supports multiple plan formats:
 *   Plan:
 *   1. Step description
 *   2. Another step
 *
 *   Plan:
 *   1) Step description
 *   2) Another step
 *
 *   ## Plan
 *   - [ ] Step one
 *   - [ ] Step two
 */

import type { PlanStep } from "./types.ts";

// ── Regex patterns ──────────────────────────────────────────────────────

/** Matches "Plan:" header in various markdown styles. */
const PLAN_HEADER_RE = /(?:^|\n)#{1,3}\s*(?:Plan|Implementation Plan|Execution Plan)\s*\n|(?:^|\n)\*{0,2}Plan:?\*{0,2}\s*\n|(?:^|\n)Plan\s*\n/i;

/** Matches numbered steps: "1.", "1)", "[1]", "1 -", "1:" */
const NUMBERED_STEP_RE = /^\s*(\d+)[.)\-\]:]\s+(.+)/gm;

/** Matches checkbox steps: "- [ ] text" or "- [x] text" */
const CHECKBOX_STEP_RE = /^\s*[-*]\s+\[([ xX])\]\s+(.+)/gm;

/** Matches [DONE:n] markers (case-insensitive). */
const DONE_MARKER_RE = /\[DONE:(\d+)\]/gi;

/** Matches [DONE] marker (completes current/named step). */
const DONE_GENERIC_RE = /\[DONE\]/gi;

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Extract plan content from a message.
 * Returns the first "Plan:" section found, or null.
 */
export function extractPlanSection(text: string): string | null {
	const match = text.match(PLAN_HEADER_RE);
	if (!match) return null;

	const startIndex = text.indexOf(match[0]) + match[0].length;
	let planSection = text.slice(startIndex);

	// Trim trailing content after a clear section break
	const nextHeader = planSection.search(/\n#{1,3}\s+\w/);
	if (nextHeader !== -1) {
		planSection = planSection.slice(0, nextHeader);
	}

	// Trim after a blank-line double-break (two blank lines in a row)
	const doubleBlank = planSection.search(/\n\s*\n\s*\n\s*\n/);
	if (doubleBlank !== -1) {
		planSection = planSection.slice(0, doubleBlank);
	}

	return planSection.trim() || null;
}

/**
 * Extract numbered plan steps from text.
 * Handles multiple format variants:
 *   - "1. Step text" / "1) Step text"
 *   - "[1] Step text"
 *   - "1 - Step text" / "1: Step text"
 *   - "- [ ] Step text" (checkbox format)
 */
export function extractPlanSteps(text: string): PlanStep[] {
	const planSection = extractPlanSection(text);
	if (!planSection) return [];

	const steps: PlanStep[] = [];

	// Try numbered format first
	for (const match of planSection.matchAll(NUMBERED_STEP_RE)) {
		const stepNum = Number.parseInt(match[1], 10);
		let stepText = cleanupStepText(match[2]);

		if (stepText.length >= 3) {
			steps.push({
				index: stepNum,
				text: stepText,
				completed: false,
				enabled: true,
			});
		}
	}

	// If no numbered steps found, try checkbox format
	if (steps.length === 0) {
		let idx = 0;
		for (const match of planSection.matchAll(CHECKBOX_STEP_RE)) {
			idx++;
			const isChecked = match[1].toLowerCase() === "x";
			let stepText = cleanupStepText(match[2]);

			if (stepText.length >= 3) {
				steps.push({
					index: idx,
					text: stepText,
					completed: isChecked,
					enabled: true,
				});
			}
		}
	}

	return steps;
}

/**
 * Extract step numbers completed via [DONE:n] markers.
 */
export function extractDoneSteps(text: string): number[] {
	const steps: number[] = [];
	for (const match of text.matchAll(DONE_MARKER_RE)) {
		const step = Number.parseInt(match[1], 10);
		if (Number.isFinite(step) && step > 0) {
			steps.push(step);
		}
	}
	return [...new Set(steps)]; // deduplicate
}

/**
 * Check if the text contains a generic [DONE] marker (without step number).
 */
export function hasGenericDoneMarker(text: string): boolean {
	return DONE_GENERIC_RE.test(text);
}

/**
 * Mark steps as completed based on [DONE:n] markers in text.
 * Returns the number of newly completed steps.
 */
export function markCompletedSteps(text: string, steps: PlanStep[]): number {
	const doneSteps = extractDoneSteps(text);

	if (doneSteps.length === 0 && hasGenericDoneMarker(text) && steps.length > 0) {
		// [DONE] without a number: mark the first incomplete step
		const nextIncomplete = steps.find((s) => !s.completed);
		if (nextIncomplete) {
			nextIncomplete.completed = true;
			return 1;
		}
		return 0;
	}

	let count = 0;
	for (const stepNum of doneSteps) {
		// Try matching by original index
		const item = steps.find((s) => s.index === stepNum && !s.completed);
		if (item) {
			item.completed = true;
			count++;
		} else {
			// Fallback: match by array position (1-based)
			const pos = steps[stepNum - 1];
			if (pos && !pos.completed) {
				pos.completed = true;
				count++;
			}
		}
	}
	return count;
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Clean up step text by removing markdown formatting and common prefixes.
 */
function cleanupStepText(text: string): string {
	let cleaned = text
		// Remove bold/italic markers
		.replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
		.replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
		// Remove inline code
		.replace(/`([^`]+)`/g, "$1")
		// Remove common action prefixes
		.replace(/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install|Configure|Set up|Set\s+up|Build|Deploy|Test|Implement|Refactor|Fix|Ensure|Make\s+sure)\s+(the\s+)?/i, "")
		// Remove trailing colons and periods
		.replace(/[.:]+$/, "")
		// Collapse whitespace
		.replace(/\s+/g, " ")
		.trim();

	// Capitalize first letter
	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}

	// Truncate if too long
	if (cleaned.length > 80) {
		cleaned = cleaned.slice(0, 77) + "...";
	}

	return cleaned;
}

/**
 * Format steps as a readable list for display.
 */
export function formatSteps(steps: PlanStep[]): string {
	if (steps.length === 0) return "(no steps)";

	return steps
		.map((s) => {
			const marker = s.completed ? "✓" : "○";
			const disabled = !s.enabled ? " (skipped)" : "";
			const text = s.completed ? `${s.text} [DONE]` : s.text;
			return `${s.index}. ${marker} ${text}${disabled}`;
		})
		.join("\n");
}

/**
 * Get a one-line summary of plan progress.
 */
export function getProgressSummary(steps: PlanStep[]): string {
	const total = steps.length;
	const completed = steps.filter((s) => s.completed).length;
	const enabled = steps.filter((s) => s.enabled).length;

	if (total === 0) return "No steps";
	if (completed === total) return `✅ All ${total} steps complete`;
	if (completed > 0) return `📋 ${completed}/${total} steps done (${enabled - completed} remaining)`;
	return `📋 ${total} steps planned`;
}
