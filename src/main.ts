import { ConfigError, loadConfig } from "./config";
import { HledgerWeb } from "./hledger/web";
import { JournalStore } from "./journal/store";
import { createFetchHandler } from "./server";

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

  const hledger = new HledgerWeb({ bin: config.hledgerWebBin, port: config.hledgerWebPort, journal: store.paths.main });
  const version = await hledger.start();
  console.log(`hledger-web ${version} on 127.0.0.1:${config.hledgerWebPort}`);

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: createFetchHandler({ config, hledger: hledger.client }),
  });
  console.log(`WMMA listening on http://${server.hostname}:${server.port} (data: ${config.dataDir})`);

  const shutdown = async (sig: string) => {
    console.log(`${sig} received, shutting down`);
    await server.stop();
    await hledger.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

const cmd = process.argv[2] ?? "serve";
if (cmd === "healthcheck") await healthcheck();
else if (cmd === "serve") await serve();
else {
  console.error(`usage: wmma [serve|healthcheck]`);
  process.exit(2);
}
