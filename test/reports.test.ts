import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../src/audit";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { HledgerWeb, type HledgerTransaction } from "../src/hledger/web";
import { JournalStore } from "../src/journal/store";
import { createFetchHandler } from "../src/server";
import { importQfx } from "../src/services/bank-imports";
import { createRule } from "../src/services/categorize";
import type { ServiceContext } from "../src/services/context";
import { addMonths, detectRecurring, payeeKey, periodsBetween, periodStart } from "../src/services/insights";
import { freePort, hledgerWebBin } from "./helpers";

// ---------------------------------------------------------------- unit

describe("periods", () => {
  test("period starts for each interval", () => {
    expect(periodStart("2026-11-18", "week")).toBe("2026-11-16"); // Monday
    expect(periodStart("2026-11-18", "month")).toBe("2026-11-01");
    expect(periodStart("2026-11-18", "quarter")).toBe("2026-10-01");
    expect(periodStart("2026-11-18", "year")).toBe("2026-01-01");
  });
  test("periods are clipped to the range", () => {
    expect(periodsBetween("2026-02-15", "2026-04-10", "month")).toEqual([
      { start: "2026-02-15", end: "2026-02-28" },
      { start: "2026-03-01", end: "2026-03-31" },
      { start: "2026-04-01", end: "2026-04-10" },
    ]);
    expect(periodsBetween("2025-12-01", "2026-11-18", "quarter").map((p) => p.start)).toEqual(["2025-12-01", "2026-01-01", "2026-04-01", "2026-07-01", "2026-10-01"]);
    expect(() => periodsBetween("2000-01-01", "2026-01-01", "day")).toThrow(/at most/);
  });
  test("adding months keeps the day where it can", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-11-15", 3)).toBe("2027-02-15");
  });
});

/** A minimal hledger transaction: a card charge or deposit against one category. */
function tx(date: string, payee: string, category: string, cents: number, entity = "personal", kind?: string): HledgerTransaction {
  const q = (c: number) => [{ acommodity: "$", aquantity: { decimalMantissa: c, decimalPlaces: 2 } }];
  return {
    tindex: 0,
    tdate: date,
    tdescription: payee,
    ttags: [["entity", entity], ["wmma_id", `${date}-${payee}`], ...(kind ? [["kind", kind] as [string, string]] : [])],
    tpostings: [
      { paccount: category, pamount: q(cents), ptags: [] },
      { paccount: "Assets:Checking:Main", pamount: q(-cents), ptags: [] },
    ],
    tsourcepos: [],
  };
}

describe("recurring detection", () => {
  const today = "2026-11-18";
  const monthly = (payee: string, day: string, cents: number, months = 6, category = "Expenses:Subscriptions") =>
    Array.from({ length: months }, (_, i) => tx(addMonths(`2026-${String(11 - months + 1 + i).padStart(2, "0")}-${day}`, 0), payee, category, cents));

  test("finds a monthly subscription and predicts the next charge", () => {
    const items = detectRecurring(monthly("NETFLIX.COM 8842", "12", 1599), { today });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ payee: "NETFLIX.COM 8842", kind: "expense", frequency: "monthly", amount_cents: 1599, next_date: "2026-12-12", monthly_cents: 1599, yearly_cents: 19188, status: "active", variable: false });
  });
  test("payee spellings that differ only by numbers group together", () => {
    expect(payeeKey("SPOTIFY P1A2B3 #4421")).toBe(payeeKey("SPOTIFY P9Z8 #1102"));
    const txns = monthly("GYM #1", "03", 4000).map((t, i) => ({ ...t, tdescription: `GYM #${i + 10}` }));
    expect(detectRecurring(txns, { today })).toHaveLength(1);
  });
  test("biweekly paychecks are income", () => {
    const pays = Array.from({ length: 8 }, (_, i) => tx(new Date(Date.UTC(2026, 7, 7) + i * 14 * 86_400_000).toISOString().slice(0, 10), "ACME PAYROLL", "Income:Salary", -250000));
    const [item] = detectRecurring(pays, { today });
    expect(item).toMatchObject({ kind: "income", frequency: "biweekly", amount_cents: 250000, yearly_cents: 6500000 });
  });
  test("irregular payees, wildly varying amounts, transfers and long-stopped charges are left out", () => {
    const irregular = ["2026-03-01", "2026-03-05", "2026-06-20", "2026-07-01"].map((d) => tx(d, "HARDWARE", "Expenses:Home", 5000));
    const varying = monthly("AMAZON", "05", 1000).map((t, i) => tx(t.tdate, "AMAZON", "Expenses:Shopping", [1000, 25000, 300, 9000, 150, 40000][i]!));
    const transfers = monthly("TO SAVINGS", "01", 50000).map((t) => tx(t.tdate, "TO SAVINGS", "Expenses:Other", 50000, "personal", "transfer"));
    const stopped = ["2025-11-02", "2025-12-02", "2026-01-02", "2026-02-02"].map((d) => tx(d, "OLD GYM", "Expenses:Fitness", 3000));
    expect(detectRecurring([...irregular, ...varying, ...transfers, ...stopped], { today })).toEqual([]);
  });
  test("a missed charge is late, and entity filtering applies", () => {
    const late = monthly("INSURER", "01", 12000, 6, "Expenses:Insurance").slice(0, 5); // last on Oct 1, Nov 1 missed
    const items = detectRecurring(late, { today: "2026-11-20" });
    expect(items[0]?.status).toBe("late");
    expect(detectRecurring(late, { today: "2026-11-20", entity: "acme" })).toEqual([]);
  });
});

