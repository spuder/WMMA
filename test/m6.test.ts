import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AuditLog } from "../src/audit";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { HledgerWeb } from "../src/hledger/web";
import { JournalStore } from "../src/journal/store";
import { SecretStore } from "../src/secrets";
import { createFetchHandler } from "../src/server";
import { importQfx } from "../src/services/bank-imports";
import { createRule, listReview } from "../src/services/categorize";
import type { ServiceContext } from "../src/services/context";
import { addAccount, addEntity } from "../src/services/entities";
import { importYnabCsv } from "../src/services/imports";
import { freePort, hledgerBin, hledgerWebBin } from "./helpers";

describe("SecretStore", () => {
  let dir: string;
  beforeAll(async () => (dir = await mkdtemp(join(tmpdir(), "wmma-sec-"))));
  afterAll(() => rm(dir, { recursive: true, force: true }));

  test("encrypts at rest, 0600, round-trips, wrong key fails", async () => {
    const path = join(dir, "secrets.enc");
    const s = new SecretStore(path, "correct horse battery staple");
    await s.set("jev_api_key", "jev-secret-123456");
    expect(await s.get("jev_api_key")).toBe("jev-secret-123456");
    expect(await readFile(path, "utf8")).not.toContain("jev-secret");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(new SecretStore(path, "a different passphrase!").get("jev_api_key")).rejects.toThrow(/decrypt/);
    await s.set("jev_api_key", null);
    expect(await s.get("jev_api_key")).toBeNull();
  });
  test("disabled without a key; short keys rejected", async () => {
    const s = new SecretStore(join(dir, "none.enc"), null);
    expect(s.enabled).toBe(false);
    await expect(s.set("jev_api_key", "x")).rejects.toThrow(/secret storage is not available/);
    expect(() => new SecretStore(join(dir, "x"), "short")).toThrow();
  });
});

