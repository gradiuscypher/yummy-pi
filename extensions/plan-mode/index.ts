/**
 * Plan Mode Extension for pi
 *
 * A lightweight plan/implement toggle. When active, text-only guardrails
 * are prepended to the user's prompt instructing the model to explore,
 * plan, and ask questions — but NOT to write or edit code.
 *
 * When inactive, pi functions normally with no guardrails.
 *
 * Commands:
 *   /plan         — Toggle plan mode on/off
 *   /plan-save    — Save current plan to ./plans/<timestamp>-<slug>.md
 *
 * Shortcuts:
 *   ctrl+alt+p    — Toggle plan mode
 *   ctrl+alt+s    — Save plan to file
 */

import type {
	AssistantMessage,
	TextContent,
} from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PLANNING_CONTEXT } from "./prompts.ts";

// ── Constants ───────────────────────────────────────────────────────────

const CUSTOM_TYPE_STATE = "plan-mode-state";
const CUSTOM_TYPE_CONTEXT = "plan-mode-context";

interface SessionState {
	active: boolean;
	planFile?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function getLastAssistantText(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type: string; message?: AgentMessage };
		if (
			entry.type === "message" &&
			entry.message &&
			isAssistantMessage(entry.message)
		) {
			return getTextContent(entry.message);
		}
	}
	return "";
}

// ── Slug from plan text ─────────────────────────────────────────────────

function slugFromPlan(text: string): string {
	// Try first heading
	const headingMatch = text.match(/^#+\s*(.+)$/m);
	if (headingMatch) {
		return sanitizeSlug(headingMatch[1]);
	}
	// Try "Plan:" followed by step 1
	const planMatch = text.match(/^Plan:?\s*\n\s*1[\.\)]\s*(.+)$/m);
	if (planMatch) {
		return sanitizeSlug(planMatch[1]);
	}
	// Fall back to first meaningful line
	const firstLine = text.split("\n").find((l) => l.trim().length > 10);
	if (firstLine) {
		return sanitizeSlug(firstLine);
	}
	return "plan";
}

function sanitizeSlug(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60) || "plan";
}

function timestampSlug(): string {
	const now = new Date();
	const y = now.getFullYear();
	const mo = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	const h = String(now.getHours()).padStart(2, "0");
	const m = String(now.getMinutes()).padStart(2, "0");
	return `${y}-${mo}-${d}-${h}${m}`;
}

// ── Plan file write ─────────────────────────────────────────────────────

async function resolvePlanPath(dir: string, slug: string): Promise<string> {
	await mkdir(dir, { recursive: true });
	let candidate = join(dir, `${timestampSlug()}-${slug}.md`);
	if (!existsSync(candidate)) return candidate;

	// Append numeric suffix if collision
	for (let i = 2; i < 100; i++) {
		const alt = join(dir, `${timestampSlug()}-${slug}-${i}.md`);
		if (!existsSync(alt)) return alt;
	}
	return candidate; // fallback (unlikely)
}

async function writePlanFile(
	cwd: string,
	text: string,
): Promise<string> {
	const slug = slugFromPlan(text);
	const dir = join(cwd, "plans");
	const path = await resolvePlanPath(dir, slug);

	const header = [
		"---",
		`created: ${new Date().toISOString()}`,
		"---",
		"",
		"",
	].join("\n");

	await writeFile(path, header + text, "utf8");
	return path;
}

// ── Extension ───────────────────────────────────────────────────────────

