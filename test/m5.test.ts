import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../src/audit";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { HledgerWeb } from "../src/hledger/web";
import { normaliseBudgetMonths } from "../src/importers/ynab/api";
import { parsePlanMonth, parseYnabPlanCsv } from "../src/importers/ynab/csv";
import { defaultReiHubAccount, parseReiHubCsv } from "../src/importers/reihub/csv";
import { effectiveAmount, normalise, parseBudgets, renderBudgets, type BudgetChange } from "../src/journal/budgets";
import { transferPostings } from "../src/journal/transfers";
import { JournalStore } from "../src/journal/store";
import * as M from "../src/money";
import { cents, toCents } from "../src/money";
import { createFetchHandler } from "../src/server";
import { importQfx, importReiHub, existingEntries } from "../src/services/bank-imports";
import { createRule } from "../src/services/categorize";
import type { ServiceContext } from "../src/services/context";
import { importYnabCsv } from "../src/services/imports";
import { decodeVin } from "../src/services/assets";
import { freePort, hledgerBin, hledgerWebBin } from "./helpers";

// ---------------------------------------------------------------- unit

describe("budget journal format", () => {
  const b = (entity: string, account: string, month: string, amount: number): BudgetChange => ({ entity, account, month, amount: cents(amount) });

  test("render and parse round-trip, including ranges that stop", () => {
    const changes = [
      b("personal", "Expenses:Food:Groceries", "2026-01", 40000),
      b("personal", "Expenses:Food:Groceries", "2026-03", 50000),
      b("personal", "Expenses:Fun", "2026-01", 10000),
      b("personal", "Expenses:Fun", "2026-02", 0), // stops in February
      b("acme", "Expenses:Advertising", "2026-02", 20000),
    ];
    const text = renderBudgets(changes, "; header\n");
    expect(text).toContain("~ monthly from 2026-01-01 to 2026-02-01  ; wmma_budget:personal\n    (Expenses:Food:Groceries)  $400.00\n    (Expenses:Fun)             $100.00\n");
    expect(text).toContain("~ monthly from 2026-03-01  ; wmma_budget:personal\n    (Expenses:Food:Groceries)  $500.00\n");
    expect(parseBudgets(text)).toEqual(normalise(changes));
  });

  test("a range with no successor means the budget ends", () => {
    const text = renderBudgets([b("p", "Expenses:A", "2026-01", 100), b("p", "Expenses:A", "2026-03", 0)], "");
    expect(text).toContain("from 2026-01-01 to 2026-03-01");
    const parsed = parseBudgets(text);
    expect(toCents(effectiveAmount(parsed, "p", "Expenses:A", "2026-02"))).toBe(100);
    expect(toCents(effectiveAmount(parsed, "p", "Expenses:A", "2026-04"))).toBe(0);
  });

  test("normalise drops repeats and leading zeros", () => {
    expect(normalise([b("p", "Expenses:A", "2026-01", 0), b("p", "Expenses:A", "2026-02", 5), b("p", "Expenses:A", "2026-03", 5)]).map((c) => c.month)).toEqual(["2026-02"]);
  });
});

describe("transfers between entities", () => {
  test("go through due-to / due-from and balance per entity", () => {
    const ps = transferPostings({ hledgerAccount: "Assets:Checking:Acme", entity: "acme" }, { hledgerAccount: "Assets:Checking:Me", entity: "personal" }, cents(100000));
    expect(M.sum(ps.map((p) => p.amount))).toBe(M.ZERO);
    for (const e of ["acme", "personal"]) expect(M.sum(ps.filter((p) => p.tags?.["entity"] === e).map((p) => p.amount))).toBe(M.ZERO);
    expect(ps.map((p) => p.account)).toEqual(["Assets:Checking:Acme", "Assets:DueFrom:Personal", "Assets:Checking:Me", "Liabilities:DueTo:Acme"]);
  });
});

