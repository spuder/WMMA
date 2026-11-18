import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../src/audit";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { HledgerWeb } from "../src/hledger/web";
import { parseCsv } from "../src/importers/csv";
import { normaliseApiExport, YnabApi, type YnabRawExport } from "../src/importers/ynab/api";
import { convert, type ResolvedAccount } from "../src/importers/ynab/convert";
import { detectDateFormat, parseYnabRegisterCsv } from "../src/importers/ynab/csv";
import { JournalStore } from "../src/journal/store";
import { cents, toCents } from "../src/money";
import { createFetchHandler } from "../src/server";
import type { ServiceContext } from "../src/services/context";
import { importYnabApi, importYnabCsv, listImportRuns } from "../src/services/imports";
import { freePort, hledgerBin, hledgerWebBin } from "./helpers";

const FIXTURES = join(import.meta.dir, "fixtures", "ynab");
const rawExport = JSON.parse(await readFile(join(FIXTURES, "api-export.json"), "utf8")) as YnabRawExport;
const registerCsv = await readFile(join(FIXTURES, "register.csv"), "utf8");

/** A fetch that serves the API fixture and records requests. */
function fakeYnab(raw: YnabRawExport, calls: Array<{ url: string; auth: string | null }> = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init?.headers).get("Authorization") });
    const path = new URL(url).pathname;
    if (path.endsWith("/accounts")) return Response.json({ data: { accounts: raw.accounts } });
    if (path.endsWith("/categories")) return Response.json({ data: { category_groups: raw.categoryGroups } });
    if (path.endsWith("/transactions")) return Response.json({ data: { transactions: raw.transactions, server_knowledge: 1 } });
    return Response.json({ error: { detail: "not found" } }, { status: 404 });
  }) as typeof fetch;
}

describe("parseCsv", () => {
  test("quotes, escaped quotes, embedded commas and newlines, CRLF, BOM", () => {
    expect(parseCsv('﻿a,"b,1","say ""hi""\r\nthere"\r\nx,,z\n')).toEqual([
      ["a", "b,1", 'say "hi"\r\nthere'],
      ["x", "", "z"],
    ]);
  });
  test("unterminated quote throws", () => expect(() => parseCsv('a,"b')).toThrow());
});

describe("YNAB API normalisation", () => {
  const ds = normaliseApiExport(rawExport);
  test("drops deleted accounts, transactions and subtransactions", () => {
    expect(ds.accounts.map((a) => a.name)).not.toContain("Old Account");
    expect(ds.transactions.find((t) => t.key === "t08")).toBeUndefined();
    expect(ds.transactions.find((t) => t.key === "t07")!.subs.map((s) => s.key)).toEqual(["s07a", "s07b"]);
  });
  test("milliunits to cents, categories resolved with groups", () => {
    const rent = ds.transactions.find((t) => t.key === "t03")!;
    expect(toCents(rent.amount)).toBe(-150000);
    expect(rent.category).toEqual({ group: "Immediate Obligations", name: "Rent/Mortgage" });
  });
  test("client asks for full history with the token", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    await new YnabApi("tok123", { fetch: fakeYnab(rawExport, calls) }).fetchPlan();
    expect(calls.map((c) => c.url).sort()).toEqual([
      "https://api.ynab.com/v1/plans/last-used/accounts",
      "https://api.ynab.com/v1/plans/last-used/categories",
      "https://api.ynab.com/v1/plans/last-used/transactions?since_date=1900-01-01",
    ]);
    expect(calls.every((c) => c.auth === "Bearer tok123")).toBe(true);
  });
  test("API errors surface the status and detail", async () => {
    const f = (async () => Response.json({ error: { detail: "Unauthorized" } }, { status: 401 })) as unknown as typeof fetch;
    await expect(new YnabApi("bad", { fetch: f }).fetchPlan()).rejects.toThrow(/HTTP 401 \(Unauthorized\)/);
  });
});