export default function planModeExtension(pi: ExtensionAPI): void {
	// ── In-memory state ──────────────────────────────────────────────
	let planModeActive = false;
	let planFile: string | undefined;

	// ── Persist session state ────────────────────────────────────────
	function persist(ctx: ExtensionContext): void {
		const data: SessionState = { active: planModeActive, planFile };
		pi.appendEntry(CUSTOM_TYPE_STATE, data);
	}

	// ── UI ────────────────────────────────────────────────────────────
	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (planModeActive) {
			ctx.ui.setStatus(
				"plan-mode",
				ctx.ui.theme.fg("warning", `⏸ plan${planFile ? " • saved" : ""}`),
			);
			ctx.ui.setWidget("plan-mode", [
				`Plan mode active — ${Key.ctrlAlt("s")} save  ${Key.ctrlAlt("p")} exit`,
			]);
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
			ctx.ui.setWidget("plan-mode", undefined);
		}
	}

	// ── Enter plan mode ──────────────────────────────────────────────
	function enterPlanMode(ctx: ExtensionContext): void {
		planModeActive = true;
		planFile = undefined;
		updateStatus(ctx);
		persist(ctx);
		ctx.ui.notify(
			"Plan mode enabled. Ask the model to explore and create a plan.",
			"info",
		);
	}

	// ── Exit plan mode ───────────────────────────────────────────────
	function exitPlanMode(ctx: ExtensionContext): void {
		if (!planModeActive) {
			ctx.ui.notify("Not in plan mode.", "warning");
			return;
		}

		planModeActive = false;
		planFile = undefined;
		updateStatus(ctx);
		persist(ctx);
		ctx.ui.notify("Plan mode exited.", "info");
	}

	// ── Save plan file ───────────────────────────────────────────────
	async function savePlan(ctx: ExtensionContext): Promise<void> {
		if (!planModeActive) {
			ctx.ui.notify("Not in plan mode. Nothing to save.", "warning");
			return;
		}

		if (!ctx.isIdle()) {
			ctx.ui.notify("Wait for the model to finish before saving.", "warning");
			return;
		}

		const text = getLastAssistantText(ctx);
		if (!text.trim()) {
			ctx.ui.notify(
				"No plan found. Ask the model to create a plan first.",
				"warning",
			);
			return;
		}

		try {
			const path = await writePlanFile(ctx.cwd, text);
			planFile = path;
			persist(ctx);
			updateStatus(ctx);
			ctx.ui.notify(`Plan saved: ${path}`, "info");
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(`Failed to save plan: ${msg}`, "error");
		}
	}

	// ══════════════════════════════════════════════════════════════════
	// COMMANDS
	// ══════════════════════════════════════════════════════════════════

	pi.registerCommand("plan", {
		description: "Toggle plan mode on/off",
		handler: async (_args, ctx) => {
			if (planModeActive) {
				exitPlanMode(ctx);
			} else {
				enterPlanMode(ctx);
			}
		},
	});

	pi.registerCommand("plan-save", {
		description: "Save the current plan to a file",
		handler: async (_args, ctx) => {
			await savePlan(ctx);
		},
	});

	// ══════════════════════════════════════════════════════════════════
	// SHORTCUTS
	// ══════════════════════════════════════════════════════════════════

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: (ctx) => {
			if (planModeActive) {
				exitPlanMode(ctx);
			} else {
				enterPlanMode(ctx);
			}
		},
	});

	pi.registerShortcut(Key.ctrlAlt("s"), {
		description: "Save plan to file",
		handler: async (ctx) => {
			await savePlan(ctx);
		},
	});

	// ══════════════════════════════════════════════════════════════════
	// EVENTS
	// ══════════════════════════════════════════════════════════════════

	// Inject planning context guardrails when plan mode is active
	pi.on("before_agent_start", async () => {
		if (!planModeActive) return;

		return {
			message: {
				customType: CUSTOM_TYPE_CONTEXT,
				content: PLANNING_CONTEXT,
				display: false,
			},
		};
	});

	// Strip stale plan-mode context messages when plan mode is off
	pi.on("context", async (event) => {
		if (planModeActive) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				return msg.customType !== CUSTOM_TYPE_CONTEXT;
			}),
		};
	});

	// Restore session state on start/resume
	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const stateEntry = entries
			.filter(
				(e) =>
					(e as { type: string; customType?: string }).type === "custom" &&
					(e as { type: string; customType?: string }).customType ===
						CUSTOM_TYPE_STATE,
			)
			.pop() as { data?: SessionState } | undefined;

		if (stateEntry?.data) {
			planModeActive = stateEntry.data.active ?? false;
			planFile = stateEntry.data.planFile;
		}

		updateStatus(ctx);
	});
}
