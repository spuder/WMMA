import { existsSync } from "node:fs";

/** Resolve a binary from an env var or PATH; tests needing it are skipped if absent. */
function findBin(envVar: string, name: string): string | null {
  const fromEnv = process.env[envVar];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  return Bun.which(name);
}

export const hledgerBin = findBin("HLEDGER_BIN", "hledger");
export const hledgerWebBin = findBin("HLEDGER_WEB_BIN", "hledger-web");

export async function freePort(): Promise<number> {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}