describe("convert", () => {
  const ds = normaliseApiExport(rawExport);
  const acct = (slug: string, h: string, entity = "personal", kind: ResolvedAccount["kind"] = "bank"): ResolvedAccount => ({
    slug,
    hledgerAccount: h,
    entity,
    kind,
  });
  const accounts = new Map<string, ResolvedAccount>([
    ["acc-checking", acct("checking", "Assets:Checking:Checking")],
    ["acc-savings", acct("savings", "Assets:Checking:Savings")],
    ["acc-visa", acct("visa-rewards", "Liabilities:CreditCards:VisaRewards", "personal", "credit")],
    ["acc-house", acct("house", "Assets:Other:House", "personal", "other_asset")],
    ["acc-biz", acct("acme-checking", "Assets:Checking:AcmeChecking", "acme")],
  ]);
  let n = 0;
  const res = convert(ds, { source: "ynab", accounts, lookupMapping: () => undefined, newId: () => `ID${++n}` });
  const byId = (id: string) => res.txns.find((t) => t.sourceId === id);

  test("emits each transfer once", () => {
    expect(res.pairedSkips).toBe(4);
    expect(res.txns.length).toBe(14);
    for (const skipped of ["t04b", "t06b", "t07c", "t12b"]) expect(byId(skipped)).toBeUndefined();
    expect(byId("t04a")!.txn.postings.map((p) => [p.account, toCents(p.amount)])).toEqual([
      ["Assets:Checking:Checking", -20000],
      ["Assets:Checking:Savings", 20000],
    ]);
  });

  test("split becomes one transaction with a transfer posting", () => {
    const t = byId("t07")!.txn;
    expect(t.postings.map((p) => [p.account, toCents(p.amount)])).toEqual([
      ["Assets:Checking:Checking", -12000],
      ["Expenses:ImmediateObligations:Groceries", 7000],
      ["Assets:Checking:Savings", 5000],
    ]);
    expect(t.postings[1]!.tags).toEqual({ orig_category: "Immediate Obligations: Groceries" });
  });

  test("inter-entity transfer carries posting-level entity", () => {
    const t = byId("t12a")!.txn;
    expect(t.tags["entity"]).toBe("acme");
    expect(t.postings[1]).toMatchObject({ account: "Assets:Checking:Checking", tags: { entity: "personal" } });
  });

  test("special categories", () => {
    expect(byId("t01")!.txn.postings[1]!.account).toBe("Equity:OpeningBalances");
    expect(byId("t02")!.txn.postings[1]!.account).toBe("Income:Uncategorized");
    expect(byId("t09")!.txn.postings[1]!.account).toBe("Equity:OpeningBalances");
    expect(byId("t10")!.txn.postings[1]!.account).toBe("Equity:Unrealized");
    expect(byId("t13")!.txn.postings[1]!.account).toBe("Expenses:Uncategorized");
    expect(byId("t14")!.txn.postings[1]!.account).toBe("Expenses:Fun:Games");
  });

  test("tags and mappings", () => {
    const t = byId("t03")!.txn;
    expect(t.tags).toMatchObject({ source: "ynab", source_id: "t03", entity: "personal", orig_category: "Immediate Obligations: Rent/Mortgage", cat_by: "mapping" });
    expect(byId("t02")!.txn.tags["cat_by"]).toBeUndefined();
    expect(res.newMappings.get("Immediate Obligations: Rent/Mortgage")).toBe("Expenses:ImmediateObligations:RentMortgage");
    expect(byId("t05")!.txn.payee).toBe("Grocer Inc");
    expect(byId("t05")!.txn.status).toBe("");
  });

  test("existing mappings win", () => {
    const r = convert(ds, {
      source: "ynab",
      accounts,
      lookupMapping: (l) => (l === "Immediate Obligations: Rent/Mortgage" ? "Expenses:Housing:Rent" : undefined),
      newId: () => "X",
    });
    expect(r.txns.find((t) => t.sourceId === "t03")!.txn.postings[1]!.account).toBe("Expenses:Housing:Rent");
    expect(r.newMappings.has("Immediate Obligations: Rent/Mortgage")).toBe(false);
  });
});

