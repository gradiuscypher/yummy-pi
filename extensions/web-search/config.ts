import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const providers = ["exa", "tavily", "scry", "kagi", "ceramic", "linkup", "openai", "openrouter"] as const;
export type Provider = typeof providers[number];
export type ProviderConfig = {
  enabled?: boolean;
  apiKey?: string;
  apiKeyEnv?: string;
  weight?: number;
  costPerSearchUsd?: number | null;
  freeCreditsRemaining?: number | null;
  model?: string;
};
export type Config = {
  providers?: Partial<Record<Provider, ProviderConfig>>;
  routing?: {
    preferKnownFreeCredits?: boolean;
    allowUnknownCost?: boolean;
    maxResults?: number;
    timeoutMs?: number;
    maxAttempts?: number;
  };
};
export const configPath = () => process.env.PI_WEB_SEARCH_CONFIG || join(homedir(), ".config/pi/web-search.json");

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function validateConfig(value: unknown): Config {
  // Never echo values or parser messages: either may contain a credential.
  if (!object(value)) throw new Error("Search config must be an object.");
  if (value.providers !== undefined) {
    if (!object(value.providers)) throw new Error("Config providers must be an object.");
    for (const id of Object.keys(value.providers)) {
      if (!providers.includes(id as Provider)) throw new Error("Config contains an unknown provider name.");
      const p = value.providers[id];
      if (!object(p)) throw new Error(`Config providers.${id} must be an object.`);
      for (const field of ["apiKey", "apiKeyEnv", "model"]) {
        if (p[field] !== undefined && typeof p[field] !== "string") throw new Error(`Config providers.${id}.${field} must be a string.`);
      }
      if (p.enabled !== undefined && typeof p.enabled !== "boolean") throw new Error(`Config providers.${id}.enabled must be boolean.`);
      for (const field of ["weight", "costPerSearchUsd", "freeCreditsRemaining"]) {
        const n = p[field];
        if ((field === "weight" && n === null) || (n !== undefined && n !== null && (typeof n !== "number" || !Number.isFinite(n) || n < 0))) {
          throw new Error(`Config providers.${id}.${field} must be non-negative or null.`);
        }
      }
    }
  }
  if (value.routing !== undefined) {
    if (!object(value.routing)) throw new Error("Config routing must be an object.");
    for (const field of ["preferKnownFreeCredits", "allowUnknownCost"]) {
      if (value.routing[field] !== undefined && typeof value.routing[field] !== "boolean") throw new Error(`Config routing.${field} must be boolean.`);
    }
    for (const [field, max] of [["maxResults", 20], ["timeoutMs", 120000], ["maxAttempts", providers.length]] as const) {
      const n = value.routing[field];
      if (n !== undefined && (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > max)) throw new Error(`Config routing.${field} must be an integer from 1 to ${max}.`);
    }
  }
  return value as Config;
}
export async function loadConfigState(): Promise<{ config: Config; exists: boolean }> {
  let text: string;
  try { text = await readFile(configPath(), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: {}, exists: false };
    throw new Error("Search config cannot be read. Check its path and permissions.");
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("Search config is invalid JSON. No configuration values have been displayed."); }
  return { config: validateConfig(value), exists: true };
}
export async function loadConfig(): Promise<Config> {
  return (await loadConfigState()).config;
}
export function keyFor(id: Provider, cfg: Config, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const p = cfg.providers?.[id];
  return p?.apiKey?.trim() || env[p?.apiKeyEnv || `${id.toUpperCase()}_API_KEY`]?.trim() || undefined;
}
export function providerStatus(cfg: Config, env: NodeJS.ProcessEnv = process.env) {
  return providers.map(id => {
    const p = cfg.providers?.[id] ?? {};
    const enabled = p.enabled !== false;
    const credentialPresent = Boolean(keyFor(id, cfg, env));
    const implemented = id !== "scry";
    const costAllowed = cfg.routing?.allowUnknownCost !== false || p.costPerSearchUsd != null || (p.freeCreditsRemaining ?? 0) > 0;
    const eligible = enabled && credentialPresent && implemented && costAllowed;
    const reason = !enabled ? "disabled" : !implemented ? "dedicated SQL tools only" : !credentialPresent ? "missing credential" : !costAllowed ? "unknown cost disallowed" : "eligible";
    return { id, enabled, credentialPresent, implemented, eligible, reason,
      costPerSearchUsd: p.costPerSearchUsd ?? null, freeCreditsRemaining: p.freeCreditsRemaining ?? null,
      hintSource: "operator-maintained; not a live balance" };
  });
}
export function eligible(cfg: Config): Provider[] {
  return providerStatus(cfg).filter(p => p.eligible).map(p => p.id);
}
export function rank(ids: Provider[], cfg: Config): Provider[] {
  return [...ids].sort((a, b) => {
    const x = cfg.providers?.[a] ?? {}, y = cfg.providers?.[b] ?? {};
    const xf = (x.freeCreditsRemaining ?? 0) > 0 ? 1 : 0;
    const yf = (y.freeCreditsRemaining ?? 0) > 0 ? 1 : 0;
    if ((cfg.routing?.preferKnownFreeCredits ?? true) && xf !== yf) return yf - xf;
    const xc = x.costPerSearchUsd ?? Infinity, yc = y.costPerSearchUsd ?? Infinity;
    if (xc !== yc) return xc - yc;
    return (y.weight ?? 1) - (x.weight ?? 1);
  });
}
