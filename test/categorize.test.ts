import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../src/audit";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { HledgerWeb, type HledgerTransaction } from "../src/hledger/web";
import { JevClient, JevError } from "../src/jev";
import { JournalStore } from "../src/journal/store";
import { cents } from "../src/money";
import { createFetchHandler } from "../src/server";
import { importQfx } from "../src/services/bank-imports";
import { allowedCategories, describeAccount, findUncategorized, listReview, payeeKey, resolveReview, ruleMatches } from "../src/services/categorize";
import type { ServiceContext } from "../src/services/context";
import { freePort, hledgerBin, hledgerWebBin } from "./helpers";

// ---------------------------------------------------------------- fake Jev

interface JevCall {
  state: string;
  criteria: Record<string, string>;
  auth: string | null;
  body: any;
}

/** Answers by payee: COFFEE confidently, GROCER unsure, MYSTERY fails, everything else unsure. */
function fakeJev(calls: JevCall[]): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const q = body.questions.category;
    calls.push({ state: body.state, criteria: q.criteria, auth: new Headers(init.headers).get("Authorization"), body });
    const opts = Object.keys(q.criteria);
    const answer = (choice: string, confidence: number, probs: Record<string, number>) =>
      Response.json({ model: "jev-test", answers: { category: { type: "choice", choice, probabilities: probs, confidence } }, usage: {} });
    if (body.state.includes("MYSTERY")) return new Response("boom", { status: 500 });
    if (body.state.includes("COFFEE")) return answer("Expenses:Food:Coffee", 0.96, { "Expenses:Food:Coffee": 0.96 });
    if (body.state.includes("GROCER"))
      return answer("Expenses:Food:Groceries", 0.62, { "Expenses:Food:Groceries": 0.62, "Expenses:Food:Dining": 0.3, "Expenses:Food:Coffee": 0.05, "Expenses:Shopping": 0.03 });
    return answer(opts[0]!, 0.4, { [opts[0]!]: 0.4 });
  }) as unknown as typeof fetch;
}