describe("YNAB register CSV", () => {
  const ds = parseYnabRegisterCsv(registerCsv);
  test("groups splits and pairs transfers", () => {
    expect(ds.transactions.length).toBe(13);
    const split = ds.transactions.find((t) => t.subs.length > 0)!;
    expect(split.subs.map((s) => [toCents(s.amount), s.memo, s.transferAccountKey])).toEqual([
      [-7000, "food", null],
      [-5000, "cash back", "Savings"],
    ]);
    const savingsSide = ds.transactions.find((t) => t.accountKey === "Savings" && t.date === "2026-01-07")!;
    expect(savingsSide.transferPeerKey).toBe(split.subs[1]!.key);
  });
  test("identical rows get distinct keys", () => {
    const coffees = ds.transactions.filter((t) => t.payee === "Blue Bottle");
    expect(coffees.length).toBe(2);
    expect(coffees[0]!.key).not.toBe(coffees[1]!.key);
  });
  test("keys ignore cleared status", () => {
    const again = parseYnabRegisterCsv(registerCsv.replaceAll('"Uncleared"', '"Cleared"'));
    expect(again.transactions.map((t) => t.key)).toEqual(ds.transactions.map((t) => t.key));
  });
  test("balances are row sums", () => {
    expect(Object.fromEntries(ds.accounts.map((a) => [a.name, a.balance === null ? null : toCents(a.balance)]))).toEqual({
      Checking: 157341,
      Savings: 25000,
      "Visa Rewards": 0,
    });
  });
  test("date format detection", () => {
    expect(detectDateFormat(["01/02/2026", "12/31/2026"])).toBe("MM/DD/YYYY");
    expect(detectDateFormat(["01/02/2026", "31/12/2026"])).toBe("DD/MM/YYYY");
    expect(detectDateFormat(["2026-01-02"])).toBe("YYYY-MM-DD");
  });
  test("rejects non-YNAB CSV", () => expect(() => parseYnabRegisterCsv("a,b\n1,2\n")).toThrow(/missing column/));
});

async function makeCtx(): Promise<{ ctx: ServiceContext; web: HledgerWeb; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "wmma-ynab-"));
  const store = new JournalStore(dir);
  await store.init();
  const web = new HledgerWeb({ bin: hledgerWebBin!, port: await freePort(), journal: store.paths.main, log: () => {} });
  await web.start();
  const ctx: ServiceContext = {
    config: loadConfig({ WMMA_ALLOWED_USERS: "alice@example.com", WMMA_DATA_DIR: dir }),
    db: openDb(store.paths.db),
    store,
    hledger: web.client,
    audit: new AuditLog(store.paths.audit),
  };
  return { ctx, web, dir };
}

