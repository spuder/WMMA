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

  test("retry re-runs queued items that never got a Jev answer (rules included)", async () => {
    const handler = createFetchHandler(ctx);
    const post = async (body: unknown) =>
      (await (await handler(new Request("http://x/api/v1/categorize", { method: "POST", headers: auth, body: JSON.stringify(body) }))).json()) as any;
    // NEW PLACE was queued with "jev not configured"; the payeeContains rule now catches it.
    const run = await post({ retry: true });
    expect(run).toMatchObject({ considered: 1, byRule: 1, jevCalls: 0 });
    expect(listReview(ctx, "accepted").find((i) => i.payee === "NEW PLACE")).toMatchObject({ chosen: "Expenses:Shopping", reason: "rule" });
    expect(findUncategorized(await ctx.hledger.transactions())).toEqual([]);
  });

  test("running out of Jev credits stops after one call; retry fills them in later", async () => {
    const saved = ctx.jev;
    let paid = 0;
    ctx.jev = new JevClient({ apiKey: "k", fetch: (async () => (paid++, new Response("no credits", { status: 402 }))) as unknown as typeof fetch });
    try {
      const r = await importQfx(ctx, me, {
        filename: "july.qfx",
        content: qfx("1001", [
          ["K1", "2026-07-01", "-8.00", "SHOP ONE"],
          ["K2", "2026-07-02", "-9.00", "SHOP TWO"],
          ["K3", "2026-07-03", "-4.00", "COFFEE CORNER"],
        ]),
      });
      expect(r.categorization).toMatchObject({ considered: 3, queued: 3, jevCalls: 1, errors: ["Jev: out of credits"] });
      expect(paid).toBe(1);
      const shops = listReview(ctx).filter((i) => i.date >= "2026-07-01");
      expect(shops.map((i) => i.reason)).toEqual(["Jev: out of credits", "Jev: out of credits", "Jev: out of credits"]);
    } finally {
      ctx.jev = saved ?? null;
    }
    const handler = createFetchHandler(ctx);
    const post = async (body: unknown) =>
      (await (await handler(new Request("http://x/api/v1/categorize", { method: "POST", headers: auth, body: JSON.stringify(body) }))).json()) as any;
    const run = await post({ retry: true });
    expect(run).toMatchObject({ considered: 3, byJev: 1, queued: 2, jevCalls: 3, errors: [] });
    expect(listReview(ctx, "accepted").find((i) => i.payee === "COFFEE CORNER" && i.date === "2026-07-03")).toMatchObject({ chosen: "Expenses:Food:Coffee", reason: "jev" });
    const shops = listReview(ctx).filter((i) => i.date >= "2026-07-01");
    expect(shops.length).toBe(2);
    for (const s of shops) {
      expect(s.reason).toBe("low confidence");
      expect(s.jev_choices.length).toBeGreaterThan(0);
    }
    // Items with real suggestions are left alone unless asked.
    expect((await post({ retry: true })).considered).toBe(0);
    expect(await post({ retry: true, includeLowConfidence: true, limit: 1 })).toMatchObject({ considered: 1, remaining: 1 });
  });

  test("wmmaIds re-asks Jev about chosen transactions, even low-confidence ones, and reports outcomes", async () => {
    const handler = createFetchHandler(ctx);
    const get = await handler(new Request("http://x/api/v1/categorize/uncategorized", { headers: auth }));
    const { ids } = (await get.json()) as { ids: string[] };
    const shop = listReview(ctx).find((i) => i.payee === "SHOP ONE")!;
    expect(ids).toContain(shop.wmma_id);
    const before = calls.length;
    const res = await handler(new Request("http://x/api/v1/categorize", { method: "POST", headers: auth, body: JSON.stringify({ wmmaIds: [shop.wmma_id] }) }));
    const r = (await res.json()) as any;
    expect(r).toMatchObject({ considered: 1, jevCalls: 1 });
    expect(calls.length).toBe(before + 1);
    expect(r.outcomes[shop.wmma_id].choices.length).toBeGreaterThan(0);
    const bad = await handler(new Request("http://x/api/v1/categorize", { method: "POST", headers: auth, body: JSON.stringify({ wmmaIds: "nope" }) }));
    expect(bad.status).toBe(400);
  });

  test("re-run Jev: only Jev's own picks; confident answers move them, unsure ones never remove a category", async () => {
    const handler = createFetchHandler(ctx);
    const { ids } = (await (await handler(new Request("http://x/api/v1/categorize/jev", { headers: auth }))).json()) as { ids: string[] };
    const txns = await ctx.hledger.transactions();
    const byId = new Map(txns.map((t) => [new Map(t.ttags).get("wmma_id"), t]));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(new Map(byId.get(id)!.ttags).get("cat_by")).toBe("jev");
    // Rule- and swipe-categorized transactions are never offered.
    const manual = txns.filter((t) => ["rule", "swipe", "manual"].includes(new Map(t.ttags).get("cat_by") ?? "")).map((t) => new Map(t.ttags).get("wmma_id"));
    expect(manual.length).toBeGreaterThan(0);
    for (const id of manual) expect(ids).not.toContain(id);

    const rerun = async (body: unknown) => (await (await handler(new Request("http://x/api/v1/categorize/rerun", { method: "POST", headers: auth, body: JSON.stringify(body) }))).json()) as any;
    const id = ids[0]!;
    const from = byId.get(id)!.tpostings.find((p) => p.paccount.startsWith("Expenses:"))!.paccount;
    const saved = ctx.jev;
    const answering = (choice: string, confidence: number) =>
      new JevClient({
        apiKey: "k",
        fetch: (async () => Response.json({ answers: { category: { type: "choice", choice, probabilities: { [choice]: confidence }, confidence } } })) as unknown as typeof fetch,
      });
    try {
      ctx.jev = answering("Expenses:Shopping", 0.5);
      expect(await rerun({ wmmaIds: [id] })).toMatchObject({ considered: 1, kept: 1, changed: 0 });
      ctx.jev = answering(from, 0.97);
      expect(await rerun({ wmmaIds: [id] })).toMatchObject({ considered: 1, confirmed: 1 });
      ctx.jev = answering("Expenses:Shopping", 0.95);
      const r = await rerun({ wmmaIds: [id] });
      expect(r).toMatchObject({ considered: 1, changed: 1 });
      expect(r.outcomes[id]).toMatchObject({ from, to: "Expenses:Shopping" });
      const after = (await ctx.hledger.transactions()).find((t) => new Map(t.ttags).get("wmma_id") === id)!;
      expect(after.tpostings.map((p) => p.paccount)).toContain("Expenses:Shopping");
      expect(new Map(after.ttags).get("jev_conf")).toBe("0.95");
      // Manual ids are ignored even when sent.
      expect((await rerun({ wmmaIds: manual })).considered).toBe(0);
      ctx.jev = null;
      const off = await handler(new Request("http://x/api/v1/categorize/rerun", { method: "POST", headers: auth, body: JSON.stringify({ wmmaIds: [id] }) }));
      expect(off.status).toBe(409);
    } finally {
      ctx.jev = saved ?? null;
    }
  });

  test("apply a category to similar transactions, optionally with a rule for future imports", async () => {
    const handler = createFetchHandler(ctx);
    const saved = ctx.jev;
    ctx.jev = null; // keep the new transactions uncategorized
    try {
      await importQfx(ctx, me, {
        filename: "aug.qfx",
        content: qfx("1001", [
          ["L1", "2026-08-01", "-20.00", "BRIGHT HARDWARE #1"],
          ["L2", "2026-08-02", "-21.00", "BRIGHT HARDWARE #2"],
          ["L3", "2026-08-03", "-22.00", "Bright Hardware #3"],
        ]),
      });
    } finally {
      ctx.jev = saved ?? null;
    }
    const id = (payee: string) => listReview(ctx).find((i) => i.payee === payee)!.wmma_id;
    const [a, b, c] = [id("BRIGHT HARDWARE #1"), id("BRIGHT HARDWARE #2"), id("Bright Hardware #3")];
    const send = (method: string, path: string, body?: unknown) =>
      handler(new Request(`http://x/api/v1${path}`, { method, headers: auth, ...(body ? { body: JSON.stringify(body) } : {}) }));
    // One of them already has a different category.
    expect((await send("PATCH", `/transactions/${c}`, { category: { to: "Expenses:Shopping" } })).status).toBe(200);
    expect((await send("PATCH", `/transactions/${a}`, { category: { to: "Expenses:Housing:HomeImprovement" } })).status).toBe(200);

    const sim = (await (await send("GET", `/transactions/${a}/similar`)).json()) as any;
    expect(sim.payeeKey).toBe("bright hardware");
    expect(sim.transactions.map((t: any) => t.wmma_id).sort()).toEqual([b, c].sort());
    expect(sim.rule).toBeNull();

    const r1 = (await (await send("POST", `/transactions/${a}/similar`, { category: "Expenses:Housing:HomeImprovement", createRule: true })).json()) as any;
    expect(r1.updated).toEqual([b]); // the Shopping one is left alone by default
    expect(r1.ruleCreated).toBe(true);
    expect(r1.rule.match).toEqual({ payeeKey: "bright hardware" });
    const r2 = (await (await send("POST", `/transactions/${a}/similar`, { category: "Expenses:Housing:HomeImprovement", includeCategorized: true, createRule: true })).json()) as any;
    expect(r2).toMatchObject({ updated: [c], ruleCreated: false });
    const cats = (await ctx.hledger.transactions())
      .filter((t) => t.tdescription.toUpperCase().startsWith("BRIGHT HARDWARE"))
      .map((t) => [t.tpostings.find((p) => p.paccount.startsWith("Expenses:"))!.paccount, new Map(t.ttags).get("cat_by")]);
    expect(cats).toEqual(Array(3).fill(["Expenses:Housing:HomeImprovement", "manual"]));
    expect(listReview(ctx).some((i) => i.payee.toUpperCase().startsWith("BRIGHT"))).toBe(false);

    // Future imports from the payee get the category from the rule.
    const next = await importQfx(ctx, me, { filename: "sep.qfx", content: qfx("1001", [["L9", "2026-09-01", "-30.00", "BRIGHT HARDWARE #9"]]) });
    expect(next.categorization).toMatchObject({ byRule: 1, jevCalls: 0 });

    expect((await send("DELETE", `/rules/${r1.rule.id}`)).status).toBe(200);
    const rules = (await (await send("GET", "/rules")).json()) as any;
    expect(rules.rules.some((r: any) => r.id === r1.rule.id)).toBe(false);
    expect((await send("POST", `/transactions/${a}/similar`, { category: "Expenses:Uncategorized" })).status).toBe(400);
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
