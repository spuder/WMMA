/** Non-secret settings (SQLite) and the UI-settable Jev key (encrypted file). */
import { JevClient } from "../jev";
import { SecretsError } from "../secrets";
import { ServiceError, type ServiceContext } from "./context";

/** Settings the UI may change. Internal bookkeeping keys (e.g. simplefin.last_sync) are read-only. */
const WRITABLE = /^ui\.[a-z0-9_.-]{1,64}$/;

export interface SettingsView {
  settings: Record<string, string>;
  jev: { configured: boolean; source: "env" | "ui" | null; canStoreInUi: boolean };
}

export async function getSettings(ctx: ServiceContext): Promise<SettingsView> {
  const rows = ctx.db.query("SELECT key, value FROM settings ORDER BY key").all() as Array<{ key: string; value: string }>;
  let uiKey: string | null = null;
  try {
    uiKey = (await ctx.secrets?.get("jev_api_key")) ?? null;
  } catch {
    // unreadable secrets file: report as not configured from the UI
  }
  return {
    settings: Object.fromEntries(rows.map((r) => [r.key, r.value])),
    jev: {
      configured: Boolean(ctx.config.jev.apiKey || uiKey),
      source: ctx.config.jev.apiKey ? "env" : uiKey ? "ui" : null,
      canStoreInUi: Boolean(ctx.secrets?.enabled),
    },
  };
}

export function jevFromConfig(ctx: ServiceContext, key: string | null): JevClient | null {
  return key ? new JevClient({ apiKey: key, baseUrl: ctx.config.jev.baseUrl, model: ctx.config.jev.model }) : null;
}

export async function putSettings(
  ctx: ServiceContext,
  actor: string,
  input: { settings?: Record<string, unknown>; jevApiKey?: string | null },
): Promise<SettingsView> {
  const before = await getSettings(ctx);
  if (input.settings !== undefined) {
    if (typeof input.settings !== "object" || input.settings === null) throw new ServiceError("settings must be an object");
    const put = ctx.db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
    const del = ctx.db.query("DELETE FROM settings WHERE key = ?");
    for (const [k, v] of Object.entries(input.settings)) {
      if (!WRITABLE.test(k)) throw new ServiceError(`setting ${JSON.stringify(k)} is not writable (allowed: ui.*)`);
      if (v === null) del.run(k);
      else if (typeof v === "string" && v.length <= 4096) put.run(k, v);
      else throw new ServiceError(`setting ${k} must be a string (max 4096 chars) or null`);
    }
  }
  if (input.jevApiKey !== undefined) {
    if (ctx.config.jev.apiKey) throw new ServiceError("JEV_API_KEY is set in the environment, which takes precedence; change it there", 409);
    if (input.jevApiKey !== null && (typeof input.jevApiKey !== "string" || input.jevApiKey.trim().length < 8)) throw new ServiceError("jevApiKey looks too short");
    if (!ctx.secrets) throw new ServiceError("secret storage is not available", 422);
    try {
      await ctx.secrets.set("jev_api_key", input.jevApiKey === null ? null : input.jevApiKey.trim());
    } catch (e) {
      if (e instanceof SecretsError) throw new ServiceError(e.message, 422);
      throw e;
    }
    ctx.jev = jevFromConfig(ctx, input.jevApiKey === null ? null : input.jevApiKey.trim());
  }
  const after = await getSettings(ctx);
  // The key itself is never logged.
  await ctx.audit.append({
    actor,
    operation: "settings.put",
    inputs: { settings: input.settings, jevApiKey: input.jevApiKey === undefined ? undefined : input.jevApiKey === null ? "(removed)" : "(set)" },
    before,
    after,
  });
  return after;
}
