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
import ui from "../ui/index.html";
import { syncTemplates } from "./services/entities";
import { syncSimplefin } from "./services/bank-imports";
import { parseAccessUrl } from "./importers/simplefin";
import type { Database } from "bun:sqlite";
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

/**
 * SIMPLEFIN_ACCESS_URL used to configure SimpleFIN from the environment. It is now
 * stored encrypted via Settings; import it once so upgraded deployments keep syncing,
 * and derive account mappings from accounts that earlier syncs already linked.
 */
async function migrateLegacySimplefin(db: Database, secrets: SecretStore): Promise<void> {
  const legacyUrl = process.env.SIMPLEFIN_ACCESS_URL?.trim();
  try {
    if (legacyUrl) {
      if (await secrets.get("simplefin_access_url")) {
        console.warn("SIMPLEFIN_ACCESS_URL is ignored because SimpleFIN is connected in Settings; remove it from the environment.");
      } else {
        parseAccessUrl(legacyUrl);
        await secrets.set("simplefin_access_url", legacyUrl);
        console.warn("SIMPLEFIN_ACCESS_URL was imported into encrypted storage; remove it from the environment.");
      }
    }
    if (!(await secrets.get("simplefin_access_url"))) return;
    if (db.query("SELECT 1 FROM settings WHERE key = ?").get("simplefin.account_mappings")) return;
    const linked = db.query("SELECT slug, default_entity, simplefin_id FROM accounts WHERE simplefin_id IS NOT NULL AND status = 'open'").all() as Array<{
      slug: string;
      default_entity: string;
      simplefin_id: string;
    }>;
    if (linked.length === 0) return;
    const mappings = Object.fromEntries(linked.map((a) => [a.simplefin_id, { slug: a.slug, entity: a.default_entity }]));
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run("simplefin.account_mappings", JSON.stringify(mappings));
    console.warn(`SimpleFIN: kept syncing ${linked.length} previously linked account(s); review them in Settings → SimpleFIN.`);
  } catch (e) {
    console.error(`SimpleFIN migration skipped: ${e instanceof Error ? e.message : String(e)}. Connect SimpleFIN in Settings.`);
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

  const secretKeyFile = config.dataDir === "/data" ? "/var/lib/wmma-secrets/key" : join(config.dataDir, ".wmma-secret-key");
  const secrets = await SecretStore.open(join(config.dataDir, "secrets.enc"), config.secretKey, secretKeyFile);
  let jevKey = config.jev.apiKey;
  if (!jevKey) {
    try {
      jevKey = await secrets.get("jev_api_key");
    } catch (e) {
      console.error(`secrets: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  await migrateLegacySimplefin(db, secrets);
  const jev = jevKey ? new JevClient({ apiKey: jevKey, baseUrl: config.jev.baseUrl, model: config.jev.model }) : null;
  if (!jev) console.log("No Jev key (JEV_API_KEY or set in the UI): uncategorised transactions go straight to the review queue");
  const ctx: ServiceContext = { config, db, store, audit, hledger: hledger.client, jev, secrets };
  try {
    await syncTemplates(ctx);
  } catch (e) {
    console.error(`templates: ${e instanceof Error ? e.message : String(e)}`);
  }
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    maxRequestBodySize: 64 * 1024 * 1024,
    idleTimeout: 255, // long YNAB imports
    // The UI shell and its bundled assets carry no data; every API call is authenticated.
    routes: { "/": ui },
    development: false,
    fetch: createFetchHandler(ctx),
  });

  let stopCron = () => {};
  stopCron = schedule(config.simplefinSyncCron, config.tz, async () => {
    const simplefinUrl = await secrets.get("simplefin_access_url");
    const accountsConfigured = db.query("SELECT 1 FROM settings WHERE key = ?").get("simplefin.account_mappings");
    if (simplefinUrl && !accountsConfigured) {
      console.warn("SimpleFIN sync skipped: no accounts chosen yet. Open Settings → SimpleFIN → Choose accounts.");
    }
    if (simplefinUrl && accountsConfigured) {
      try {
        const r = await syncSimplefin(ctx, "system:scheduler");
        console.log(`SimpleFIN sync: +${r.added} new, ${r.merged} merged, ${r.skippedDuplicates} duplicates, ${r.needsReview} to review`);
      } catch (e) {
        console.error("SimpleFIN sync failed:", e);
      }
    }
  });
  console.log(`SimpleFIN sync schedule ready: "${config.simplefinSyncCron}" (${config.tz})`);
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