describe.skipIf(!hledgerWebBin)("YNAB API import (end to end)", () => {
  let env: Awaited<ReturnType<typeof makeCtx>>;
  const api = { fetch: fakeYnab(rawExport) };
  beforeAll(async () => (env = await makeCtx()));
  afterAll(async () => {
    await env.web.stop();
    env.ctx.db.close();
    await rm(env.dir, { recursive: true, force: true });
  });

  test("first import: balances match YNAB", async () => {
    const r = await importYnabApi(env.ctx, "alice@example.com", {
      token: "t",
      api,
      accounts: { "Acme Checking": { entity: "acme" } },
    });
    expect(r.added).toBe(14);
    expect(r.skippedDuplicates).toBe(0);
    expect(r.createdEntities.sort()).toEqual(["acme", "personal"]);
    expect(r.createdAccounts.find((a) => a.name === "Visa Rewards")).toMatchObject({ kind: "credit", hledgerAccount: "Liabilities:CreditCards:VisaRewards" });
    expect(r.createdAccounts.find((a) => a.name === "Savings")!.hledgerAccount).toBe("Assets:Savings:Savings");
    expect(r.balances.length).toBe(5);
    for (const b of r.balances) expect(b).toMatchObject({ match: true });
  });

  test("re-running adds zero transactions", async () => {
    const r = await importYnabApi(env.ctx, "alice@example.com", { token: "t", api });
    expect(r.added).toBe(0);
    expect(r.skippedDuplicates).toBe(14);
    expect(r.createdAccounts).toEqual([]);
    for (const b of r.balances) expect(b.match).toBe(true);
  });

  test("raw exports kept (one snapshot per fetch), runs recorded, writes audited", async () => {
    const raws = await readdir(join(env.dir, "imports", "ynab"));
    expect(raws.length).toBe(2);
    expect(JSON.parse(await readFile(join(env.dir, "imports", "ynab", raws[0]!), "utf8")).transactions.length).toBe(19);
    const runs = listImportRuns(env.ctx);
    expect(runs.map((r) => [r.source, r.added])).toEqual([
      ["ynab-api", 0],
      ["ynab-api", 14],
    ]);
    const audit = (await readFile(env.ctx.store.paths.audit, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.length).toBe(2);
    expect(audit[0]).toMatchObject({ actor: "alice@example.com", operation: "import.ynab-api" });
    expect(audit[0].after.added.length).toBe(14);
    expect(JSON.stringify(audit)).not.toContain('"t"'); // token never logged
  });

  test.skipIf(!hledgerBin)("journals pass hledger check --strict", () => {
    const r = Bun.spawnSync([hledgerBin!, "-f", env.ctx.store.paths.main, "check", "--strict"], { env: { ...process.env, LANG: "C.UTF-8" } });
    expect(r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
  });
});

describe.skipIf(!hledgerWebBin)("YNAB CSV import (end to end, via REST)", () => {
  let env: Awaited<ReturnType<typeof makeCtx>>;
  let handler: (r: Request) => Promise<Response>;
  const post = (csv: string, options: unknown = {}) => {
    const form = new FormData();
    form.set("type", "ynab-csv");
    form.set("file", new File([csv], "register.csv"));
    form.set("options", JSON.stringify(options));
    return handler(new Request("http://x/api/v1/imports", { method: "POST", body: form, headers: { "Tailscale-User-Login": "alice@example.com" } }));
  };
  beforeAll(async () => {
    env = await makeCtx();
    handler = createFetchHandler(env.ctx);
  });
  afterAll(async () => {
    await env.web.stop();
    env.ctx.db.close();
    await rm(env.dir, { recursive: true, force: true });
  });

  test("first import: balances match the export", async () => {
    const res = await post(registerCsv, { accounts: { "Visa Rewards": { kind: "credit" } } });
    expect(res.status).toBe(200);
    const r = (await res.json()) as any;
    expect(r.added).toBe(10);
    expect(r.pairedTransfers).toBe(3);
    expect(r.createdAccounts.find((a: { name: string }) => a.name === "Checking").kindGuessed).toBe(true);
    for (const b of r.balances) expect(b.match).toBe(true);
  });

  test("re-export with changed cleared status adds zero", async () => {
    const r = (await (await post(registerCsv.replaceAll('"Uncleared"', '"Cleared"'))).json()) as any;
    expect(r.added).toBe(0);
    expect(r.skippedDuplicates).toBe(10);
  });

  test("accounts endpoint shows balances", async () => {
    const res = await handler(new Request("http://x/api/v1/accounts", { headers: { "Tailscale-User-Login": "alice@example.com" } }));
    const { accounts } = (await res.json()) as any;
    expect(accounts.find((a: { name: string }) => a.name === "Checking").balance).toBe("$1,573.41");
  });

  test("bad input is a 4xx, not a 500", async () => {
    expect((await post("a,b\n1,2\n")).status).toBe(422);
    expect((await post(registerCsv, { accounts: { X: { kind: "spaceship" } } })).status).toBe(400);
    const noAuth = await handler(new Request("http://x/api/v1/imports", { method: "POST" }));
    expect(noAuth.status).toBe(401);
  });

  test("YNAB API without a token is a 422", async () => {
    const prev = process.env.YNAB_TOKEN;
    delete process.env.YNAB_TOKEN;
    const res = await handler(new Request("http://x/api/v1/imports/ynab-api", { method: "POST", headers: { "Tailscale-User-Login": "alice@example.com" } }));
    if (prev !== undefined) process.env.YNAB_TOKEN = prev;
    expect(res.status).toBe(422);
  });

  test("money stays exact", () => expect(toCents(cents(157341))).toBe(157341));
});