// ---------------------------------------------------------------- end to end

function qfx(acctId: string, txns: Array<[string, string, string, string]>) {
  const trn = txns.map(([f, d, a, n]) => `<STMTTRN><TRNTYPE>OTHER<DTPOSTED>${d.replaceAll("-", "")}<TRNAMT>${a}<FITID>${f}<NAME>${n}</STMTTRN>`).join("\n");
  return `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>9<ACCTID>${acctId}<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST>\n${trn}\n</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
}

describe.skipIf(!hledgerWebBin)("report endpoints", () => {
  let dir: string;
  let web: HledgerWeb;
  let ctx: ServiceContext;
  let call: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>;
  const me = "alice@example.com";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "wmma-reports-"));
    const store = new JournalStore(dir);
    await store.init();
    web = new HledgerWeb({ bin: hledgerWebBin!, port: await freePort(), journal: store.paths.main, log: () => {} });
    await web.start();
    ctx = { config: loadConfig({ WMMA_ALLOWED_USERS: me, WMMA_DATA_DIR: dir }), db: openDb(store.paths.db), store, hledger: web.client, audit: new AuditLog(store.paths.audit), jev: null };
    const handler = createFetchHandler(ctx);
    call = async (method, path, body) => {
      const res = await handler(new Request(`http://x${path}`, { method, headers: { "Tailscale-User-Login": me }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
      return { status: res.status, json: await res.json() };
    };
    await call("POST", "/api/v1/entities", { name: "Acme LLC", type: "schedule_c", slug: "acme" });
    await call("POST", "/api/v1/entities", { name: "Household", type: "personal", slug: "personal" });
    await call("POST", "/api/v1/accounts", { name: "Acme Checking", kind: "bank", entity: "acme" });
    await call("POST", "/api/v1/accounts", { name: "Personal Checking", kind: "bank", entity: "personal" });
    await call("POST", "/api/v1/accounts", { name: "Brokerage", kind: "investment", entity: "personal" });
    await createRule(ctx, me, { match: { payeeContains: "client" }, target: "Income:GrossReceipts" });
    await createRule(ctx, me, { match: { payeeContains: "ads" }, target: "Expenses:Advertising" });
    await createRule(ctx, me, { match: { payeeContains: "grocer" }, target: "Expenses:Food:Groceries" });
    await createRule(ctx, me, { match: { payeeContains: "payroll" }, target: "Income:Salary" });
    await importQfx(ctx, me, {
      filename: "acme.qfx",
      account: "acme-checking",
      content: qfx("500", [
        ["A1", "2026-01-05", "3000.00", "CLIENT ONE"],
        ["A2", "2026-02-05", "2000.00", "CLIENT TWO"],
        ["A3", "2026-02-10", "-500.00", "ADS INC"],
      ]),
    });
    await importQfx(ctx, me, {
      filename: "personal.qfx",
      account: "personal-checking",
      content: qfx("600", [
        ["P1", "2026-01-01", "4000.00", "PAYROLL"],
        ["P2", "2026-01-10", "-300.00", "GROCER #1"],
        ["P3", "2026-02-10", "-450.00", "GROCER #2"],
        ["P4", "2026-03-10", "-600.00", "GROCER #3"],
      ]),
    });
  });
  afterAll(async () => {
    await web.stop();
    ctx.db.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("overview: totals, categories, merchants and stats", async () => {
    const o = (await call("GET", "/api/v1/reports/overview?from=2026-01-01&to=2026-03-31")).json;
    expect([o.income.total_cents, o.expenses.total_cents, o.net_cents]).toEqual([900000, 185000, 715000]);
    expect(o.savings_rate).toBe(79.4);
    expect(o.expenses.categories[0]).toEqual({ account: "Expenses:Food:Groceries", cents: 135000, count: 3 });
    expect(o.expenses.merchants.map((m: any) => m.name)).toEqual(["GROCER #3", "ADS INC", "GROCER #2", "GROCER #1"]);
    expect(o.expenses).toMatchObject({ count: 4, largest_cents: 60000, first_date: "2026-01-10", last_date: "2026-03-10" });
    const acme = (await call("GET", "/api/v1/reports/overview?entity=acme&from=2026-01-01&to=2026-03-31")).json;
    expect([acme.income.total_cents, acme.expenses.total_cents]).toEqual([500000, 50000]);
    // All time when the range is left out.
    expect((await call("GET", "/api/v1/reports/overview")).json.from).toBe("2026-01-01");
    expect((await call("GET", "/api/v1/reports/overview?entity=nope")).status).toBe(404);
  });

  test("series: income and expenses per period, with category stacks", async () => {
    const s = (await call("GET", "/api/v1/reports/series?from=2026-01-01&to=2026-03-31&interval=month&stack=expense&top=1")).json;
    expect(s.periods.map((p: any) => [p.start, p.income_cents, p.expenses_cents])).toEqual([
      ["2026-01-01", 700000, 30000],
      ["2026-02-01", 200000, 95000],
      ["2026-03-01", 0, 60000],
    ]);
    expect(s.stack).toEqual({ keys: ["Expenses:Food:Groceries", "Other"], values: [[30000, 45000, 60000], [0, 50000, 0]] });
    const q = (await call("GET", "/api/v1/reports/series?from=2026-01-01&to=2026-03-31&interval=quarter")).json;
    expect(q.periods).toHaveLength(1);
    expect((await call("GET", "/api/v1/reports/series?interval=fortnight")).status).toBe(400);
  });

  test("businesses and a Schedule C statement with form lines", async () => {
    const b = (await call("GET", "/api/v1/reports/businesses?from=2026-01-01&to=2026-03-31")).json;
    const acme = b.entities.find((e: any) => e.slug === "acme");
    expect(acme).toMatchObject({ income_cents: 500000, expenses_cents: 50000, net_cents: 450000, margin: 90 });
    expect(acme.income_series).toEqual([300000, 200000, 0]);
    const st = (await call("GET", "/api/v1/reports/statement?entity=acme&from=2026-01-01&to=2026-03-31&interval=month")).json;
    expect(st.income).toEqual([{ account: "Income:GrossReceipts", line: "1", values: [300000, 200000, 0], total_cents: 500000 }]);
    expect(st.expenses[0]).toMatchObject({ account: "Expenses:Advertising", line: "8", total_cents: 50000 });
    expect(st.totals).toMatchObject({ net: [300000, 150000, 0], net_total: 450000 });
    expect(st.form_lines).toContainEqual({ account: "Expenses:Supplies", line: "22" });
    const total = (await call("GET", "/api/v1/reports/statement?entity=acme&from=2026-01-01&to=2026-03-31&interval=total")).json;
    expect(total.periods).toEqual([{ start: "2026-01-01", end: "2026-03-31" }]);
  });

  test("balances: per-account history, flows and valuations", async () => {
    await call("POST", "/api/v1/valuations", { account: "brokerage", date: "2026-02-15", value: "10000.00" });
    await call("POST", "/api/v1/transfers", { from: "personal-checking", to: "brokerage", amount: "500.00", date: "2026-03-01" });
    const h = (await call("GET", "/api/v1/reports/balances?from=2026-01-01&to=2026-03-31&interval=month")).json;
    const brokerage = h.accounts.find((a: any) => a.slug === "brokerage");
    expect(brokerage).toMatchObject({ kind: "investment", balance_cents: [0, 1000000, 1050000], flow_cents: [0, 0, 50000], valuation_cents: [0, 1000000, 0] });
    const checking = h.accounts.find((a: any) => a.slug === "personal-checking");
    expect(checking.balance_cents).toEqual([370000, 325000, 215000]);
    expect(h.net_worth_cents.at(-1)).toBe(215000 + 450000 + 1050000);
    const personal = (await call("GET", "/api/v1/reports/balances?from=2026-03-01&to=2026-03-31&entity=acme")).json;
    expect(personal.accounts.map((a: any) => a.slug)).toEqual(["acme-checking"]);
  });

  test("budgets can plan income alongside expenses", async () => {
    expect((await call("PUT", "/api/v1/budgets", [{ entity: "personal", account: "Income:Salary", month: "2026-01", amount: "4500.00" }])).status).toBe(200);
    expect((await call("PUT", "/api/v1/budgets", [{ entity: "personal", account: "Assets:Checking:PersonalChecking", month: "2026-01", amount: "1" }])).status).toBe(400);
    await call("PUT", "/api/v1/budgets", [{ entity: "personal", account: "Expenses:Food:Groceries", month: "2026-01", amount: "400.00" }]);
    const jan = (await call("GET", "/api/v1/reports/budget?entity=personal&month=2026-01")).json;
    expect(jan.income).toEqual([{ account: "Income:Salary", budgeted: "$4,500.00", budgeted_cents: 450000, actual: "$4,000.00", actual_cents: 400000, planned: true }]);
    expect(jan.lines.map((l: any) => l.account)).toEqual(["Expenses:Food:Groceries"]);
    expect(jan.lines[0]).toMatchObject({ budgeted_cents: 40000, activity_cents: 30000, available_cents: 10000 });
  });

  test("recurring endpoint", async () => {
    const r = (await call("GET", "/api/v1/reports/recurring")).json;
    expect(r).toMatchObject({ items: expect.any(Array), monthly_expense_cents: expect.any(Number) });
  });
});