describe.skipIf(!hledgerWebBin)("REST API + MCP (M6 done-when)", () => {
  let dir: string;
  let web: HledgerWeb;
  let ctx: ServiceContext;
  let server: ReturnType<typeof Bun.serve>;
  const me = "alice@example.com";
  let call: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>;
  let mcp: Client;

  const qfx = (txns: Array<[string, string, string, string]>) =>
    `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>1<ACCTID>42<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST>${txns
      .map(([f, d, a, n]) => `<STMTTRN><TRNTYPE>OTHER<DTPOSTED>${d.replaceAll("-", "")}<TRNAMT>${a}<FITID>${f}<NAME>${n}</STMTTRN>`)
      .join("")}</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "wmma-m6-"));
    const store = new JournalStore(dir);
    await store.init();
    web = new HledgerWeb({ bin: hledgerWebBin!, port: await freePort(), journal: store.paths.main, log: () => {} });
    await web.start();
    const config = loadConfig({ WMMA_ALLOWED_USERS: me, WMMA_DATA_DIR: dir, WMMA_SECRET_KEY: "test-secret-key-0123456789" });
    ctx = { config, db: openDb(store.paths.db), store, hledger: web.client, audit: new AuditLog(store.paths.audit), jev: null, secrets: new SecretStore(join(dir, "secrets.enc"), config.secretKey) };
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createFetchHandler(ctx) });
    call = async (method, path, body) => {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { "Tailscale-User-Login": me }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, json: await res.json() };
    };

    await addEntity(ctx, me, { name: "Acme LLC", type: "schedule_c", slug: "acme" });
    await addEntity(ctx, me, { name: "Household", type: "personal", slug: "personal" });
    await addAccount(ctx, me, { name: "Acme Checking", kind: "bank", entity: "acme" });
    await createRule(ctx, me, { match: { payeeContains: "client" }, target: "Income:GrossReceipts" });
    await createRule(ctx, me, { match: { payeeContains: "ads" }, target: "Expenses:Advertising" });
    await importQfx(ctx, me, {
      filename: "acme.qfx",
      account: "acme-checking",
      content: qfx([
        ["A1", "2026-03-02", "5000.00", "CLIENT PAYMENT"],
        ["A2", "2026-03-10", "-200.00", "ADS INC"],
        ["A3", "2026-03-12", "-89.99", "OFFICE DEPOT"],
        ["A4", "2026-03-20", "-300.00", "WAREHOUSE CLUB"],
      ]),
    });

    mcp = new Client({ name: "test-ai-client", version: "1.0.0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), { requestInit: { headers: { "Tailscale-User-Login": me } } }));
  });
  afterAll(async () => {
    await mcp?.close();
    server.stop(true);
    await web.stop();
    ctx.db.close();
    await rm(dir, { recursive: true, force: true });
  });

  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    if (r.isError) throw new Error(r.content[0]!.text);
    return JSON.parse(r.content[0]!.text);
  };

  test("MCP lists all read and write tools", async () => {
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "assign_recurring",
        "categorize_transaction",
        "create_rule",
        "get_account_balances",
        "get_budget_vs_actual",
        "get_business_pnl",
        "get_cashflow",
        "get_net_worth",
        "get_overview",
        "get_pnl",
        "get_pnl_statement",
        "get_recurring",
        "get_review_queue",
        "get_spending_by_category",
        "list_accounts",
        "list_entities",
        "record_transfer",
        "record_valuation",
        "run_simplefin_sync",
        "search_transactions",
        "set_budget",
        "set_entity",
        "split_transaction",
        "update_mapping",
      ].sort(),
    );
    expect(tools.find((t) => t.name === "get_pnl")!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "categorize_transaction")!.annotations?.readOnlyHint).toBe(false);
  });

  test("an AI client gets one entity's P&L and recategorises a transaction over MCP; both are audited", async () => {
    const p = await tool("get_pnl", { entity: "acme", from: "2026-03-01", to: "2026-03-31" });
    // Uncategorised spending counts as expense until it's categorised.
    expect([p.totalIncome, p.totalExpenses]).toEqual(["$5,000.00", "$589.99"]);
    expect(p.expenses.find((l: { account: string }) => l.account === "Expenses:Uncategorized").amount).toBe("$389.99");

    const queue = await tool("get_review_queue");
    const office = queue.find((q: { payee: string }) => q.payee === "OFFICE DEPOT");
    const r = await tool("categorize_transaction", { wmma_id: office.wmma_id, category: "Expenses:Office" });
    expect(r.item.status).toBe("changed");

    const p2 = await tool("get_pnl", { entity: "acme", from: "2026-03-01", to: "2026-03-31" });
    expect(p2.totalExpenses).toBe("$589.99");
    expect(p2.expenses.find((l: { account: string }) => l.account === "Expenses:Office").amount).toBe("$89.99");
    expect(p2.expenses.find((l: { account: string }) => l.account === "Expenses:Uncategorized").amount).toBe("$300.00");

    const audit = (await readFile(ctx.store.paths.audit, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const pnlCall = audit.find((a) => a.operation === "mcp.get_pnl");
    expect(pnlCall).toMatchObject({ actor: me, inputs: { entity: "acme", from: "2026-03-01", to: "2026-03-31" } });
    const recat = audit.find((a) => a.operation === "mcp.categorize_transaction");
    expect(recat).toMatchObject({ actor: me, inputs: { wmma_id: office.wmma_id, category: "Expenses:Office" } });
    const resolve = audit.find((a) => a.operation === "review.resolve" && a.inputs.wmmaId === office.wmma_id);
    expect(resolve.before.account).toBe("Expenses:Uncategorized");
    expect(resolve.after.account).toBe("Expenses:Office");
  });

  test("MCP errors come back as tool errors, and /mcp needs a Tailscale identity", async () => {
    const r = (await mcp.callTool({ name: "get_pnl", arguments: { entity: "nope", from: "2026-03-01", to: "2026-03-31" } })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("unknown entity");
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });

  test("MCP write tools: split, set_entity, transfer, budget, valuation", async () => {
    const wc = (await tool("search_transactions", { text: "warehouse" })).transactions[0];
    const split = await tool("split_transaction", { wmma_id: wc.wmma_id, from: "Expenses:Uncategorized", postings: [{ account: "Expenses:Supplies", amount: "250.00" }, { account: "Expenses:Meals", amount: "50.00" }] });
    expect(split.postings.map((p: { account: string }) => p.account)).toEqual(["Assets:Checking:AcmeChecking", "Expenses:Supplies", "Expenses:Meals"]);
    await expect(tool("split_transaction", { wmma_id: wc.wmma_id, from: "Expenses:Supplies", postings: [{ account: "Expenses:A", amount: "1.00" }, { account: "Expenses:B", amount: "1.00" }] })).rejects.toThrow(/add up/);

    await addAccount(ctx, me, { name: "Personal Checking", kind: "bank", entity: "personal" });
    const t = await tool("record_transfer", { from: "acme-checking", to: "personal-checking", amount: "1000.00", date: "2026-03-25" });
    expect(t.postings.length).toBe(4);
    expect((await tool("set_budget", { entity: "personal", account: "Expenses:Food:Groceries", month: "2026-03", amount: "400.00" })).updated).toBe(1);
    const nw = await tool("get_net_worth", { from: "2026-02", to: "2026-03" });
    expect(nw.series.map((s: { net_worth: string }) => s.net_worth)).toEqual(["$0.00", "$4,410.01"]);
  });

  test("REST: search, patch memo / entity / category", async () => {
    const all = (await call("GET", "/api/v1/transactions?entity=acme&from=2026-03-01&to=2026-03-31")).json;
    expect(all.total).toBe(5);
    const client = (await call("GET", "/api/v1/transactions?text=client")).json.transactions[0];
    const r = await call("PATCH", `/api/v1/transactions/${client.wmma_id}`, { memo: "Invoice 1001", category: "Income:OtherBusiness" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ payee: "CLIENT PAYMENT", note: "Invoice 1001", tags: { cat_by: "manual" } });
    expect(r.json.postings.map((p: { account: string }) => p.account)).toContain("Income:OtherBusiness");
    expect((await call("PATCH", `/api/v1/transactions/${client.wmma_id}`, { memo: null })).json.note).toBeNull();
    expect((await call("PATCH", `/api/v1/transactions/${client.wmma_id}`, { entity: "nobody" })).status).toBe(404);
    expect((await call("PATCH", "/api/v1/transactions/NOPE", { memo: "x" })).status).toBe(404);
    expect((await call("GET", "/api/v1/transactions?category=Expenses:Supplies")).json.total).toBe(1);
  });

  test("REST: mappings regenerate existing transactions", async () => {
    const register = `"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"\n"Personal Checking","","03/05/2026","Market","Food: Groceries","Food","Groceries","",$80.00,$0.00,"Cleared"\n`;
    await importYnabCsv(ctx, me, { filename: "r.csv", content: register, defaultEntity: "personal" });
    const m = (await call("GET", "/api/v1/mappings?source=ynab")).json.mappings;
    expect(m).toEqual([{ source: "ynab", source_category: "Food: Groceries", target_account: "Expenses:Food:Groceries" }]);
    const r = await call("PUT", "/api/v1/mappings", { source: "ynab", sourceCategory: "Food: Groceries", target: "Expenses:Groceries", apply: true });
    expect(r.json.regenerated).toBe(1);
    expect((await call("GET", "/api/v1/transactions?category=Expenses:Groceries")).json.total).toBe(1);
  });

  test("REST: cash flow, spending and net worth reports", async () => {
    const cf = (await call("GET", "/api/v1/reports/cashflow?entity=acme&from=2026-03-01&to=2026-03-31")).json;
    expect(cf.links.find((l: { source: string }) => l.source === "Income:OtherBusiness")).toMatchObject({ target: "Income", value: "$5,000.00" });
    expect(cf.nodes.some((n: { id: string }) => n.id === "Savings")).toBe(true);
    const sp = (await call("GET", "/api/v1/reports/spending?entity=acme&from=2026-03-01&to=2026-03-31&depth=2")).json;
    expect(sp.total).toBe("$589.99");
    expect(sp.categories[0]).toMatchObject({ account: "Expenses:Supplies", amount: "$250.00" });
    expect((await call("GET", "/api/v1/reports/networth?from=2026-03&to=2026-02")).status).toBe(400);
  });

  test("settings: Jev key stored encrypted from the UI, never logged; env key wins", async () => {
    expect((await call("GET", "/api/v1/settings")).json.jev).toEqual({ configured: false, source: null, canStoreInUi: true });
    const r = await call("PUT", "/api/v1/settings", { jevApiKey: "jev-ui-key-abcdef", settings: { "ui.theme": "dark" } });
    expect(r.json).toMatchObject({ settings: { "ui.theme": "dark" }, jev: { configured: true, source: "ui" } });
    expect(ctx.jev).not.toBeNull();
    expect(await ctx.secrets!.get("jev_api_key")).toBe("jev-ui-key-abcdef");
    expect(await readFile(ctx.store.paths.audit, "utf8")).not.toContain("jev-ui-key");
    expect((await call("PUT", "/api/v1/settings", { settings: { "simplefin.last_sync": "x" } })).status).toBe(400);

    const envCtx = { ...ctx, config: { ...ctx.config, jev: { ...ctx.config.jev, apiKey: "from-env-key" } } };
    const res = await createFetchHandler(envCtx)(new Request("http://x/api/v1/settings", { method: "PUT", headers: { "Tailscale-User-Login": me }, body: JSON.stringify({ jevApiKey: "other-key-123" }) }));
    expect(res.status).toBe(409);
  });

  test.skipIf(!hledgerBin)("journals pass hledger check --strict after edits and splits", () => {
    const r = Bun.spawnSync([hledgerBin!, "-f", ctx.store.paths.main, "check", "--strict"], { env: { ...process.env, LANG: "C.UTF-8" } });
    expect(r.stderr.toString()).toBe("");
  });

  test("review queue reflects manual edits", () => {
    expect(listReview(ctx).map((r) => r.payee)).toEqual([]);
  });
});
