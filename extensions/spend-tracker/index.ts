/**
 * Stats Tracker Extension
 *
 * Tracks model spend (cost) and full token usage metadata across all
 * providers and models. Persists historical data across sessions.
 *
 * Commands:
 *   /stats            - Current session stats + all-time summary
 *   /stats all        - All-time stats across every session
 *   /stats models     - Per-model cost, token breakdown, and request count
 *   /stats sessions   - Per-session cost, token breakdown, and date
 *   /stats reset      - Wipe all tracking data (with confirmation)
 *
 * Alias: /spend (legacy)
 *
 * Status bar: current-session cost + input/output token counts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text } from "@earendil-works/pi-tui";

// ── Types ──────────────────────────────────────────────────────────────

interface SessionSpend {
  sessionId: string;
  sessionFile: string | null;
  cwd: string;
  startedAt: string;
  lastUpdatedAt: string;
  entries: SpendEntry[];
}

interface SpendEntry {
  timestamp: string;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
  };
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

/** Accumulated token + cost breakdown for aggregation views. */
interface TokenAggregate {
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  tokensTotal: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  costTotal: number;
}

interface SpendDatabase {
  version: 1;
  totalSessions: number;
  totalEntries: number;
  grandTotalCost: number;
  grandTotalTokens: number;
  byModel: Record<string, Record<string, TokenAggregate>>;
  byProvider: Record<string, TokenAggregate>;
  sessions: Record<string, SessionSpend>;
}

// ── Helpers ────────────────────────────────────────────────────────────

const SPEND_DIR = (() => {
  const base =
    process.env.PI_CODING_AGENT_DIR ||
    path.join(process.env.HOME || "~", ".pi", "agent");
  return path.join(base, "spend");
})();
const DB_PATH = path.join(SPEND_DIR, "spend.json");

function ensureDir(): void {
  fs.mkdirSync(SPEND_DIR, { recursive: true });
}

function loadDb(): SpendDatabase {
  try {
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const db = JSON.parse(raw) as SpendDatabase;
    return migrate(db);
  } catch {
    return emptyDb();
  }
}

/** Convert old-format aggregates (flat input/output/… keys) to new-format TokenAggregate. */
function migrate(db: SpendDatabase): SpendDatabase {
  let changed = false;

  function upgrade(agg: Record<string, any>): boolean {
    let dirty = false;

    // If old flat keys exist, merge their values into the new-format keys
    if (agg.input !== undefined) {
      agg.tokensInput = (agg.tokensInput ?? 0) + (agg.input ?? 0);
      agg.tokensOutput = (agg.tokensOutput ?? 0) + (agg.output ?? 0);
      agg.tokensCacheRead = (agg.tokensCacheRead ?? 0) + (agg.cacheRead ?? 0);
      agg.tokensCacheWrite = (agg.tokensCacheWrite ?? 0) + (agg.cacheWrite ?? 0);
      agg.tokensTotal = (agg.tokensTotal ?? 0) + (agg.totalTokens ?? 0);
      agg.costTotal = (agg.costTotal ?? 0) + (agg.total ?? 0);
      // costInput/output/cache* breakdown unavailable from old format —
      // we preserve the total and zero the breakdown.
      agg.costInput ??= 0;
      agg.costOutput ??= 0;
      agg.costCacheRead ??= 0;
      agg.costCacheWrite ??= 0;
      dirty = true;
    }

    // Clean up orphaned old-format keys
    for (const k of ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "total"]) {
      if (k in agg) {
        delete agg[k];
        dirty = true;
      }
    }

    return dirty;
  }

  for (const agg of Object.values(db.byProvider)) {
    if (upgrade(agg as any)) changed = true;
  }
  for (const models of Object.values(db.byModel)) {
    for (const agg of Object.values(models)) {
      if (upgrade(agg as any)) changed = true;
    }
  }

  if (changed) saveDb(db);
  return db;
}

