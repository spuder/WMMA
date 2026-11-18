import { AuditLog } from "./audit";
import { runCli } from "./cli";
import { ConfigError, loadConfig } from "./config";
import { openDb } from "./db";
import { HledgerWeb } from "./hledger/web";
import { join } from "node:path";
import { JevClient } from "./jev";
import { SecretStore } from "./secrets";
import { JournalStore } from "./journal/store";
import { schedule } from "./scheduler";
import { createFetchHandler } from "./server";
import { syncSimplefin } from "./services/bank-imports";
import type { ServiceContext } from "./services/context";

async function healthcheck(): Promise<never> {
  const port = process.env.WMMA_PORT || "3000";
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3000) });
    process.exit(res.ok ? 0 : 1);
  } catch {
    process.exit(1);
  }
}

async function serve(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`config error: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }

  const store = new JournalStore(config.dataDir);
  await store.init();
  const db = openDb(store.paths.db);
  const audit = new AuditLog(store.paths.audit);

  const hledger = new HledgerWeb({ bin: config.hledgerWebBin, port: config.hledgerWebPort, journal: store.paths.main });
  const version = await hledger.start();
  console.log(`hledger-web ${version} on 127.0.0.1:${config.hledgerWebPort}`);

  const secrets = new SecretStore(join(config.dataDir, "secrets.enc"), config.secretKey);
  let jevKey = config.jev.apiKey;
  if (!jevKey) {
    try {
      jevKey = await secrets.get("jev_api_key");
    } catch (e) {
      console.error(`secrets: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const jev = jevKey ? new JevClient({ apiKey: jevKey, baseUrl: config.jev.baseUrl, model: config.jev.model }) : null;
  if (!jev) console.log("No Jev key (JEV_API_KEY or set in the UI): uncategorised transactions go straight to the review queue");
  const ctx: ServiceContext = { config, db, store, audit, hledger: hledger.client, jev, secrets };
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    maxRequestBodySize: 64 * 1024 * 1024,
    idleTimeout: 255, // long YNAB imports
    fetch: createFetchHandler(ctx),
  });

  let stopCron = () => {};
  if (config.simplefinAccessUrl) {
    stopCron = schedule(config.simplefinSyncCron, config.tz, async () => {
      const r = await syncSimplefin(ctx, "system:scheduler");
      console.log(`SimpleFIN sync: +${r.added} new, ${r.merged} merged, ${r.skippedDuplicates} duplicates, ${r.needsReview} to review`);
    });
    console.log(`SimpleFIN sync scheduled: "${config.simplefinSyncCron}" (${config.tz})`);
  }
  console.log(`WMMA listening on http://${server.hostname}:${server.port} (data: ${config.dataDir})`);

  const shutdown = async (sig: string) => {
    console.log(`${sig} received, shutting down`);
    stopCron();
    await server.stop();
    await hledger.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

const [cmd = "serve", ...rest] = process.argv.slice(2);
if (cmd === "healthcheck") await healthcheck();
else if (cmd === "serve") await serve();
else process.exit(await runCli(cmd, rest));