function qfx(acctId: string, txns: Array<[string, string, string, string]>) {
  const trn = txns
    .map(([f, d, a, n]) => `<STMTTRN><TRNTYPE>OTHER<DTPOSTED>${d.replaceAll("-", "")}<TRNAMT>${a}<FITID>${f}<NAME>${n}</STMTTRN>`)
    .join("\n");
  return `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>1<ACCTID>${acctId}<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST>\n${trn}\n</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
}

// ---------------------------------------------------------------- unit

describe("helpers", () => {
  test("payeeKey drops store numbers and punctuation", () => {
    expect(payeeKey("GROCER #12")).toBe("grocer");
    expect(payeeKey("Grocer #13 ")).toBe("grocer");
    expect(payeeKey("AMZN Mktp US*2K4")).toBe("amzn mktp us k");
  });
  test("ruleMatches", () => {
    const u = { payee: "GROCER #12", amount: cents(-5000), account: "Assets:Checking:Main" };
    expect(ruleMatches({ payeeKey: "grocer" }, u)).toBe(true);
    expect(ruleMatches({ payeeContains: "groc" }, u)).toBe(true);
    expect(ruleMatches({ payeeKey: "grocer", amountMin: -4000 }, u)).toBe(false);
    expect(ruleMatches({ payeeKey: "grocer", amountMax: -4000, amountMin: -6000 }, u)).toBe(true);
    expect(ruleMatches({ payeeKey: "grocer", account: "Assets:Checking:Other" }, u)).toBe(false);
  });
  test("describeAccount", () => {
    expect(describeAccount("Expenses:ImmediateObligations:RentMortgage")).toBe("Expense: Immediate Obligations / Rent Mortgage");
    expect(describeAccount("Income:Salary")).toBe("Income: Salary");
  });
  test("allowedCategories prefers the entity's own accounts and respects direction", () => {
    const txn = (entity: string, account: string): HledgerTransaction =>
      ({ ttags: [["entity", entity]], tpostings: [{ paccount: account, pamount: [], ptags: [] }] }) as unknown as HledgerTransaction;
    const txns = [txn("acme", "Expenses:Shipping"), txn("acme", "Expenses:Software"), txn("personal", "Expenses:Food"), txn("acme", "Income:Sales")];
    const declared = ["Expenses:Uncategorized", "Income:Uncategorized", "Expenses:Travel"];
    expect(allowedCategories(txns, declared, "acme", false)).toEqual(["Expenses:Shipping", "Expenses:Software"]);
    expect(allowedCategories(txns, declared, "acme", true)).toEqual(["Expenses:Shipping", "Expenses:Software", "Income:Sales"]);
    expect(allowedCategories(txns, declared, "nobody", false)).toEqual(["Expenses:Food", "Expenses:Shipping", "Expenses:Software", "Expenses:Travel"]);
  });
});

describe("JevClient", () => {
  test("request shape", async () => {
    const calls: JevCall[] = [];
    const jev = new JevClient({ apiKey: "k1", fetch: fakeJev(calls) });
    const a = await jev.choose("Payee: COFFEE", "Pick", { "Expenses:Food:Coffee": "Expense: Food / Coffee", "Expenses:Food:Dining": "x" });
    expect(a).toEqual({ choice: "Expenses:Food:Coffee", probabilities: { "Expenses:Food:Coffee": 0.96 }, confidence: 0.96 });
    expect(calls[0]!.auth).toBe("Bearer k1");
    expect(calls[0]!.body).toMatchObject({ model: "jev-latest", questions: { category: { type: "choice", instructions: "Pick" } } });
  });
  test("errors and bad responses", async () => {
    const jev = new JevClient({ apiKey: "k", fetch: fakeJev([]) });
    await expect(jev.choose("MYSTERY", "Pick", { a: "a" })).rejects.toThrow(JevError);
    const liar = new JevClient({
      apiKey: "k",
      fetch: (async () => Response.json({ answers: { category: { choice: "not-offered", probabilities: {}, confidence: 0.99 } } })) as unknown as typeof fetch,
    });
    await expect(liar.choose("x", "Pick", { a: "a" })).rejects.toThrow(/wasn't offered/);
    await expect(jev.choose("x", "Pick", {})).rejects.toThrow(/options/);
    expect(() => new JevClient({ apiKey: "" })).toThrow();
  });
});

// ---------------------------------------------------------------- end to end

describe.skipIf(!hledgerWebBin)("categorization pipeline (M4 done-when)", () => {
  let dir: string;
  let web: HledgerWeb;
  let ctx: ServiceContext;
  const calls: JevCall[] = [];
  const me = "alice@example.com";
  const auth = { "Tailscale-User-Login": me };
  const jevCallsFor = (payee: string) => calls.filter((c) => c.state.includes(payee)).length;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "wmma-cat-"));
    const store = new JournalStore(dir);
    await store.init();
    // Categories that exist already (in real use: from YNAB mappings or entity templates).
    await store.declareAccounts(["Expenses:Food:Coffee", "Expenses:Food:Groceries", "Expenses:Food:Dining", "Expenses:Shopping"].map((name) => ({ name, type: "X" as const })));
    web = new HledgerWeb({ bin: hledgerWebBin!, port: await freePort(), journal: store.paths.main, log: () => {} });
    await web.start();
    ctx = {
      config: loadConfig({ WMMA_ALLOWED_USERS: me, WMMA_DATA_DIR: dir }),
      db: openDb(store.paths.db),
      store,
      hledger: web.client,
      audit: new AuditLog(store.paths.audit),
      jev: new JevClient({ apiKey: "k", fetch: fakeJev(calls) }),
    };
  });
  afterAll(async () => {
    await web.stop();
    ctx.db.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("import runs the pipeline: confident Jev picks applied, unsure and failed ones queued", async () => {
    const r = await importQfx(ctx, me, {
      filename: "march.qfx",
      content: qfx("1001", [
        ["F1", "2026-03-01", "-4.50", "COFFEE CORNER"],
        ["F2", "2026-03-02", "-50.00", "GROCER #12"],
        ["F3", "2026-03-09", "-60.00", "GROCER #12"],
        ["F4", "2026-03-16", "-70.00", "GROCER #14"],
        ["F5", "2026-03-20", "-10.00", "MYSTERY CO"],
      ]),
      accounts: { "1:1001": { name: "Main" } },
    });
    expect(r.categorization).toEqual({ considered: 5, byRule: 0, byJev: 1, queued: 4, jevCalls: 5, errors: ["Jev: HTTP 500"] });
    const items = listReview(ctx);
    expect(items.length).toBe(4);
    const grocer = items.find((i) => i.payee === "GROCER #12")!;
    expect(grocer.jev_choices.map((c) => c.account)).toEqual(["Expenses:Food:Groceries", "Expenses:Food:Dining", "Expenses:Food:Coffee"]);
    expect(grocer.reason).toBe("low confidence");
    expect(items.find((i) => i.payee === "MYSTERY CO")).toMatchObject({ jev_choices: [], reason: "Jev: HTTP 500" });

    const coffee = (await ctx.hledger.transactions()).find((t) => t.tdescription === "COFFEE CORNER")!;
    expect(coffee.tpostings.map((p) => p.paccount)).toContain("Expenses:Food:Coffee");
    expect(new Map(coffee.ttags).get("cat_by")).toBe("jev");
    expect(new Map(coffee.ttags).get("jev_conf")).toBe("0.96");
  });

  test("3 accepts of the same payee into the same category create a rule", async () => {
    const handler = createFetchHandler(ctx);
    const grocers = listReview(ctx).filter((i) => i.payee.startsWith("GROCER"));
    expect(grocers.length).toBe(3);
    const swipe = (id: string, account: string) =>
      handler(new Request(`http://x/api/v1/review/${id}`, { method: "POST", headers: auth, body: JSON.stringify({ account }) }));

    const r1 = (await (await swipe(grocers[0]!.wmma_id, "Expenses:Food:Groceries")).json()) as any;
    expect(r1.item.status).toBe("accepted");
    expect(r1.ruleCreated).toBeNull();
    const r2 = (await (await swipe(grocers[1]!.wmma_id, "Expenses:Food:Groceries")).json()) as any;
    expect(r2.ruleCreated).toBeNull();
    const r3 = (await (await swipe(grocers[2]!.wmma_id, "Expenses:Food:Groceries")).json()) as any;
    expect(r3.ruleCreated).toMatchObject({ match: { payeeKey: "grocer" }, target_account: "Expenses:Food:Groceries", created_from: "swipe" });

    expect((await swipe(grocers[0]!.wmma_id, "Expenses:Food:Dining")).status).toBe(409);
    const rules = (await (await handler(new Request("http://x/api/v1/rules", { headers: auth }))).json()) as any;
    expect(rules.rules.length).toBe(1);
  });

  test("a re-import categorises known payees with zero Jev calls", async () => {
    const before = jevCallsFor("GROCER");
    const r = await importQfx(ctx, me, {
      filename: "april.qfx",
      content: qfx("1001", [
        ["G1", "2026-04-02", "-80.00", "GROCER #13"],
        ["G2", "2026-04-09", "-45.00", "GROCER #12"],
      ]),
    });
    expect(r.categorization).toMatchObject({ considered: 2, byRule: 2, byJev: 0, queued: 0, jevCalls: 0 });
    expect(jevCallsFor("GROCER")).toBe(before);
    const g = (await ctx.hledger.transactions()).find((t) => t.tdescription === "GROCER #13")!;
    expect(g.tpostings.map((p) => p.paccount)).toContain("Expenses:Food:Groceries");
    expect(new Map(g.ttags).get("cat_by")).toBe("rule");
  });

  test("changing Jev's pick counts as a swipe too", async () => {
    const mystery = listReview(ctx).find((i) => i.payee === "MYSTERY CO")!;
    const r = await resolveReview(ctx, me, mystery.wmma_id, "Expenses:Shopping");
    expect(r.item).toMatchObject({ status: "changed", chosen: "Expenses:Shopping" });
  });

  test("without a Jev key everything unknown is queued and the import still succeeds", async () => {
    const saved = ctx.jev;
    ctx.jev = null;
    try {
      const r = await importQfx(ctx, me, { filename: "may.qfx", content: qfx("1001", [["H1", "2026-05-01", "-12.00", "NEW PLACE"]]) });
      expect(r.added).toBe(1);
      expect(r.categorization).toMatchObject({ considered: 1, queued: 1, jevCalls: 0 });
      expect(listReview(ctx).find((i) => i.payee === "NEW PLACE")!.reason).toBe("jev not configured");
    } finally {
      ctx.jev = saved ?? null;
    }
  });

  test("manual rules via REST, and POST /categorize applies them to the backlog", async () => {
    const handler = createFetchHandler(ctx);
    // NEW PLACE is queued, so a manual rule plus /categorize doesn't touch it (queue owns it)...
    const bad = await handler(new Request("http://x/api/v1/rules", { method: "POST", headers: auth, body: JSON.stringify({ match: {}, target: "Expenses:Shopping" }) }));
    expect(bad.status).toBe(400);
    const res = await handler(
      new Request("http://x/api/v1/rules", { method: "POST", headers: auth, body: JSON.stringify({ match: { payeeContains: "new place" }, target: "Expenses:Shopping" }) }),
    );
    expect(res.status).toBe(201);
    // ...but a new transaction from that payee is caught by the rule.
    const r = await importQfx(ctx, me, { filename: "june.qfx", content: qfx("1001", [["J1", "2026-06-01", "-13.00", "NEW PLACE"]]) });
    expect(r.categorization).toMatchObject({ byRule: 1, jevCalls: 0 });
    const run = (await (await handler(new Request("http://x/api/v1/categorize", { method: "POST", headers: auth }))).json()) as any;
    expect(run.considered).toBe(0); // everything left is already in the queue
  });

  test("uncategorised listing reflects the journal", async () => {
    const left = findUncategorized(await ctx.hledger.transactions()).map((u) => u.payee);
    expect(left).toEqual(["NEW PLACE"]);
  });

  test.skipIf(!hledgerBin)("journals pass hledger check --strict after rewrites", () => {
    const r = Bun.spawnSync([hledgerBin!, "-f", ctx.store.paths.main, "check", "--strict"], { env: { ...process.env, LANG: "C.UTF-8" } });
    expect(r.stderr.toString()).toBe("");
  });

  test("every categorisation is audited", async () => {
    const audit = (await readFile(ctx.store.paths.audit, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const ops = new Set(audit.map((a) => a.operation));
    for (const op of ["categorize", "review.resolve", "rule.create"]) expect(ops.has(op)).toBe(true);
    const resolve = audit.find((a) => a.operation === "review.resolve");
    expect(resolve.before.account).toBe("Expenses:Uncategorized");
    expect(resolve.after.account).toBe("Expenses:Food:Groceries");
  });
});
