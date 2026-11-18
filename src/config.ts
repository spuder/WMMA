import { parseCron } from "./scheduler";

export interface Config {
  dataDir: string;
  host: string;
  port: number;
  allowedUsers: ReadonlySet<string>;
  tz: string;
  hledgerWebBin: string;
  hledgerWebPort: number;
  simplefinAccessUrl: string | null;
  simplefinSyncCron: string;
  jev: { apiKey: string | null; baseUrl: string; model: string };
  secretKey: string | null;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

function port(name: string, raw: string | undefined, dflt: number): number {
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new ConfigError(`${name} must be a TCP port, got ${JSON.stringify(raw)}`);
  return n;
}

function cron(name: string, expr: string): string {
  try {
    parseCron(expr);
  } catch (e) {
    throw new ConfigError(`${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return expr;
}

export function parseAllowedUsers(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const allowedUsers = parseAllowedUsers(env.WMMA_ALLOWED_USERS);
  if (env.WMMA_SECRET_KEY && env.WMMA_SECRET_KEY.length < 16) throw new ConfigError("WMMA_SECRET_KEY must be at least 16 characters");
  if (allowedUsers.size === 0) {
    throw new ConfigError("WMMA_ALLOWED_USERS is empty: set it to a comma-separated list of Tailscale login names");
  }
  return {
    dataDir: env.WMMA_DATA_DIR || "/data",
    // Localhost only: the app is reachable solely through Tailscale Serve (SPEC §2).
    host: env.WMMA_HOST || "127.0.0.1",
    port: port("WMMA_PORT", env.WMMA_PORT, 3000),
    allowedUsers,
    tz: env.WMMA_TZ || "UTC",
    hledgerWebBin: env.HLEDGER_WEB_BIN || "hledger-web",
    hledgerWebPort: port("HLEDGER_WEB_PORT", env.HLEDGER_WEB_PORT, 5000),
    simplefinAccessUrl: env.SIMPLEFIN_ACCESS_URL || null,
    simplefinSyncCron: cron("SIMPLEFIN_SYNC_CRON", env.SIMPLEFIN_SYNC_CRON || "0 6 * * *"),
    jev: {
      apiKey: env.JEV_API_KEY || null,
      baseUrl: env.JEV_BASE_URL || "https://api.typesafe.ai",
      model: env.JEV_MODEL || "jev-latest",
    },
    secretKey: env.WMMA_SECRET_KEY || null,
  };
}
