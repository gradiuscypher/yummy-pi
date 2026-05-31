/**
 * Tmux Pane Extension for Pi
 *
 * Lets Pi drive other tmux panes (e.g. SSH remote sessions) via
 * tmux send-keys / capture-pane when explicitly armed by the user.
 *
 * Commands:
 *   /tmux-on [target]   - arm tmux pane access (auto-picks if exactly one other pane)
 *   /tmux-off           - disarm
 *   /tmux-target [tgt]  - change target pane without toggling
 *   /tmux-status        - show current armed/target info
 *   /tmux-config k v    - set maxBytes or maxLines for captures
 *
 * Tools (only usable when armed):
 *   tmux_list_panes   - enumerate all tmux panes
 *   tmux_send         - send literal keystrokes to target pane
 *   tmux_send_keys    - send named keys (C-c, Escape, Up, ...)
 *   tmux_capture      - capture pane content
 *   tmux_run          - send a command, wait for output, return captured result
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TmuxPaneState {
  armed: boolean;
  target: string | null;
  maxBytes: number;
  maxLines: number;
}

interface PaneInfo {
  id: string;
  session: string;
  window: string;
  display: string;
  command: string;
  title: string;
  active: boolean;
}

interface TmuxResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

const DEFAULT_MAX_BYTES = 8192;   // 8 KB
const DEFAULT_MAX_LINES = 500;
const ENTRY_CUSTOM_TYPE = "tmux-pane-state";
const TMUX_TOOLS = ["tmux_list_panes", "tmux_send", "tmux_send_keys", "tmux_capture", "tmux_run"];

// ---------------------------------------------------------------------------
// Tmux helpers
// ---------------------------------------------------------------------------

function tmux(args: string[], signal?: AbortSignal): Promise<TmuxResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("tmux", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (data: Buffer) => outChunks.push(data));
    child.stderr.on("data", (data: Buffer) => errChunks.push(data));
    child.on("error", reject);
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return reject(new Error("aborted"));
      resolve({
        stdout: Buffer.concat(outChunks).toString(),
        stderr: Buffer.concat(errChunks).toString(),
        code,
      });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeDiff(before: string, after: string): string {
  let i = 0;
  while (i < before.length && i < after.length && before[i] === after[i]) i++;
  return after.slice(i);
}

function truncateWithEllipsis(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf-8");
  if (buf.length <= maxBytes) return s;
  const ellipsis = Buffer.from("\n\n[... output truncated ...]\n");
  const cutoff = maxBytes - ellipsis.length;
  if (cutoff <= 0) return "[...]";
  // Try to cut at a UTF-8 boundary
  let end = cutoff;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf-8") + ellipsis.toString();
}

function getOwnPaneId(): string | null {
  return process.env.TMUX_PANE ?? null;
}

function inTmux(): boolean {
  return !!process.env.TMUX;
}

async function assertTmuxAvailable(): Promise<void> {
  if (!inTmux()) {
    throw new Error("Not inside a tmux session. Start Pi within tmux to use this extension.");
  }
  try {
    await tmux(["list-panes"], undefined);
  } catch {
    throw new Error("tmux command not available. Is tmux installed and on PATH?");
  }
}

// ---------------------------------------------------------------------------
// Pane discovery & resolution
// ---------------------------------------------------------------------------

async function listAllPanes(): Promise<PaneInfo[]> {
  const fmt = [
    "#{session_name}",
    "#{window_index}",
    "#{pane_index}",
    "#{pane_id}",
    "#{pane_current_command}",
    "#{pane_title}",
    "#{pane_active}",
  ].join("|");
  const r = await tmux(["list-panes", "-a", "-F", fmt]);
  if (r.code !== 0 || !r.stdout.trim()) return [];
  return r.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [session, windowIdx, paneIdx, id, command, title, active] = line.split("|");
      return {
        id,
        session,
        window: windowIdx,
        display: `${session}:${windowIdx}.${paneIdx}`,
        command: command || "?",
        title: title || "",
        active: active === "1",
      };
    });
}

async function resolvePaneInfo(target: string): Promise<PaneInfo | null> {
  try {
    const fmt = [
      "#{session_name}",
      "#{window_index}",
      "#{pane_index}",
      "#{pane_id}",
      "#{pane_current_command}",
      "#{pane_title}",
      "#{pane_active}",
    ].join("|");
    const r = await tmux(["display-message", "-p", "-t", target, fmt]);
    if (r.code !== 0) return null;
    const [session, windowIdx, paneIdx, id, command, title, active] = r.stdout.trim().split("|");
    if (!id) return null;
    return {
      id,
      session,
      window: windowIdx,
      display: `${session}:${windowIdx}.${paneIdx}`,
      command: command || "?",
      title: title || "",
      active: active === "1",
    };
  } catch {
    return null;
  }
}

function assertNotOwnPane(target: string): void {
  const own = getOwnPaneId();
  if (own && target === own) {
    throw new Error(`Refusing to target Pi's own pane (${own}). Pick a different pane.`);
  }
  // Also check if target resolves to own pane id
  // (e.g. "mysess:1.0" might be the same as "%12")
}

async function resolveTargetNotOwn(target: string): Promise<string> {
  const own = getOwnPaneId();
  // Fast path: literal match
  if (own && target === own) {
    throw new Error(`Refusing to target Pi's own pane (${own}). Pick a different pane.`);
  }
  // Resolve pane_id from display name
  try {
    const r = await tmux(["display-message", "-p", "-t", target, "#{pane_id}"]);
    if (r.code === 0 && r.stdout.trim()) {
      const resolved = r.stdout.trim();
      if (own && resolved === own) {
        throw new Error(`Refusing to target Pi's own pane (${own}). Pick a different pane.`);
      }
      return resolved;
    }
  } catch {
    // Fall through
  }
  // If we can't resolve, treat target as-is and let tmux error handle it
  return target;
}

async function getCurrentPaneCommand(target: string): Promise<string> {
  try {
    const r = await tmux(["display-message", "-p", "-t", target, "#{pane_current_command}"]);
    return r.stdout.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Send-keys helpers
// ---------------------------------------------------------------------------

const NAMED_KEYS: Record<string, string> = {
  escape: "Escape",
  esc: "Escape",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  backspace: "BSpace",
  bspace: "BSpace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  ins: "Insert",
  home: "Home",
  end: "End",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  pageup: "PageUp",
  pgup: "PageUp",
  pagedown: "PageDown",
  pgdn: "PageDown",
  f1: "F1",
  f2: "F2",
  f3: "F3",
  f4: "F4",
  f5: "F5",
  f6: "F6",
  f7: "F7",
  f8: "F8",
  f9: "F9",
  f10: "F10",
  f11: "F11",
  f12: "F12",
  space: "Space",
  ctrl_space: "C-Space",
  "c-space": "C-Space",
};

function parseKeyCombination(raw: string): string {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();

  // Check named keys table first
  if (NAMED_KEYS[lower]) return NAMED_KEYS[lower];

  // Parse modifiers: C- M- S-
  const parts: string[] = [];
  let rest = trimmed;
  while (true) {
    const m = rest.match(/^(C|M|S|Ctrl|Alt|Shift)-/i);
    if (!m) break;
    const prefix = m[1].toLowerCase();
    if (prefix === "ctrl" || prefix === "c") parts.unshift("C");
    else if (prefix === "alt" || prefix === "m") parts.unshift("M");
    else if (prefix === "shift" || prefix === "s") parts.unshift("S");
    rest = rest.slice(m[0].length);
  }

  // The remaining part is the key
  if (rest.length === 1) {
    // Single character with modifiers
    parts.push(rest);
  } else if (rest.length > 1) {
    // Named key with modifiers
    const named = NAMED_KEYS[rest.toLowerCase()];
    if (named && named !== "C-Space") {
      // Use the named key directly (tmux modifier notation C-<named>, M-<named>)
      // But for C-c, we want "C-c", not C- then c
      if (parts.length === 1 && parts[0] === "C" && rest.length === 1) {
        return `C-${rest}`;
      }
    }
    parts.push(rest);
  }

  if (parts.length === 0) return trimmed;
  if (parts.length === 1) return parts[0];

  // Build modifier notation: e.g., C-Up, M-C-c
  // tmux expects modifiers before key: C-Up, M-C-c, etc.
  return parts.join("-");
}

async function sendLiteralText(target: string, text: string, signal?: AbortSignal): Promise<void> {
  // Use -l for literal mode (available since tmux 2.7)
  await tmux(["send-keys", "-t", target, "-l", "--", text], signal);
}

async function sendKey(target: string, key: string, signal?: AbortSignal): Promise<void> {
  await tmux(["send-keys", "-t", target, key], signal);
}

// ---------------------------------------------------------------------------
// Capture helpers
// ---------------------------------------------------------------------------

async function capturePane(
  target: string,
  opts: { scrollLines?: number; joinLines?: boolean },
  signal?: AbortSignal,
): Promise<string> {
  const args = ["capture-pane", "-p", "-t", target];
  if (opts.joinLines !== false) args.push("-J");
  if (opts.scrollLines) args.push("-S", `-${opts.scrollLines}`);
  const r = await tmux(args, signal);
  if (r.code !== 0) throw new Error(`capture-pane failed (code ${r.code}): ${r.stderr}`);
  return r.stdout;
}

// ---------------------------------------------------------------------------
// tmux_run implementation (send + poll + diff)
// ---------------------------------------------------------------------------

async function tmuxRun(
  target: string,
  command: string,
  opts: {
    waitFor?: string;
    timeoutMs: number;
    quietMs: number;
    maxBytes: number;
    maxLines: number;
  },
  signal?: AbortSignal,
): Promise<{
  output: string;
  bytes: number;
  lines: number;
  truncated: boolean;
  timedOut: boolean;
}> {
  // 1. Capture initial state
  const initial = await capturePane(target, { joinLines: true }, signal);
  // 2. Send the command
  await sendLiteralText(target, command, signal);
  await sendKey(target, "Enter", signal);

  // 3. Wait for output to start
  await sleep(opts.quietMs);

  // 4. Poll until stable or matched
  const deadline = Date.now() + opts.timeoutMs;
  const waitForRe = opts.waitFor ? new RegExp(opts.waitFor) : null;
  let lastCapture = initial;
  let waitedForStability = false;
  let matched = false;

  while (Date.now() < deadline) {
    // Check abort
    if (signal?.aborted) throw new Error("aborted");

    const current = await capturePane(target, { joinLines: true }, signal);

    if (waitForRe && !matched) {
      if (waitForRe.test(current)) {
        matched = true;
        // Don't break immediately - wait one more cycle for stability
      }
    }

    if (!waitedForStability) {
      waitedForStability = true;
    } else if (current === lastCapture) {
      break; // Stable
    }

    lastCapture = current;
    await sleep(opts.quietMs);
  }

  const timedOut = Date.now() >= deadline && !matched;

  // 5. Final capture
  const final = await capturePane(target, { joinLines: true }, signal);

  // 6. Diff
  let diff = computeDiff(initial, final);

  // If diff is empty (no new output), return empty result
  if (!diff.trim()) {
    return { output: "", bytes: 0, lines: 0, truncated: false, timedOut };
  }

  // 7. Truncate by lines and bytes
  let lines = diff.split("\n");
  let lineTruncated = false;
  if (lines.length > opts.maxLines) {
    lines = lines.slice(lines.length - opts.maxLines);
    lineTruncated = true;
    diff = "(showing last " + opts.maxLines + " lines)\n" + lines.join("\n");
  }

  let byteTruncated = false;
  const finalBuf = Buffer.from(diff, "utf-8");
  if (finalBuf.length > opts.maxBytes) {
    diff = truncateWithEllipsis(diff, opts.maxBytes);
    byteTruncated = true;
  }

  const resultBuf = Buffer.from(diff, "utf-8");

  return {
    output: diff,
    bytes: resultBuf.length,
    lines: diff.split("\n").length,
    truncated: lineTruncated || byteTruncated,
    timedOut,
  };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  let state: TmuxPaneState = {
    armed: false,
    target: null,
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  };

  function persistState() {
    pi.appendEntry(ENTRY_CUSTOM_TYPE, { ...state });
  }

  function updateStatus(ctx: { ui: { setStatus: (k: string, v: string) => void; theme: { fg: (s: string, t: string) => string } } }) {
    if (state.armed && state.target) {
      ctx.ui.setStatus("tmux", ctx.ui.theme.fg("accent", `tmux → ${state.target}`));
    } else {
      ctx.ui.setStatus("tmux", "");
    }
  }

  // -----------------------------------------------------------------------
  // CLI flag: --tmux-pane <target>
  // -----------------------------------------------------------------------

  pi.registerFlag("tmux-pane", {
    description: "Pre-arm tmux pane at launch: user@host or tmux target",
    type: "string",
  });

  // -----------------------------------------------------------------------
  // Slash commands
  // -----------------------------------------------------------------------

  pi.registerCommand("tmux-on", {
    description: "Arm tmux pane access (auto-pick or interactive picker)",
    getArgumentCompletions: async (_prefix: string) => {
      try {
        const panes = await listAllPanes();
        const own = getOwnPaneId();
        const others = panes.filter((p) => p.id !== own);
        return others.map((p) => ({
          value: p.id,
          label: `${p.display}  ${p.command}  ${p.title || ""}`,
        }));
      } catch {
        return null;
      }
    },
    handler: async (args, ctx) => {
      try {
        await assertTmuxAvailable();
      } catch (e: any) {
        ctx.ui.notify(e.message, "error");
        return;
      }

      if (args) {
        // Explicit target
        const resolved = await resolveTargetNotOwn(args.trim());
        state.armed = true;
        state.target = resolved;
        persistState();
        updateStatus(ctx);
        const info = await resolvePaneInfo(resolved);
        const label = info ? `${info.display} (${info.command})` : resolved;
        ctx.ui.notify(`tmux pane armed → ${label}`, "info");
        return;
      }

      // Auto-detect or picker
      const own = getOwnPaneId();
      const panes = await listAllPanes();
      const others = panes.filter((p) => p.id !== own);

      if (others.length === 0) {
        ctx.ui.notify("No other tmux panes found. Create another pane first.", "warning");
        return;
      }

      // If exactly one other pane in the current window, auto-pick it
      const ownInfo = own ? panes.find((p) => p.id === own) : null;
      if (ownInfo) {
        const sameWindow = others.filter(
          (p) => p.session === ownInfo.session && p.window === ownInfo.window,
        );
        if (sameWindow.length === 1 && others.length === 1) {
          const resolved = await resolveTargetNotOwn(sameWindow[0].id);
          state.armed = true;
          state.target = resolved;
          persistState();
          updateStatus(ctx);
          ctx.ui.notify(
            `tmux pane armed → ${sameWindow[0].display} (${sameWindow[0].command})`,
            "info",
          );
          return;
        }
      }

      // Interactive picker - show all panes
      const choices = others.map((p) => ({
        value: p.id,
        label: `${p.display}  ${p.command}  ${p.title || "(no title)"}`,
      }));
      const picked = await ctx.ui.select("Pick tmux pane to target:", choices);
      if (!picked) {
        ctx.ui.notify("tmux pane selection cancelled", "info");
        return;
      }

      const resolved = await resolveTargetNotOwn(picked);
      state.armed = true;
      state.target = resolved;
      persistState();
      updateStatus(ctx);
      const info = await resolvePaneInfo(resolved);
      const label = info ? `${info.display} (${info.command})` : resolved;
      ctx.ui.notify(`tmux pane armed → ${label}`, "info");
    },
  });

  pi.registerCommand("tmux-off", {
    description: "Disarm tmux pane access",
    handler: async (_args, ctx) => {
      state.armed = false;
      persistState();
      updateStatus(ctx);
      ctx.ui.notify("tmux pane disarmed", "info");
    },
  });

  pi.registerCommand("tmux-target", {
    description: "Change target pane without toggling armed state",
    getArgumentCompletions: async (_prefix: string) => {
      try {
        const panes = await listAllPanes();
        const own = getOwnPaneId();
        const others = panes.filter((p) => p.id !== own);
        return others.map((p) => ({
          value: p.id,
          label: `${p.display}  ${p.command}  ${p.title || ""}`,
        }));
      } catch {
        return null;
      }
    },
    handler: async (args, ctx) => {
      if (!args) {
        ctx.ui.notify("Usage: /tmux-target <target>", "warning");
        return;
      }

      try {
        await assertTmuxAvailable();
        const resolved = await resolveTargetNotOwn(args.trim());
        state.target = resolved;
        persistState();
        updateStatus(ctx);
        const info = await resolvePaneInfo(resolved);
        const label = info ? `${info.display} (${info.command})` : resolved;
        ctx.ui.notify(`tmux target changed → ${label}`, "info");
      } catch (e: any) {
        ctx.ui.notify(e.message, "error");
      }
    },
  });

  pi.registerCommand("tmux-status", {
    description: "Show current tmux pane status",
    handler: async (_args, ctx) => {
      if (!state.armed || !state.target) {
        ctx.ui.notify("tmux pane: disarmed", "info");
        return;
      }

      try {
        const info = await resolvePaneInfo(state.target);
        const cmd = await getCurrentPaneCommand(state.target);
        const lines = [
          `Armed:        yes`,
          `Target:       ${state.target}${info ? ` (${info.display})` : ""}`,
          `Command:      ${cmd}`,
          `Title:        ${info?.title || "(none)"}`,
          `Max bytes:    ${state.maxBytes}`,
          `Max lines:    ${state.maxLines}`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (e: any) {
        ctx.ui.notify(`tmux error: ${e.message}`, "error");
      }
    },
  });

  pi.registerCommand("tmux-config", {
    description: "Set capture limits: /tmux-config maxBytes 32768 | maxLines 2000",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      if (parts.length !== 2) {
        ctx.ui.notify("Usage: /tmux-config <maxBytes|maxLines> <number>", "warning");
        return;
      }
      const key = parts[0];
      const val = parseInt(parts[1], 10);
      if (isNaN(val) || val < 1) {
        ctx.ui.notify("Value must be a positive number", "warning");
        return;
      }
      if (key === "maxBytes") {
        state.maxBytes = val;
        persistState();
        ctx.ui.notify(`maxBytes set to ${val}`, "info");
      } else if (key === "maxLines") {
        state.maxLines = val;
        persistState();
        ctx.ui.notify(`maxLines set to ${val}`, "info");
      } else {
        ctx.ui.notify("Unknown key. Use maxBytes or maxLines.", "warning");
      }
    },
  });

  // -----------------------------------------------------------------------
  // Tools (registered but gated behind armed state)
  // -----------------------------------------------------------------------

  function resolveTarget(overrideTarget?: string): string {
    const tgt = overrideTarget ?? state.target;
    if (!tgt) throw new Error("No tmux target configured. Use /tmux-on <target> first.");
    assertNotOwnPane(tgt);
    return tgt;
  }

  function requireArmed(): void {
    if (!state.armed) {
      throw new Error("tmux pane access not enabled. Use /tmux-on to enable.");
    }
  }

  // --- tmux_list_panes ---

  pi.registerTool({
    name: "tmux_list_panes",
    label: "List Tmux Panes",
    description:
      "List all tmux panes across all sessions. Returns pane IDs, commands, titles. Requires tmux-pane to be enabled via /tmux-on.",
    promptSnippet:
      "tmux_list_panes — enumerate all tmux panes (id, session:window.pane, command, title)",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      requireArmed();
      try {
        await assertTmuxAvailable();
        const panes = await listAllPanes();
        const own = getOwnPaneId();
        const lines = panes.map((p) => {
          const marker = p.id === own ? " [PI]" : "";
          return `${p.id}  ${p.display}  ${p.command}  ${p.title || ""}${marker}`;
        });
        return {
          content: [{ type: "text", text: lines.join("\n") || "(no panes)" }],
          details: { panes, ownPaneId: own },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          details: { error: e.message },
          isError: true,
        };
      }
    },
  });

  // --- tmux_send ---

  pi.registerTool({
    name: "tmux_send",
    label: "Send to Tmux Pane",
    description:
      "Send literal keystrokes to a tmux pane. By default appends Enter after the text. Use enter=false to suppress. Requires tmux-pane to be enabled via /tmux-on.",
    promptSnippet:
      "tmux_send(text, target?) — send keystrokes to a tmux pane (appends Enter by default)",
    promptGuidelines: [
      "Use tmux_send to type text into the target tmux pane. Prefer tmux_run for simple commands that return output.",
    ],
    parameters: Type.Object({
      text: Type.String({ description: "Literal text to send to the pane" }),
      enter: Type.Optional(
        Type.Boolean({ default: true, description: "Send Enter after the text (default true)" }),
      ),
      target: Type.Optional(
        Type.String({ description: "Target pane ID (e.g. %12). Uses armed target if omitted." }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      requireArmed();
      try {
        await assertTmuxAvailable();
        const tgt = await resolveTargetNotOwn(params.target ? params.target : resolveTarget());
        await sendLiteralText(tgt, params.text, signal);
        if (params.enter !== false) {
          await sendKey(tgt, "Enter", signal);
        }
        return {
          content: [
            {
              type: "text",
              text: `Sent to ${tgt}: "${params.text}"${params.enter !== false ? " [Enter]" : ""}`,
            },
          ],
          details: { target: tgt, text: params.text, enter: params.enter !== false },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          details: { error: e.message },
          isError: true,
        };
      }
    },
  });

  // --- tmux_send_keys ---

  pi.registerTool({
    name: "tmux_send_keys",
    label: "Send Keys to Tmux Pane",
    description:
      "Send named keys to a tmux pane. Supports C-c, Escape, Up, Down, C-d, F1-F12, etc. Requires tmux-pane to be enabled via /tmux-on.",
    promptSnippet:
      "tmux_send_keys(keys, target?) — send named keys like C-c, Escape, Up to a tmux pane",
    promptGuidelines: [
      "Use tmux_send_keys for control sequences (C-c, C-d, Escape, arrows) that can't be sent as literal text.",
    ],
    parameters: Type.Object({
      keys: Type.Array(Type.String(), {
        description:
          "Key names to send: e.g. C-c, Escape, Up, Down, Tab, Enter, Backspace, C-d, F1-F12, Home, End, PageUp, PageDown",
      }),
      target: Type.Optional(
        Type.String({ description: "Target pane ID. Uses armed target if omitted." }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      requireArmed();
      try {
        await assertTmuxAvailable();
        const tgt = await resolveTargetNotOwn(params.target ? params.target : resolveTarget());
        const parsed = params.keys.map((k) => parseKeyCombination(k));
        for (const key of parsed) {
          await sendKey(tgt, key, signal);
        }
        return {
          content: [
            {
              type: "text",
              text: `Keys sent to ${tgt}: ${params.keys.join(" ")} → ${parsed.join(" ")}`,
            },
          ],
          details: { target: tgt, keys: params.keys, parsed },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          details: { error: e.message },
          isError: true,
        };
      }
    },
  });

  // --- tmux_capture ---

  pi.registerTool({
    name: "tmux_capture",
    label: "Capture Tmux Pane",
    description:
      "Capture visible content from a tmux pane. Optionally specify scrollback lines. Requires tmux-pane to be enabled via /tmux-on.",
    promptSnippet:
      "tmux_capture(target?, scrollLines?, maxBytes?, maxLines?) — capture tmux pane content",
    promptGuidelines: [
      "Use tmux_capture to read the current visible content of a tmux pane. Increase scrollLines to capture scrollback. Use maxBytes/maxLines to control output size.",
    ],
    parameters: Type.Object({
      target: Type.Optional(
        Type.String({ description: "Target pane ID. Uses armed target if omitted." }),
      ),
      scrollLines: Type.Optional(
        Type.Number({ description: "Number of scrollback lines to include (default: visible only)" }),
      ),
      maxBytes: Type.Optional(
        Type.Number({
          description:
            "Max output bytes for this call (default: session config, currently 8192)",
        }),
      ),
      maxLines: Type.Optional(
        Type.Number({
          description: "Max output lines for this call (default: session config, currently 500)",
        }),
      ),
      joinLines: Type.Optional(
        Type.Boolean({
          default: true,
          description: "Join wrapped lines into single lines (default true)",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      requireArmed();
      try {
        await assertTmuxAvailable();
        const tgt = await resolveTargetNotOwn(params.target ? params.target : resolveTarget());
        const raw = await capturePane(
          tgt,
          { scrollLines: params.scrollLines, joinLines: params.joinLines !== false },
          signal,
        );

        const maxB = params.maxBytes ?? state.maxBytes;
        const maxL = params.maxLines ?? state.maxLines;

        let lines = raw.split("\n");
        let lineTruncated = false;
        if (lines.length > maxL) {
          lines = lines.slice(lines.length - maxL);
          lineTruncated = true;
        }

        let output = lines.join("\n");
        if (lineTruncated) {
          output = `(showing last ${maxL} lines)\n${output}`;
        }

        let byteTruncated = false;
        const buf = Buffer.from(output, "utf-8");
        if (buf.length > maxB) {
          output = truncateWithEllipsis(output, maxB);
          byteTruncated = true;
        }

        const finalBuf = Buffer.from(output, "utf-8");
        return {
          content: [{ type: "text", text: output }],
          details: {
            target: tgt,
            bytes: finalBuf.length,
            lines: output.split("\n").length,
            totalBytes: Buffer.from(raw, "utf-8").length,
            totalLines: raw.split("\n").length,
            truncated: lineTruncated || byteTruncated,
          },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          details: { error: e.message },
          isError: true,
        };
      }
    },
  });

  // --- tmux_run ---

  pi.registerTool({
    name: "tmux_run",
    label: "Run in Tmux Pane",
    description:
      "Send a command to a tmux pane, wait for output to settle, and return the captured result. This is the primary tool for remote administration. The command is typed literally and Enter is pressed. Output is diffed from pre-command state so only new output is returned. Requires tmux-pane to be enabled via /tmux-on.",
    promptSnippet:
      "tmux_run(command, waitFor?, timeoutMs?, quietMs?, maxBytes?, maxLines?, target?) — send a command and capture its output",
    promptGuidelines: [
      "Use tmux_run as the primary tool for running commands in the target tmux pane (e.g. SSH remote host). It sends the command, waits for output to finish, and returns the captured result. For interactive flows, combine tmux_send and tmux_capture instead.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Command to run in the target pane" }),
      waitFor: Type.Optional(
        Type.String({
          description:
            "Regex pattern to wait for before capturing (e.g. 'password:' for sudo prompts). If unset, waits for output to settle.",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({
          default: 15000,
          description: "Max time to wait for output in milliseconds (default 15000)",
        }),
      ),
      quietMs: Type.Optional(
        Type.Number({
          default: 500,
          description: "Milliseconds of no new output before considering settled (default 500)",
        }),
      ),
      maxBytes: Type.Optional(
        Type.Number({
          description:
            "Max output bytes for this call (default: session config)",
        }),
      ),
      maxLines: Type.Optional(
        Type.Number({
          description: "Max output lines for this call (default: session config)",
        }),
      ),
      target: Type.Optional(
        Type.String({ description: "Target pane ID. Uses armed target if omitted." }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      requireArmed();
      try {
        await assertTmuxAvailable();
        const tgt = await resolveTargetNotOwn(params.target ? params.target : resolveTarget());

        const result = await tmuxRun(
          tgt,
          params.command,
          {
            waitFor: params.waitFor,
            timeoutMs: params.timeoutMs ?? 15000,
            quietMs: params.quietMs ?? 500,
            maxBytes: params.maxBytes ?? state.maxBytes,
            maxLines: params.maxLines ?? state.maxLines,
          },
          signal,
        );

        const summary =
          result.output.length > 0
            ? `${result.bytes} bytes, ${result.lines} lines${result.truncated ? " (truncated)" : ""}${result.timedOut ? " (timed out)" : ""}`
            : "no output";

        return {
          content: [
            {
              type: "text",
              text:
                `Command: ${params.command}\nTarget: ${tgt}\n\n` +
                (result.output || "(no output)"),
            },
          ],
          details: {
            target: tgt,
            command: params.command,
            bytes: result.bytes,
            lines: result.lines,
            truncated: result.truncated,
            timedOut: result.timedOut,
          },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          details: { error: e.message },
          isError: true,
        };
      }
    },
  });

  // -----------------------------------------------------------------------
  // Event handlers
  // -----------------------------------------------------------------------

  // Restore state on session start
  pi.on("session_start", async (_event, ctx) => {
    // Check --tmux-pane flag for pre-arming
    const flagTarget = pi.getFlag("tmux-pane") as string | undefined;
    if (flagTarget) {
      try {
        await assertTmuxAvailable();
        const resolved = await resolveTargetNotOwn(flagTarget);
        state.armed = true;
        state.target = resolved;
        persistState();
        updateStatus(ctx);
        const info = await resolvePaneInfo(resolved);
        const label = info ? `${info.display} (${info.command})` : resolved;
        ctx.ui.notify(`tmux pane pre-armed → ${label}`, "info");
      } catch (e: any) {
        ctx.ui.notify(`--tmux-pane: ${e.message}`, "error");
      }
      return;
    }

    // Restore persisted state
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "custom" && entry.customType === ENTRY_CUSTOM_TYPE) {
        const data = entry.data as TmuxPaneState;
        if (data && typeof data.armed === "boolean") {
          state = {
            armed: data.armed,
            target: data.target ?? null,
            maxBytes: data.maxBytes ?? DEFAULT_MAX_BYTES,
            maxLines: data.maxLines ?? DEFAULT_MAX_LINES,
          };
        }
        break;
      }
    }
    updateStatus(ctx);
  });

  // Block tmux tools when disarmed (defense-in-depth)
  pi.on("tool_call", async (event) => {
    if (TMUX_TOOLS.includes(event.toolName)) {
      if (!state.armed) {
        return { block: true, reason: "tmux pane access not enabled. Use /tmux-on to enable." };
      }
    }
  });

  // Inject system prompt addendum only when armed
  pi.on("before_agent_start", async (event) => {
    if (!state.armed || !state.target) return;

    let currentCommand = "unknown";
    try {
      currentCommand = await getCurrentPaneCommand(state.target);
    } catch {
      // ignore
    }

    const addendum = [
      "",
      "## Tmux Remote Pane",
      "",
      `A tmux pane is attached for remote/system administration: target \`${state.target}\` (current command: \`${currentCommand}\`).`,
      "",
      "Available tmux tools:",
      "- `tmux_run` — Send a command, wait for output, return captured result. **Prefer this for one-shot commands.**",
      "- `tmux_send` — Type literal text into the pane (default: appends Enter). Use for interactive input.",
      "- `tmux_send_keys` — Send control keys (C-c, Escape, arrows, etc.). Use for interrupting or navigating.",
      "- `tmux_capture` — Read the current visible pane content. Optionally include scrollback.",
      "- `tmux_list_panes` — Enumerate all tmux panes.",
      "",
      `Default capture limits: ${state.maxBytes} bytes / ${state.maxLines} lines. Override per-call via \`maxBytes\` / \`maxLines\` parameters on tmux_capture and tmux_run.`,
      "",
      "Guidelines:",
      "- **The target pane is NOT Pi itself** — it's a separate terminal (e.g. SSH session on a remote host).",
      "- Do not run destructive commands (rm -rf, shutdown, etc.) without confirming with the user.",
      "- For commands that prompt (sudo, interactive tools), use `tmux_send` to reply, then `tmux_capture` to check results.",
      "- If output is truncated, increase `maxBytes`/`maxLines` and re-run the capture.",
    ].join("\n");

    return { systemPrompt: event.systemPrompt + addendum };
  });

  // Update status on model change / reload
  pi.on("model_select", async (_event, ctx) => {
    updateStatus(ctx);
  });
}
