/**
 * Type definitions for Plan/Build Mode extension.
 */

/** Architecture phase the extension is currently in. */
export type Phase =
	| "idle"     // Not in plan/build mode
	| "plan"     // Read-only exploration, model creates a plan
	| "review"   // User reviews/edits the plan via TUI
	| "build"    // Full tool access, executing steps
	| "summary"; // Execution complete, report shown

/** A single plan step with completion tracking. */
export interface PlanStep {
	/** 1-based display index in the plan. */
	index: number;
	/** The step description text. */
	text: string;
	/** Whether this step has been completed via [DONE:n] marker. */
	completed: boolean;
	/** Whether this step is enabled for execution (user can toggle off). */
	enabled: boolean;
}

/** Persisted state saved in session entries. */
export interface PersistedState {
	phase: Phase;
	steps: PlanStep[];
	/** Timestamp when the plan was created. */
	createdAt: number;
	/** Original raw plan text from the model. */
	rawPlan: string;
}

/** Plan review actions the user can take. */
export type ReviewAction =
	| "execute"    // Approve & start build phase
	| "refine"     // Send back to model for refinement
	| "stay"       // Stay in plan mode
	| "abort";     // Exit plan mode entirely

/** Configuration for the extension. */
export interface PlanBuildConfig {
	/** Additional safe command patterns (regex strings). */
	extraSafePatterns: string[];
	/** Additional blocked command patterns (regex strings). */
	extraBlockedPatterns: string[];
	/** Whether to pause between steps during build. */
	pauseBetweenSteps: boolean;
	/** Whether to stop on first error. */
	stopOnError: boolean;
	/** Maximum plan steps to display in collapsed view. */
	maxCollapsedSteps: number;
}

export const DEFAULT_CONFIG: PlanBuildConfig = {
	extraSafePatterns: [],
	extraBlockedPatterns: [],
	pauseBetweenSteps: false,
	stopOnError: true,
	maxCollapsedSteps: 10,
};