describe("YNAB budget sources", () => {
  test("plan CSV", () => {
    const csv = `"Month","Category Group/Category","Category Group","Category","Assigned","Activity","Available"\n"Jan 2026","Bills: Rent","Bills","Rent",$1500.00,-$1500.00,$0.00\n"Feb 2026","Bills: Rent","Bills","Rent",$1550.00,$0.00,$1550.00\n`;
    expect(parseYnabPlanCsv(csv).map((r) => [r.month, r.group, r.name, toCents(r.amount)])).toEqual([
      ["2026-01", "Bills", "Rent", 150000],
      ["2026-02", "Bills", "Rent", 155000],
    ]);
    expect(parsePlanMonth("January 2026")).toBe("2026-01");
    expect(parsePlanMonth("2026-11-01")).toBe("2026-11");
    expect(() => parseYnabPlanCsv("a,b\n1,2\n")).toThrow(/plan export/);
  });
  test("API months", () => {
    const out = normaliseBudgetMonths([
      { month: "2026-01-01", categories: [{ name: "Rent", category_group_name: "Bills", budgeted: 1500000 }, { name: "Old", category_group_name: "Bills", budgeted: 1000, deleted: true }] },
    ]);
    expect(out).toEqual([{ month: "2026-01", group: "Bills", name: "Rent", amount: cents(150000) }]);
  });
});

describe("REI Hub CSV", () => {
  test("finds columns by common names; income/expense columns", () => {
    const rows = parseReiHubCsv("Transaction Date,Property Name,Category,Vendor,Notes,Income,Expense\n2026-03-01,Maple St,Rent Income,Tenant A,March,1500.00,\n2026-03-05,Maple St,Repairs,Plumber,,,200.00\n");
    expect(rows.map((r) => [r.date, r.property, r.category, r.payee, toCents(r.amount)])).toEqual([
      ["2026-03-01", "Maple St", "Rent Income", "Tenant A", 150000],
      ["2026-03-05", "Maple St", "Repairs", "Plumber", -20000],
    ]);
  });
  test("column overrides and errors", () => {
    expect(parseReiHubCsv("When,What,How much\n03/01/2026,Insurance,-90\n", { columns: { date: "When", category: "What", amount: "How much" } })[0]!.amount).toBe(cents(-9000));
    expect(() => parseReiHubCsv("Foo,Bar\n1,2\n")).toThrow(/date column/);
  });
  test("default Schedule E mapping", () => {
    expect(defaultReiHubAccount("Rent Income", true)).toBe("Income:Rents");
    expect(defaultReiHubAccount("Plumbing Repairs", false)).toBe("Expenses:Repairs");
    expect(defaultReiHubAccount("Mortgage Interest", false)).toBe("Expenses:Interest:Mortgage");
    expect(defaultReiHubAccount("Property Taxes", false)).toBe("Expenses:Taxes:Property");
    expect(defaultReiHubAccount("HOA dues", false)).toBe("Expenses:OtherRental");
  });
});

// ---------------------------------------------------------------- end to end

