export interface Config {
  dataDir: string;
  host: string;
  port: number;
  allowedUsers: ReadonlySet<string>;
  tz: string;
  hledgerWebBin: string;
  hledgerWebPort: number;
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
  };
}
