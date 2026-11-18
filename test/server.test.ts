import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authenticate } from "../src/auth/tailscale";
import { ConfigError, loadConfig } from "../src/config";
import { HledgerWeb, HledgerWebClient } from "../src/hledger/web";
import { JournalStore } from "../src/journal/store";
import { cents, fromHledgerQuantity } from "../src/money";
import { createFetchHandler } from "../src/server";
import { freePort, hledgerWebBin } from "./helpers";

const allowed = new Set(["alice@example.com"]);
const req = (headers: Record<string, string> = {}, path = "/api/v1/status") =>
  new Request(`http://wmma.local${path}`, { headers });

describe("config", () => {
  test("requires an allowlist", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ WMMA_ALLOWED_USERS: " , " })).toThrow(ConfigError);
  });
  test("defaults and normalisation", () => {
    const c = loadConfig({ WMMA_ALLOWED_USERS: "Alice@Example.com, bob@github " });
    expect([...c.allowedUsers]).toEqual(["alice@example.com", "bob@github"]);
    expect(c.dataDir).toBe("/data");
    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(3000);
  });
  test("rejects bad ports", () => {
    expect(() => loadConfig({ WMMA_ALLOWED_USERS: "a", WMMA_PORT: "99999" })).toThrow(ConfigError);
  });
});

describe("authenticate", () => {
  test("401 without identity", () => {
    const r = authenticate(req(), allowed);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });
  test("403 for users not on the allowlist", () => {
    const r = authenticate(req({ "Tailscale-User-Login": "mallory@example.com" }), allowed);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
  });
  test("allows listed users, case-insensitively", () => {
    const r = authenticate(req({ "Tailscale-User-Login": "Alice@Example.com", "Tailscale-User-Name": "Alice" }), allowed);
    expect(r).toEqual({ ok: true, identity: { login: "alice@example.com", name: "Alice" } });
  });
});

describe("fetch handler", () => {
  const handler = createFetchHandler({
    config: loadConfig({ WMMA_ALLOWED_USERS: "alice@example.com" }),
    hledger: new HledgerWebClient("http://127.0.0.1:1"), // unreachable on purpose
  });
  test("healthz needs no auth", async () => {
    const r = await handler(req({}, "/healthz"));
    expect(r.status).toBe(200);
  });
  test("api requires identity", async () => {
    expect((await handler(req())).status).toBe(401);
    expect((await handler(req({ "Tailscale-User-Login": "eve@example.com" }))).status).toBe(403);
  });
  test("unknown routes are 404 only after auth", async () => {
    expect((await handler(req({}, "/api/v1/nope"))).status).toBe(401);
    expect((await handler(req({ "Tailscale-User-Login": "alice@example.com" }, "/api/v1/nope"))).status).toBe(404);
  });
  test("status reports hledger-web unreachable as null", async () => {
    const r = await handler(req({ "Tailscale-User-Login": "alice@example.com" }));
    expect(await r.json()).toEqual({ user: "alice@example.com", hledgerWeb: null, timezone: "UTC" });
  });
});

describe.skipIf(!hledgerWebBin)("hledger-web integration", () => {
  let dir: string;
  let store: JournalStore;
  let web: HledgerWeb;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "wmma-web-"));
    store = new JournalStore(dir);
    await store.init();
    web = new HledgerWeb({ bin: hledgerWebBin!, port: await freePort(), journal: store.paths.main, log: () => {} });
    await web.start();
  });
  afterAll(async () => {
    await web.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test("serves an empty journal", async () => {
    expect(await web.client.transactions()).toEqual([]);
  });

  test("picks up WMMA writes, including newly included account files", async () => {
    await store.appendTransactions("chase", [
      {
        date: "2026-02-01",
        payee: "Paycheck",
        tags: { wmma_id: "W1", entity: "personal" },
        postings: [
          { account: "Assets:Checking:Chase", amount: cents(250000) },
          { account: "Income:Salary", amount: cents(-250000) },
        ],
      },
    ]);
    const txns = await web.client.transactions();
    expect(txns.length).toBe(1);
    const p = txns[0]!.tpostings[0]!;
    expect(p.paccount).toBe("Assets:Checking:Chase");
    expect(fromHledgerQuantity(p.pamount[0]!.aquantity)).toBe(cents(250000));
    expect(txns[0]!.ttags).toContainEqual(["entity", "personal"]);
  });

  test("is read-only (--allow=view)", async () => {
    const res = await fetch(`${web.client.baseUrl}/add`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.ok).toBe(false);
  });
});