function emptyDb(): SpendDatabase {
  return {
    version: 1,
    totalSessions: 0,
    totalEntries: 0,
    grandTotalCost: 0,
    grandTotalTokens: 0,
    byModel: {},
    byProvider: {},
    sessions: {},
  };
}

function saveDb(db: SpendDatabase): void {
  ensureDir();
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

function emptyAggregate(): TokenAggregate {
  return {
    tokensInput: 0,
    tokensOutput: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    tokensTotal: 0,
    costInput: 0,
    costOutput: 0,
    costCacheRead: 0,
    costCacheWrite: 0,
    costTotal: 0,
  };
}

function addAggregate(target: TokenAggregate, entry: SpendEntry): void {
  target.tokensInput += entry.usage.input;
  target.tokensOutput += entry.usage.output;
  target.tokensCacheRead += entry.usage.cacheRead;
  target.tokensCacheWrite += entry.usage.cacheWrite;
  target.tokensTotal += entry.usage.totalTokens;
  target.costInput += entry.cost.input;
  target.costOutput += entry.cost.output;
  target.costCacheRead += entry.cost.cacheRead;
  target.costCacheWrite += entry.cost.cacheWrite;
  target.costTotal += entry.cost.total;
}

// ── Formatting ─────────────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${String(n)}`;
}

function fmtCost(n: number): string {
  return `$${n.toFixed(4)}`;
}

function fmtTokenShorthand(
  input: number,
  output: number,
  cache: number,
): string {
  return `${fmtTokens(input)}↑ ${fmtTokens(output)}↓ ${fmtTokens(cache)}Δ`;
}

function fmtTokenFull(a: TokenAggregate): string {
  return (
    `${fmtTokens(a.tokensInput)}↑ / ${fmtTokens(a.tokensOutput)}↓ / ` +
    `${fmtTokens(a.tokensCacheRead)}r / ${fmtTokens(a.tokensCacheWrite)}w`
  );
}

function fmtCostFull(a: TokenAggregate): string {
  return (
    `${fmtCost(a.costInput)} in + ${fmtCost(a.costOutput)} out + ` +
    `${fmtCost(a.costCacheRead)} cr + ${fmtCost(a.costCacheWrite)} cw`
  );
}

function fmtPercent(part: number, total: number): string {
  if (total === 0) return "  0.0%";
  return `${((part / total) * 100).toFixed(1).padStart(5)}%`;
}

function isoNow(): string {
  return new Date().toISOString();
}

