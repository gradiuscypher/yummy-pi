/**
 * Conversation ID Extension
 *
 * Generates a UUIDv4 per session and attaches it as an X-Conversation-Id
 * header on outgoing provider requests. Default target is openrouter;
 * other providers can be opted in via /conversation-id-providers.
 *
 * Commands:
 *   /conversation-id-show       - print current ID and enabled providers
 *   /conversation-id-set [id]   - pin a static ID, or clear and regenerate
 *   /conversation-id-providers  - list / add / remove enabled providers
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENTRY_CUSTOM_TYPE = "conversation-id-state";
const HEADER_NAME = "X-Conversation-Id";
const DEFAULT_PROVIDERS = ["openrouter"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PersistedState {
  currentId: string;
  staticOverride: string | null;
  enabledProviders: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  let currentId: string = generateId();
  let staticOverride: string | null = null;
  let enabledProviders: Set<string> = new Set(DEFAULT_PROVIDERS);

  function persist() {
    pi.appendEntry(ENTRY_CUSTOM_TYPE, {
      currentId,
      staticOverride,
      enabledProviders: [...enabledProviders],
    } satisfies PersistedState);
  }

  function applyHeader(providerName: string, id: string) {
    pi.registerProvider(providerName, {
      headers: { [HEADER_NAME]: id },
    });
  }

  function applyAll(id: string) {
    for (const provider of enabledProviders) {
      applyHeader(provider, id);
    }
  }

  function updateStatus(ctx: {
    ui: {
      setStatus: (k: string, v: string) => void;
      theme: { fg: (s: string, t: string) => string };
    };
  }) {
    ctx.ui.setStatus(
      "conversation-id",
      ctx.ui.theme.fg("muted", `conv:${currentId.slice(0, 8)}`),
    );
  }

  function setProviders(set: Set<string>) {
    enabledProviders = set;
    persist();
    applyAll(currentId);
  }

  // -----------------------------------------------------------------------
  // Event: session_start
  // -----------------------------------------------------------------------

  pi.on("session_start", async (event, ctx) => {
    // Restore persisted state
    let restored: PersistedState | null = null;
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "custom" && entry.customType === ENTRY_CUSTOM_TYPE) {
        const data = entry.data as PersistedState;
        if (data && typeof data.currentId === "string") {
          restored = data;
        }
        break;
      }
    }

    if (restored) {
      enabledProviders = new Set(
        restored.enabledProviders && restored.enabledProviders.length > 0
          ? restored.enabledProviders
          : DEFAULT_PROVIDERS,
      );
    }

    // Determine ID per lifecycle
    const reason = event.reason;
    if (reason === "new") {
      // New session: clear override, generate fresh
      staticOverride = null;
      currentId = generateId();
      persist();
    } else if (reason === "fork") {
      // Fork: new conversation = new ID (clear override too)
      staticOverride = null;
      currentId = generateId();
      persist();
    } else if (reason === "resume" || reason === "reload") {
      // Resume/reload: keep restored ID
      if (restored) {
        currentId = restored.currentId;
        staticOverride = restored.staticOverride ?? null;
      }
      // If somehow no restored state, generate and persist
      if (!restored) {
        persist();
      }
    } else {
      // "startup": restore if present, else generate
      if (restored) {
        currentId = restored.currentId;
        staticOverride = restored.staticOverride ?? null;
      } else {
        persist();
      }
    }

    // Apply header to all enabled providers
    applyAll(currentId);
    updateStatus(ctx);
  });

  // -----------------------------------------------------------------------
  // Commands
  // -----------------------------------------------------------------------

  pi.registerCommand("conversation-id-show", {
    description: "Show current conversation ID and enabled providers",
    handler: async (_args, ctx) => {
      const lines = [
        `Conversation ID: ${currentId}`,
        `Static override: ${staticOverride ?? "(none)"}`,
        `Enabled providers: ${[...enabledProviders].join(", ") || "(none)"}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("conversation-id-set", {
    description:
      "Set a static conversation ID for testing (/conversation-id-set <id>). Call with no arg to clear and regenerate.",
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();

      if (!trimmed) {
        // Clear override, regenerate
        staticOverride = null;
        currentId = generateId();
        persist();
        applyAll(currentId);
        updateStatus(ctx);
        ctx.ui.notify(`Override cleared. New ID: ${currentId}`, "info");
        return;
      }

      // Pin static ID
      staticOverride = trimmed;
      currentId = trimmed;
      persist();
      applyAll(currentId);
      updateStatus(ctx);
      ctx.ui.notify(`Conversation ID pinned: ${currentId}`, "info");
    },
  });

  pi.registerCommand("conversation-id-providers", {
    description:
      "Manage enabled providers: list | add <name> | remove <name>",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const sub = parts[0] || "list";

      if (sub === "list" || !parts[0]) {
        const list = [...enabledProviders];
        if (list.length === 0) {
          ctx.ui.notify("No providers enabled for conversation ID header.", "info");
        } else {
          ctx.ui.notify(
            `Providers receiving ${HEADER_NAME}: ${list.join(", ")}`,
            "info",
          );
        }
        return;
      }

      if (sub === "add") {
        if (parts.length < 2) {
          ctx.ui.notify("Usage: /conversation-id-providers add <provider-name>", "warning");
          return;
        }
        const name = parts[1];
        if (enabledProviders.has(name)) {
          ctx.ui.notify(`Provider "${name}" is already enabled.`, "info");
          return;
        }
        const updated = new Set(enabledProviders);
        updated.add(name);
        setProviders(updated);
        updateStatus(ctx);
        ctx.ui.notify(`Added "${name}". Header applied immediately.`, "info");
        return;
      }

      if (sub === "remove") {
        if (parts.length < 2) {
          ctx.ui.notify("Usage: /conversation-id-providers remove <provider-name>", "warning");
          return;
        }
        const name = parts[1];
        if (!enabledProviders.has(name)) {
          ctx.ui.notify(`Provider "${name}" is not enabled.`, "info");
          return;
        }
        const updated = new Set(enabledProviders);
        updated.delete(name);
        setProviders(updated);
        updateStatus(ctx);
        ctx.ui.notify(`Removed "${name}".`, "info");
        return;
      }

      ctx.ui.notify(
        `Unknown subcommand "${sub}". Use: list | add <name> | remove <name>`,
        "warning",
      );
    },
  });

  // -----------------------------------------------------------------------
  // Event: model_select — re-apply if provider changed
  // -----------------------------------------------------------------------

  pi.on("model_select", async (event, ctx) => {
    // If the new model's provider is in our enabled set, re-apply the header.
    // (registerProvider after startup takes effect immediately, so this covers
    // the case where the user switched to a provider we've already configured.)
    if (enabledProviders.has(event.model.provider)) {
      applyHeader(event.model.provider, currentId);
    }
    updateStatus(ctx);
  });
}