function qfx(acctId: string, txns: Array<[string, string, string, string]>) {
  const trn = txns.map(([f, d, a, n]) => `<STMTTRN><TRNTYPE>OTHER<DTPOSTED>${d.replaceAll("-", "")}<TRNAMT>${a}<FITID>${f}<NAME>${n}</STMTTRN>`).join("\n");
  return `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>9<ACCTID>${acctId}<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST>\n${trn}\n</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
}

describe("VIN decoding", () => {
  const nhtsa = (result: Record<string, string>) => (async (url: string) => {
    expect(url).toBe("https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/2T3P1RFV8MC123456?format=json");
    return Response.json({ Results: [result] });
  }) as unknown as typeof fetch;

  test("decodes year, make, model and trim; title-cases shouted makes", async () => {
    const v = await decodeVin(" 2t3p1rfv8mc123456 ", nhtsa({ ModelYear: "2021", Make: "TOYOTA", Model: "RAV4", Trim: "XLE", BodyClass: "Sport Utility Vehicle (SUV)/Multi-Purpose Vehicle (MPV)" }));
    expect(v).toMatchObject({ vin: "2T3P1RFV8MC123456", year: 2021, make: "Toyota", model: "RAV4", trim: "XLE" });
  });
  test("rejects malformed VINs without a network call", async () => {
    const never = (async () => {
      throw new Error("should not fetch");
    }) as unknown as typeof fetch;
    await expect(decodeVin("ABC", never)).rejects.toThrow(/17 letters/);
    await expect(decodeVin("2T3P1RFV8MC12345O", never)).rejects.toThrow(/no I, O or Q/);
  });
  test("an undecodable VIN is a clear 422", async () => {
    await expect(decodeVin("2T3P1RFV8MC123456", nhtsa({ ModelYear: "", Make: "", Model: "" }))).rejects.toMatchObject({ status: 422 });
  });
});

describe.skipIf(!hledgerWebBin)("entities, transfers, valuations, budgets, REI Hub (M5 done-when)", () => {
  let dir: string;
  let web: HledgerWeb;
  let ctx: ServiceContext;
  let call: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>;
  const me = "alice@example.com";
  const marchPnl = async (entity: string) => (await call("GET", `/api/v1/reports/pnl?entity=${entity}&from=2026-03-01&to=2026-03-31`)).json;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "wmma-m5-"));
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
  });
  afterAll(async () => {
    await web.stop();
    ctx.db.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("adding entities declares their template accounts with form lines", async () => {
    expect((await call("POST", "/api/v1/entities", { name: "Acme LLC", type: "schedule_c", slug: "acme" })).status).toBe(201);
    expect((await call("POST", "/api/v1/entities", { name: "Household", type: "personal", slug: "personal" })).status).toBe(201);
    expect((await call("POST", "/api/v1/entities", { name: "x", type: "bogus" })).status).toBe(400);
    const accounts = await readFile(ctx.store.paths.accounts, "utf8");
    expect(accounts).toContain("account Expenses:Advertising  ; type:X, sch_c:8\n");
    expect(accounts).toContain("account Income:GrossReceipts  ; type:R, sch_c:1\n");
    expect(accounts).toContain("account Expenses:Food:Groceries  ; type:X\n");
  });

  test("accounts and categorised activity", async () => {
    for (const [name, kind, entity] of [
      ["Acme Checking", "bank", "acme"],
      ["Personal Checking", "bank", "personal"],
      ["House", "real_estate", "personal"],
    ]) {
      expect((await call("POST", "/api/v1/accounts", { name, kind, entity })).status).toBe(201);
    }
    await createRule(ctx, me, { match: { payeeContains: "client" }, target: "Income:GrossReceipts" });
    await createRule(ctx, me, { match: { payeeContains: "ads" }, target: "Expenses:Advertising" });
    await createRule(ctx, me, { match: { payeeContains: "grocer" }, target: "Expenses:Food:Groceries" });
    await importQfx(ctx, me, {
      filename: "acme.qfx",
      account: "acme-checking",
      content: qfx("500", [
        ["A1", "2026-03-02", "5000.00", "CLIENT PAYMENT"],
        ["A2", "2026-03-10", "-200.00", "ADS INC"],
      ]),
    });
    await importQfx(ctx, me, {
      filename: "personal.qfx",
      account: "personal-checking",
      content: qfx("600", [
        ["P1", "2026-01-10", "-300.00", "GROCER"],
        ["P2", "2026-02-10", "-450.00", "GROCER"],
        ["P3", "2026-03-10", "-600.00", "GROCER"],
      ]),
    });
    const p = await marchPnl("acme");
    expect([p.totalIncome, p.totalExpenses, p.net]).toEqual(["$5,000.00", "$200.00", "$4,800.00"]);
  });

  test("an inter-entity transfer affects neither P&L", async () => {
    const before = [await marchPnl("acme"), await marchPnl("personal")];
    const r = await call("POST", "/api/v1/transfers", { from: "acme-checking", to: "personal-checking", amount: "1000.00", date: "2026-03-15", memo: "owner draw" });
    expect(r.status).toBe(201);
    expect(r.json.postings.map((p: { account: string }) => p.account)).toEqual(["Assets:Checking:AcmeChecking", "Assets:DueFrom:Personal", "Assets:Checking:PersonalChecking", "Liabilities:DueTo:Acme"]);
    expect([await marchPnl("acme"), await marchPnl("personal")]).toEqual(before);
    const accounts = (await call("GET", "/api/v1/accounts")).json.accounts;
    expect(accounts.find((a: { slug: string }) => a.slug === "acme-checking").balance).toBe("$3,800.00");
  });

  test("valuations don't affect P&L", async () => {
    const before = await marchPnl("personal");
    expect((await call("POST", "/api/v1/valuations", { account: "house", date: "2026-03-01", value: "400000.00" })).json).toMatchObject({ previous: "$0.00", change: "$400,000.00" });
    expect((await call("POST", "/api/v1/valuations", { account: "house", date: "2026-03-31", value: "410000.00" })).json).toMatchObject({ previous: "$400,000.00", change: "$10,000.00" });
    expect((await call("POST", "/api/v1/valuations", { account: "personal-checking", date: "2026-03-31", value: "1" })).status).toBe(400);
    expect(await marchPnl("personal")).toEqual(before);
    const all = (await call("GET", "/api/v1/reports/pnl?from=2026-01-01&to=2026-12-31")).json;
    expect(all.income.map((l: { account: string }) => l.account)).not.toContain("Equity:Unrealized");
  });

  test("vehicles: details, opening value, linked loan, mileage and value history", async () => {
    expect((await call("POST", "/api/v1/accounts", { name: "Car Loan", kind: "loan", entity: "personal" })).status).toBe(201);
    const bad = await call("POST", "/api/v1/accounts", { name: "x", kind: "vehicle", entity: "personal", details: { vin: "IIIIIIIIIIIIIIIII" } });
    expect(bad.status).toBe(400);
    expect((await call("POST", "/api/v1/accounts", { name: "y", kind: "bank", entity: "personal", details: { make: "Toyota" } })).status).toBe(400);
    expect((await call("POST", "/api/v1/accounts", { name: "z", kind: "vehicle", entity: "personal", details: { address: "1 Main" } })).status).toBe(400);

    const created = await call("POST", "/api/v1/accounts", {
      name: "2021 Toyota RAV4",
      kind: "vehicle",
      entity: "personal",
      details: { year: "2021", make: "Toyota", model: "RAV4", trim: "XLE", vin: "2t3p1rfv8mc123456", mileage: "42,180", purchasePrice: "$32,500", purchaseDate: "2021-06-01" },
      linkedLoan: "car-loan",
      value: { value: "24000.00", date: "2026-03-01" },
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ kind: "vehicle", linked_loan: "car-loan", hledger_account: "Assets:Vehicles:2021ToyotaRAV4" });
    const car = (await call("GET", "/api/v1/accounts")).json.accounts.find((a: { slug: string }) => a.slug === created.json.slug);
    expect(car.balance).toBe("$24,000.00");
    expect(car.details).toEqual({ year: 2021, make: "Toyota", model: "RAV4", trim: "XLE", vin: "2T3P1RFV8MC123456", mileage: 42180, purchaseDate: "2021-06-01", purchasePrice: "32500.00" });

    // One loan per asset.
    expect((await call("PATCH", "/api/v1/accounts/house", { linkedLoan: "car-loan" })).status).toBe(409);
    expect((await call("PATCH", "/api/v1/accounts/house", { linkedLoan: "personal-checking" })).status).toBe(404);

    // A bad odometer reading is rejected before the valuation is booked.
    expect((await call("POST", "/api/v1/valuations", { account: car.slug, date: "2026-04-01", value: "23000", mileage: "lots" })).status).toBe(400);
    expect((await call("POST", "/api/v1/valuations", { account: car.slug, date: "2026-05-01", value: "23000", mileage: "45000" })).status).toBe(201);
    // An older reading never overwrites a newer one.
    expect((await call("POST", "/api/v1/valuations", { account: car.slug, date: "2026-04-01", value: "23500", mileage: "43000" })).status).toBe(201);
    const after = (await call("GET", "/api/v1/accounts")).json.accounts.find((a: { slug: string }) => a.slug === car.slug);
    expect(after.details).toMatchObject({ mileage: 45000, mileageAsOf: "2026-05-01" });

    const history = (await call("GET", `/api/v1/accounts/${car.slug}/valuations`)).json.valuations;
    expect(history.map((v: { date: string; value: string }) => [v.date, v.value])).toEqual([
      ["2026-03-01", "$24,000.00"],
      ["2026-04-01", "$23,500.00"],
      ["2026-05-01", "$23,000.00"],
    ]);

    // Editing replaces details; null clears the loan.
    const patched = await call("PATCH", `/api/v1/accounts/${car.slug}`, { details: { year: 2021, make: "Toyota", model: "RAV4 Hybrid" }, linkedLoan: null });
    expect(patched.status).toBe(200);
    expect(patched.json.linked_loan).toBeNull();
    expect(JSON.parse(patched.json.details)).toEqual({ year: 2021, make: "Toyota", model: "RAV4 Hybrid" });
    expect((await call("PATCH", "/api/v1/accounts/house", { linkedLoan: "car-loan" })).status).toBe(200);
  });

  test("budgets roll unspent money over and carry overspending", async () => {
    expect(
      (
        await call("PUT", "/api/v1/budgets", [
          { entity: "personal", account: "Expenses:Food:Groceries", month: "2026-01", amount: "400.00" },
          { entity: "personal", account: "Expenses:Food:Groceries", month: "2026-03", amount: "500.00" },
        ])
      ).json,
    ).toEqual({ updated: 2 });
    const feb = (await call("GET", "/api/v1/reports/budget?entity=personal&month=2026-02")).json;
    expect(feb.lines[0]).toMatchObject({ budgeted: "$400.00", activity: "$450.00", rolledOver: "$100.00", available: "$50.00" });
    const mar = (await call("GET", "/api/v1/reports/budget?entity=personal&month=2026-03")).json;
    expect(mar.lines[0]).toMatchObject({ account: "Expenses:Food:Groceries", budgeted: "$500.00", activity: "$600.00", rolledOver: "$50.00", available: "-$50.00" });
    expect((await call("PUT", "/api/v1/budgets", [{ entity: "personal", account: "Income:Salary", month: "2026-01", amount: "1" }])).status).toBe(400);
    expect((await call("GET", "/api/v1/budgets?entity=personal")).json.budgets.length).toBe(2);
  });

  test("an archived entity's history still appears in past reports", async () => {
    const before = await marchPnl("acme");
    const r = await call("PATCH", "/api/v1/entities/acme", { archive: { date: "2026-06-30" } });
    expect(r.json.closedAccounts).toEqual(["acme-checking"]);
    expect(await marchPnl("acme")).toEqual(before);
    expect((await call("GET", "/api/v1/entities")).json.entities.map((e: { slug: string }) => e.slug)).not.toContain("acme");
    expect((await call("GET", "/api/v1/entities?status=all")).json.entities.map((e: { slug: string }) => e.slug)).toContain("acme");
    expect(await readFile(ctx.store.paths.accounts, "utf8")).toContain("account Assets:Checking:AcmeChecking  ; type:A, closed:2026-06-30\n");
    expect((await call("PATCH", "/api/v1/entities/acme", { archive: { date: "2026-07-01" } })).status).toBe(409);
    expect((await call("POST", "/api/v1/accounts", { name: "New", kind: "bank", entity: "acme" })).status).toBe(409);
  });

  test("REI Hub: categories kept, properties map to entities, bank duplicates merged and categorised", async () => {
    expect((await call("POST", "/api/v1/entities", { name: "Rentals", type: "schedule_e", slug: "rentals" })).status).toBe(201);
    expect((await call("POST", "/api/v1/accounts", { name: "Rental Checking", kind: "bank", entity: "rentals" })).status).toBe(201);
    // The bank feed saw the rent deposit first (uncategorised).
    await importQfx(ctx, me, { filename: "rental.qfx", account: "rental-checking", content: qfx("700", [["R1", "2026-03-01", "1500.00", "TENANT A DEPOSIT"]]) });

    const csv = [
      "Date,Property,Category,Payee,Description,Amount,Account",
      "03/01/2026,Maple St,Rent Income,Tenant A,March rent,1500.00,Rental Checking",
      "03/05/2026,Maple St,Repairs,Plumber,Leak,-200.00,Rental Checking",
      "03/06/2026,Oak Ave,Utilities,City Water,,-45.00,Rental Checking",
    ].join("\n");
    const r = await importReiHub(ctx, me, { filename: "reihub.csv", content: csv, properties: { "Oak Ave": "oak" } });
    expect(r).toMatchObject({ added: 2, merged: 1, needsReview: 0 });

    const entries = await ctx.hledger.transactions();
    const rent = entries.find((t) => t.tdescription.startsWith("TENANT A"))!;
    expect(rent.tpostings.map((p) => p.paccount)).toContain("Income:Rents");
    expect(new Map(rent.ttags).get("cat_by")).toBe("mapping");
    expect(new Map(rent.ttags).get("property")).toBe("Maple St");
    const water = entries.find((t) => t.tdescription.startsWith("City Water"))!;
    expect(new Map(water.ttags).get("entity")).toBe("oak");
    expect(water.tpostings.map((p) => p.paccount)).toContain("Expenses:Utilities");

    const again = await importReiHub(ctx, me, { filename: "reihub.csv", content: csv, properties: { "Oak Ave": "oak" } });
    expect([again.added, again.merged, again.skippedDuplicates]).toEqual([0, 0, 3]);
    const rentals = await marchPnl("rentals");
    expect([rentals.totalIncome, rentals.totalExpenses]).toEqual(["$1,500.00", "$200.00"]);
    expect((await marchPnl("oak")).totalExpenses).toBe("$45.00");
    expect(existingEntries(entries).filter((e) => e.postings.some((p) => p.account === "Assets:Checking:RentalChecking")).length).toBe(3);
  });

  test("YNAB plan CSV imports past budget amounts idempotently", async () => {
    const register = `"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"\n"Personal Checking","","01/05/2026","Landlord","Bills: Rent","Bills","Rent","",$1500.00,$0.00,"Cleared"\n`;
    const plan = `"Month","Category Group/Category","Category Group","Category","Assigned","Activity","Available"\n"Jan 2026","Bills: Rent","Bills","Rent",$1500.00,-$1500.00,$0.00\n"Feb 2026","Bills: Rent","Bills","Rent",$1550.00,$0.00,$1550.00\n"Jan 2026","Inflow: Ready to Assign","Inflow","Ready to Assign",$0.00,$0.00,$0.00\n`;
    for (let i = 0; i < 2; i++) {
      const r = await importYnabCsv(ctx, me, { filename: "reg.csv", content: register, plan: { filename: "plan.csv", content: plan }, defaultEntity: "personal" });
      expect(r.budgets).toEqual({ months: 2, amounts: 2 });
    }
    const rent = (await call("GET", "/api/v1/budgets?entity=personal")).json.budgets.filter((b: { account: string }) => b.account === "Expenses:Bills:Rent");
    expect(rent.map((b: { month: string; amount: string }) => [b.month, b.amount])).toEqual([
      ["2026-01", "$1,500.00"],
      ["2026-02", "$1,550.00"],
    ]);
  });

  test.skipIf(!hledgerBin)("journals (budgets included) pass hledger check --strict and hledger reads the budget", () => {
    const env = { ...process.env, LANG: "C.UTF-8" };
    const check = Bun.spawnSync([hledgerBin!, "-f", ctx.store.paths.main, "check", "--strict"], { env });
    expect(check.stderr.toString()).toBe("");
    const bud = Bun.spawnSync([hledgerBin!, "-f", ctx.store.paths.main, "bal", "--budget", "-M", "-b", "2026-03", "-e", "2026-04", "Expenses:Food:Groceries", "-O", "csv"], { env });
    expect(bud.stdout.toString()).toContain("$500.00");
  });
});