function padR(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function padL(s: string, w: number): string {
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

// ── Read-only popup window ────────────────────────────────────────────

async function showStatsWindow(
  ctx: ExtensionCommandContext,
  title: string,
  lines: string[],
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify([title, ...lines].join("\n"), "info");
    return;
  }

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const container = new Container();
    const border = new DynamicBorder((s: string) => theme.fg("accent", s));

    container.addChild(border);
    container.addChild(
      new Text(theme.fg("accent", theme.bold(`📊 ${title}`)), 1, 0),
    );
    container.addChild(new Text(lines.join("\n"), 1, 1));
    container.addChild(
      new Text(theme.fg("dim", "Press Enter or Esc to close"), 1, 0),
    );
    container.addChild(border);

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
          done(undefined);
        }
      },
    };
  });
}

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── In-memory state ──────────────────────────────────────────────

  let currentProvider = "";
  let currentModel = "";
  let sessionId = "";
  let sessionCwd = "";
  let currentSessionCost = 0;
  let currentSessionTokens = 0;
  const sessionEntries: SpendEntry[] = [];

  // ── Status bar ───────────────────────────────────────────────────

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const theme = ctx.ui.theme;
    const costStr = theme.fg("accent", fmtCost(currentSessionCost));
    const tokIn = fmtTokens(
      sessionEntries.reduce((s, e) => s + e.usage.input, 0),
    );
    const tokOut = fmtTokens(
      sessionEntries.reduce((s, e) => s + e.usage.output, 0),
    );
    ctx.ui.setStatus("stats", `📊 ${costStr}  ↑${tokIn} ↓${tokOut}`);
  }

  // ── Persistence ──────────────────────────────────────────────────

  function persistSession(db: SpendDatabase): void {
    if (!sessionId) return;

    // Ensure session record exists + count new sessions
    if (!db.sessions[sessionId]) {
      db.sessions[sessionId] = {
        sessionId,
        sessionFile: null,
        cwd: sessionCwd,
        startedAt: isoNow(),
        lastUpdatedAt: isoNow(),
        entries: [],
      };
      db.totalSessions++;
    }

    const existing = db.sessions[sessionId];
    const existingIds = new Set(existing.entries.map((e) => e.timestamp));
    let added = 0;

    for (const entry of sessionEntries) {
      if (!existingIds.has(entry.timestamp)) {
        existing.entries.push(entry);
        existing.lastUpdatedAt = isoNow();

        db.byModel[entry.provider] ??= {};
        db.byModel[entry.provider][entry.model] ??= emptyAggregate();
        addAggregate(db.byModel[entry.provider][entry.model], entry);

        db.byProvider[entry.provider] ??= emptyAggregate();
        addAggregate(db.byProvider[entry.provider], entry);

        db.grandTotalCost += entry.cost.total;
        db.grandTotalTokens += entry.usage.totalTokens;
        db.totalEntries++;
        added++;
      }
    }

    if (added > 0) saveDb(db);
  }

  // ── Events ───────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    sessionCwd = ctx.cwd;

    if (ctx.model) {
      currentProvider = ctx.model.provider;
      currentModel = ctx.model.id;
    }

    const db = loadDb();
    if (db.sessions[sessionId]) {
      db.sessions[sessionId].sessionFile =
        ctx.sessionManager.getSessionFile() ?? null;
      saveDb(db);
    }

    updateStatus(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    currentProvider = event.model.provider;
    currentModel = event.model.id;
    updateStatus(ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    const msg = event.message as AssistantMessage;
    if (!msg.usage || !msg.usage.cost) return;
    if (msg.usage.totalTokens === 0 && msg.usage.cost.total === 0) return;

    const entry: SpendEntry = {
      timestamp: new Date(msg.timestamp).toISOString(),
      provider: msg.provider,
      model: msg.model,
      usage: {
        input: msg.usage.input,
        output: msg.usage.output,
        cacheRead: msg.usage.cacheRead,
        cacheWrite: msg.usage.cacheWrite,
        totalTokens: msg.usage.totalTokens,
      },
      cost: {
        input: msg.usage.cost.input,
        output: msg.usage.cost.output,
        cacheRead: msg.usage.cost.cacheRead,
        cacheWrite: msg.usage.cost.cacheWrite,
        total: msg.usage.cost.total,
      },
    };

    sessionEntries.push(entry);
    currentSessionCost += entry.cost.total;
    currentSessionTokens += entry.usage.totalTokens;

    const db = loadDb();
    persistSession(db);
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    if (sessionEntries.length > 0) {
      const db = loadDb();
      persistSession(db);
    }
  });

  // ── Display helpers ──────────────────────────────────────────────

  function buildAllTimeSummary(db: SpendDatabase): string[] {
    const lines: string[] = [];

    if (db.totalEntries === 0) {
      lines.push("No stats recorded yet.");
      return lines;
    }

    lines.push(
      `All-time: ${fmtCost(db.grandTotalCost)}  ·  ` +
        `${fmtTokens(db.grandTotalTokens)} tokens  ·  ` +
        `${db.totalEntries} requests  ·  ${db.totalSessions} sessions`,
    );
    lines.push("");

    // ── By provider ──
    lines.push("─── By Provider ───");
    const providers = Object.entries(db.byProvider).sort(
      (a, b) => b[1].costTotal - a[1].costTotal,
    );
    for (const [provider, agg] of providers) {
      const pct = fmtPercent(agg.costTotal, db.grandTotalCost);
      const tok = fmtTokenFull(agg);
      lines.push(
        `  ${padR(provider, 16)} ${padL(fmtCost(agg.costTotal), 10)} ${pct}  ${tok}`,
      );
    }

    lines.push("");

    // ── By model ──
    lines.push("─── By Model ───");
    const models: Array<{
      provider: string;
      model: string;
      agg: TokenAggregate;
    }> = [];
    for (const [provider, models_] of Object.entries(db.byModel)) {
      for (const [model, agg] of Object.entries(models_)) {
        models.push({ provider, model, agg });
      }
    }
    models.sort((a, b) => b.agg.costTotal - a.agg.costTotal);

    for (const { provider, model, agg } of models) {
      const pct = fmtPercent(agg.costTotal, db.grandTotalCost);
      const tok = fmtTokenFull(agg);
      lines.push(
        `  ${padR(`${provider}/${model}`, 32)} ${padL(fmtCost(agg.costTotal), 10)} ${pct}  ${tok}`,
      );
    }

    return lines;
  }

  function buildModelBreakdown(db: SpendDatabase): string[] {
    const lines: string[] = [];
    const models: Array<{
      provider: string;
      model: string;
      agg: TokenAggregate;
    }> = [];

    for (const [provider, models_] of Object.entries(db.byModel)) {
      for (const [model, agg] of Object.entries(models_)) {
        models.push({ provider, model, agg });
      }
    }
    models.sort((a, b) => b.agg.costTotal - a.agg.costTotal);

    if (models.length === 0) {
      lines.push("No model stats recorded.");
      return lines;
    }

    // Header
    lines.push(
      "Model                          Cost          Input      Output     Cache Rd   Cache Wr   Tokens     Reqs",
    );
    lines.push(
      "────────────────────────────────────────────────────────────────────────────────────────────────────────",
    );
    for (const { provider, model, agg } of models) {
      let reqs = 0;
      for (const s of Object.values(db.sessions)) {
        reqs += s.entries.filter(
          (e) => e.provider === provider && e.model === model,
        ).length;
      }
      lines.push(
        `${padR(`${provider}/${model}`, 30)} ` +
          `${padL(fmtCost(agg.costTotal), 10)}  ` +
          `${padL(fmtTokens(agg.tokensInput), 9)}  ` +
          `${padL(fmtTokens(agg.tokensOutput), 9)}  ` +
          `${padL(fmtTokens(agg.tokensCacheRead), 9)}  ` +
          `${padL(fmtTokens(agg.tokensCacheWrite), 9)}  ` +
          `${padL(fmtTokens(agg.tokensTotal), 9)}  ` +
          `${padL(String(reqs), 4)}`,
      );
    }

    return lines;
  }

  function buildSessionBreakdown(db: SpendDatabase): string[] {
    const lines: string[] = [];
    const sessions = Object.values(db.sessions).sort(
      (a, b) =>
        new Date(b.lastUpdatedAt).getTime() -
        new Date(a.lastUpdatedAt).getTime(),
    );

    if (sessions.length === 0) {
      lines.push("No sessions recorded.");
      return lines;
    }

    lines.push(
      "Cost          Input      Output     CacheR     CacheW     Tokens     Reqs  Date        Project",
    );
    lines.push(
      "──────────────────────────────────────────────────────────────────────────────────────────",
    );
    for (const s of sessions) {
      const cost = s.entries.reduce((sum, e) => sum + e.cost.total, 0);
      const in_ = s.entries.reduce((sum, e) => sum + e.usage.input, 0);
      const out = s.entries.reduce((sum, e) => sum + e.usage.output, 0);
      const cr = s.entries.reduce((sum, e) => sum + e.usage.cacheRead, 0);
      const cw = s.entries.reduce((sum, e) => sum + e.usage.cacheWrite, 0);
      const tok = s.entries.reduce((sum, e) => sum + e.usage.totalTokens, 0);
      const date = new Date(s.lastUpdatedAt).toLocaleDateString();
      const cwdShort = s.cwd.split("/").slice(-2).join("/") || s.cwd;

      lines.push(
        `${padL(fmtCost(cost), 10)}  ` +
          `${padL(fmtTokens(in_), 9)}  ` +
          `${padL(fmtTokens(out), 9)}  ` +
          `${padL(fmtTokens(cr), 9)}  ` +
          `${padL(fmtTokens(cw), 9)}  ` +
          `${padL(fmtTokens(tok), 9)}  ` +
          `${padL(String(s.entries.length), 4)}  ` +
          `${date}  ${cwdShort}`,
      );
    }

    return lines;
  }

  function buildCurrentSession(): string[] {
    if (sessionEntries.length === 0) {
      return ["No stats recorded in this session yet."];
    }

    const sIn = sessionEntries.reduce((s, e) => s + e.usage.input, 0);
    const sOut = sessionEntries.reduce((s, e) => s + e.usage.output, 0);
    const sCacheR = sessionEntries.reduce((s, e) => s + e.usage.cacheRead, 0);
    const sCacheW = sessionEntries.reduce((s, e) => s + e.usage.cacheWrite, 0);
    const sTok = sessionEntries.reduce((s, e) => s + e.usage.totalTokens, 0);
    const sCostIn = sessionEntries.reduce((s, e) => s + e.cost.input, 0);
    const sCostOut = sessionEntries.reduce((s, e) => s + e.cost.output, 0);
    const sCostCache = sessionEntries.reduce(
      (s, e) => s + e.cost.cacheRead + e.cost.cacheWrite,
      0,
    );

    return [
      "─── Current Session ───",
      `  Requests: ${sessionEntries.length}`,
      "",
      `  Cost:    ${fmtCost(currentSessionCost)}`,
      `           (${fmtCost(sCostIn)} input + ${fmtCost(sCostOut)} output + ${fmtCost(sCostCache)} cache)`,
      "",
      `  Tokens:  ${fmtTokens(sTok)}`,
      `           ↑${fmtTokens(sIn)} input  ↓${fmtTokens(sOut)} output  ↗${fmtTokens(sCacheR)} cache read  ↘${fmtTokens(sCacheW)} cache write`,
    ];
  }

  // ── Commands ─────────────────────────────────────────────────────

  function registerStatsCommand(name: string) {
    pi.registerCommand(name, {
      description: "Show model spend & token stats",
      getArgumentCompletions: (prefix) => {
        const subs = ["all", "models", "sessions", "reset"];
        const filtered = subs.filter((s) => s.startsWith(prefix));
        return filtered.length > 0
          ? filtered.map((s) => ({ value: s, label: s }))
          : null;
      },
      handler: async (args, ctx) => {
        const sub = args.trim();
        const db = loadDb();

        if (sub === "reset") {
          const ok = await ctx.ui.confirm(
            "Reset Stats",
            "Delete ALL tracking data across every session? This cannot be undone.",
          );
          if (ok) {
            saveDb(emptyDb());
            currentSessionCost = 0;
            currentSessionTokens = 0;
            sessionEntries.length = 0;
            ctx.ui.notify("Stats reset.", "info");
            updateStatus(ctx);
          }
          return;
        }

        let title: string;
        let items: string[];

        switch (sub) {
          case "all":
            title = "All-Time Stats";
            items = buildAllTimeSummary(db);
            break;
          case "models":
            title = "Stats by Model";
            items = buildModelBreakdown(db);
            break;
          case "sessions":
            title = "Stats by Session";
            items = buildSessionBreakdown(db);
            break;
          default:
            title = "Stats";
            items = [
              ...buildCurrentSession(),
              "",
              ...buildAllTimeSummary(db),
            ];
        }

        await showStatsWindow(ctx, title, items);
      },
    });
  }

  registerStatsCommand("stats");
  registerStatsCommand("spend"); // legacy alias
}
