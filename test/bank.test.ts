import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../src/audit";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { HledgerWeb } from "../src/hledger/web";
import { parseBankCsv, validateProfile } from "../src/importers/bankcsv";
import { parseOfx } from "../src/importers/ofx";
import { epochToDate, normaliseSimplefin, parseAccessUrl, type SimplefinAccountSet } from "../src/importers/simplefin";
import { JournalStore } from "../src/journal/store";
import { cents, toCents } from "../src/money";
import { cronMatches, parseCron } from "../src/scheduler";
import { createFetchHandler } from "../src/server";
import { existingEntries, importBankCsv, importQfx, putCsvProfile, syncSimplefin } from "../src/services/bank-imports";
import type { ServiceContext } from "../src/services/context";
import { allRefs, planMatches, type ExistingEntry, type IncomingRecord } from "../src/services/dedup";
import { freePort, hledgerBin, hledgerWebBin } from "./helpers";

// ---------------------------------------------------------------- fixtures

function qfx(acctId: string, txns: Array<[fitid: string, date: string, amount: string, name: string]>, opts: { card?: boolean; balance?: string } = {}) {
  const trn = txns
    .map(([f, d, a, n]) => `<STMTTRN>\n<TRNTYPE>${a.startsWith("-") ? "DEBIT" : "CREDIT"}\n<DTPOSTED>${d.replaceAll("-", "")}120000[-7:MST]\n<TRNAMT>${a}\n<FITID>${f}\n<NAME>${n}\n<MEMO>memo ${f}\n</STMTTRN>`)
    .join("\n");
  const acct = opts.card ? `<CCACCTFROM>\n<ACCTID>${acctId}\n</CCACCTFROM>` : `<BANKACCTFROM>\n<BANKID>111000025\n<ACCTID>${acctId}\n<ACCTTYPE>CHECKING\n</BANKACCTFROM>`;
  const rs = opts.card ? "CCSTMTRS" : "STMTRS";
  const wrap = opts.card ? ["CREDITCARDMSGSRSV1", "CCSTMTTRNRS"] : ["BANKMSGSRSV1", "STMTTRNRS"];
  return `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20260331<LANGUAGE>ENG<FI><ORG>Test Bank &amp; Trust<FID>1</FI></SONRS></SIGNONMSGSRSV1>
<${wrap[0]}><${wrap[1]}><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<${rs}><CURDEF>USD
${acct}
<BANKTRANLIST><DTSTART>20260301<DTEND>20260331
${trn}
</BANKTRANLIST>
<LEDGERBAL><BALAMT>${opts.balance ?? "0.00"}<DTASOF>20260331</LEDGERBAL>
</${rs}></${wrap[1]}></${wrap[0]}>
</OFX>
`;
}

const sfDate = (d: string) => Date.parse(`${d}T18:00:00Z`) / 1000;
function simplefinSet(accountId: string, txns: Array<[id: string, date: string, amount: string, desc: string]>, balance: string, extra: Partial<SimplefinAccountSet> = {}): SimplefinAccountSet {
  return {
    errlist: [],
    connections: [{ conn_id: "c1", name: "Test Bank" }],
    accounts: [
      {
        id: accountId,
        name: "Everyday Checking",
        conn_id: "c1",
        currency: "USD",
        balance,
        "balance-date": sfDate("2026-03-31"),
        transactions: [
          ...txns.map(([id, d, a, desc]) => ({ id, posted: sfDate(d), amount: a, description: desc })),
          { id: "pend", posted: 0, amount: "-1.00", description: "PENDING", pending: true },
        ],
      },
    ],
    ...extra,
  };
}

// ---------------------------------------------------------------- unit

describe("OFX", () => {
  test("SGML bank statement", () => {
    const [st] = parseOfx(qfx("123456789", [["A1", "2026-03-01", "-4.50", "COFFEE"]], { balance: "1995.50" }));
    expect(st!.externalKey).toBe("111000025:123456789");
    expect(st!.name).toBe("Test Bank & Trust checking 6789");
    expect(st!.kindHint).toBe("bank");
    expect(st!.balance).toEqual({ amount: cents(199550), asOf: "2026-03-31" });
    expect(st!.records).toEqual([{ externalId: "A1", date: "2026-03-01", amount: cents(-450), payee: "COFFEE", memo: "memo A1" }]);
  });
  test("XML (OFX 2) credit card statement", () => {
    const xml = `<?xml version="1.0"?><?OFX OFXHEADER="200"?><OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>USD</CURDEF><CCACCTFROM><ACCTID>4111</ACCTID></CCACCTFROM><BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260402</DTPOSTED><TRNAMT>-9,99</TRNAMT><FITID>X&lt;1</FITID><NAME>STREAMING</NAME></STMTTRN></BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;
    const [st] = parseOfx(xml);
    expect(st!.kindHint).toBe("credit");
    expect(st!.records[0]).toMatchObject({ externalId: "X<1", amount: cents(-999), date: "2026-04-02" });
  });
  test("rejects non-USD and investment statements", () => {
    expect(() => parseOfx(qfx("1", []).replace("<CURDEF>USD", "<CURDEF>EUR"))).toThrow(/USD/);
    expect(() => parseOfx("<OFX><INVSTMTMSGSRSV1><INVSTMTTRNRS><INVSTMTRS></INVSTMTRS></INVSTMTTRNRS></INVSTMTMSGSRSV1></OFX>")).toThrow(/investment/);
    expect(() => parseOfx("hello")).toThrow(/OFX/);
  });
});

describe("bank CSV profiles", () => {
  test("signed amount column, hash ids with occurrence counter", () => {
    const p = validateProfile({ columns: { date: "Date", payee: "Description", amount: "Amount" } });
    const recs = parseBankCsv("Date,Description,Amount\n03/07/2026,COFFEE,-4.50\n03/07/2026,COFFEE,-4.50\n", p);
    expect(recs.map((r) => toCents(r.amount))).toEqual([-450, -450]);
    expect(recs[0]!.externalId).not.toBe(recs[1]!.externalId);
  });
  test("debit/credit columns, inversion, skip rows, id column", () => {
    const p = validateProfile({ columns: { date: "Posted", payee: "Payee", debit: "Debit", credit: "Credit", id: "Ref" }, skipRows: 1, dateFormat: "YYYY-MM-DD", invertAmount: true });
    const recs = parseBankCsv("Exported by Bank\nPosted,Payee,Debit,Credit,Ref\n2026-03-01,SHOP,12.00,,r1\n2026-03-02,REFUND,,3.00,r2\n", p);
    expect(recs.map((r) => [r.externalId, toCents(r.amount)])).toEqual([
      ["r1", 1200],
      ["r2", -300],
    ]);
  });
  test("validation", () => {
    expect(() => validateProfile({ columns: { date: "D", payee: "P" } })).toThrow(/amount/);
    expect(() => validateProfile({ columns: { date: "D", payee: "P", amount: "A", debit: "X", credit: "Y" } })).toThrow();
    expect(() => parseBankCsv("D,P,A\n", validateProfile({ columns: { date: "Date", payee: "P", amount: "A" } }))).toThrow(/not found/);
  });
});

describe("SimpleFIN", () => {
  test("access URL credentials move to a Basic header", () => {
    const { base, authorization } = parseAccessUrl("https://us%40er:p%3Ass@bridge.example.com/simplefin");
    expect(base).toBe("https://bridge.example.com/simplefin");
    expect(atob(authorization.slice(6))).toBe("us@er:p:ss");
    expect(() => parseAccessUrl("http://u:p@bridge.example.com/simplefin")).toThrow(/https/);
  });
  test("normalise: tz dates, pending dropped, v2 connection names", () => {
    const [a] = normaliseSimplefin(simplefinSet("sf-1", [["t1", "2026-03-01", "-4.50", "COFFEE"]], "100.00"), "America/Denver");
    expect(a!.name).toBe("Test Bank Everyday Checking");
    expect(a!.records).toEqual([{ externalId: "t1", date: "2026-03-01", amount: cents(-450), payee: "COFFEE", memo: null }]);
    expect(epochToDate(Date.parse("2026-03-02T03:00:00Z") / 1000, "America/Denver")).toBe("2026-03-01");
  });
});

describe("cron", () => {
  test("parse and match in a timezone", () => {
    const daily6 = parseCron("0 6 * * *");
    expect(cronMatches(daily6, new Date("2026-03-01T13:00:00Z"), "America/Denver")).toBe(true); // 06:00 MST
    expect(cronMatches(daily6, new Date("2026-03-01T06:00:00Z"), "America/Denver")).toBe(false);
    const weekdays = parseCron("*/15 9-17 * * 1-5");
    expect(cronMatches(weekdays, new Date("2026-03-02T09:45:00Z"), "UTC")).toBe(true); // Monday
    expect(cronMatches(weekdays, new Date("2026-03-01T09:45:00Z"), "UTC")).toBe(false); // Sunday
    expect(() => parseCron("61 * * * *")).toThrow();
    expect(() => parseCron("* * *")).toThrow();
  });
});

describe("dedup planning", () => {
  const entry = (wmmaId: string, date: string, source: string, sourceId: string, account = "Assets:Checking:Main", amount = -450): ExistingEntry => ({
    wmmaId,
    date,
    file: "",
    primary: { source, sourceId },
    alts: [],
    postings: [
      { account, amount: cents(amount) },
      { account: "Expenses:Uncategorized", amount: cents(-amount) },
    ],
  });
  const rec = (source: string, sourceId: string, date: string, amount = -450, account = "Assets:Checking:Main"): IncomingRecord => ({ source, sourceId, account, date, amount: cents(amount) });

  test("same source id is a duplicate", () => {
    const ex = [entry("W1", "2026-03-01", "qfx", "main/A1")];
    expect(planMatches([rec("qfx", "main/A1", "2026-03-01")], ex, allRefs(ex))[0]!.kind).toBe("duplicate");
  });
  test("±3 days matches, 4 days doesn't", () => {
    const ex = () => [entry("W1", "2026-03-01", "qfx", "main/A1")];
    let e = ex();
    expect(planMatches([rec("csv", "main/h1", "2026-03-04")], e, allRefs(e))[0]!.kind).toBe("match");
    e = ex();
    expect(planMatches([rec("csv", "main/h1", "2026-03-05")], e, allRefs(e))[0]!.kind).toBe("new");
  });
  test("tie between different dates goes to review", () => {
    const ex = [entry("W1", "2026-03-01", "qfx", "main/A1"), entry("W2", "2026-03-05", "qfx", "main/A2")];
    const d = planMatches([rec("csv", "main/h1", "2026-03-03")], ex, allRefs(ex))[0]!;
    expect(d.kind).toBe("ambiguous");
    if (d.kind === "ambiguous") expect(d.candidates.map((c) => c.wmmaId)).toEqual(["W1", "W2"]);
  });
  test("identical same-day records pair off one to one", () => {
    const ex = [entry("W1", "2026-03-07", "qfx", "main/A1"), entry("W2", "2026-03-07", "qfx", "main/A2")];
    const ds = planMatches([rec("simplefin", "main/s1", "2026-03-07"), rec("simplefin", "main/s2", "2026-03-07"), rec("simplefin", "main/s3", "2026-03-07")], ex, allRefs(ex));
    expect(ds.map((d) => (d.kind === "match" ? d.entry.wmmaId : d.kind))).toEqual(["W1", "W2", "new"]);
  });
  test("an entry from the same source and account is never a candidate", () => {
    const ex = [entry("W1", "2026-03-01", "qfx", "main/A1")];
    expect(planMatches([rec("qfx", "main/A9", "2026-03-02")], ex, allRefs(ex))[0]!.kind).toBe("new");
  });
  test("precedence: simplefin becomes primary and its date wins; csv only adds an alt id", () => {
    const ex = [entry("W1", "2026-03-01", "qfx", "main/A1")];
    const [d1] = planMatches([rec("simplefin", "main/s1", "2026-03-02")], ex, allRefs(ex));
    expect(d1).toMatchObject({ kind: "match", update: { date: "2026-03-02", setTags: { source: "simplefin", source_id: "main/s1", alt_ids: "qfx=main/A1" } } });
    const [d2] = planMatches([rec("csv", "main/h1", "2026-03-01")], ex, allRefs(ex));
    expect(d2).toMatchObject({ kind: "match", update: { setTags: { source: "simplefin", alt_ids: "qfx=main/A1 csv=main/h1" } } });
    expect((d2 as { update: { date?: string } }).update.date).toBeUndefined();
  });
  test("each side of a YNAB transfer can be claimed by its own account's feed", () => {
    const transfer: ExistingEntry = {
      wmmaId: "T1",
      date: "2026-01-04",
      file: "",
      primary: { source: "ynab", sourceId: "t04a" },
      alts: [],
      postings: [
        { account: "Assets:Checking:Checking", amount: cents(-20000) },
        { account: "Assets:Savings:Savings", amount: cents(20000) },
      ],
    };
    const ds = planMatches(
      [rec("simplefin", "checking/x", "2026-01-05", -20000, "Assets:Checking:Checking"), rec("simplefin", "savings/y", "2026-01-05", 20000, "Assets:Savings:Savings")],
      [transfer],
      allRefs([transfer]),
    );
    expect(ds.map((d) => d.kind)).toEqual(["match", "match"]);
    // The first SimpleFIN id outranks YNAB and becomes primary; equal rank doesn't displace it.
    expect(transfer.primary).toEqual({ source: "simplefin", sourceId: "checking/x" });
    expect(transfer.alts.map((a) => a.sourceId)).toEqual(["t04a", "savings/y"]);
  });
});

// ---------------------------------------------------------------- end to end

async function makeCtx(env: Record<string, string> = {}): Promise<{ ctx: ServiceContext; web: HledgerWeb; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "wmma-bank-"));
  const store = new JournalStore(dir);
  await store.init();
  const web = new HledgerWeb({ bin: hledgerWebBin!, port: await freePort(), journal: store.paths.main, log: () => {} });
  await web.start();
  return {
    dir,
    web,
    ctx: {
      config: loadConfig({ WMMA_ALLOWED_USERS: "alice@example.com", WMMA_DATA_DIR: dir, WMMA_TZ: "America/Denver", ...env }),
      db: openDb(store.paths.db),
      store,
      hledger: web.client,
      audit: new AuditLog(store.paths.audit),
    },
  };
}

describe.skipIf(!hledgerWebBin)("overlapping imports from different sources (M3 done-when)", () => {
  let env: Awaited<ReturnType<typeof makeCtx>>;
  const me = "alice@example.com";
  const qfxFile = qfx(
    "123456789",
    [
      ["A1", "2026-03-01", "-4.50", "COFFEE"],
      ["A2", "2026-03-02", "2000.00", "PAYROLL"],
      ["A3", "2026-03-05", "-1500.00", "RENT"],
      ["A4", "2026-03-07", "-4.50", "COFFEE"],
      ["A5", "2026-03-08", "-50.00", "GROCER"],
    ],
    { balance: "441.00" },
  );
  const csvFile = "Date,Description,Amount\n03/06/2026,RENT PAYMENT,-1500.00\n03/07/2026,COFFEE SHOP,-4.50\n03/08/2026,GROCER #12,-50.00\n03/10/2026,BOOKSTORE,-20.00\n";
  const sf = simplefinSet(
    "sf-acct-1",
    [
      ["s1", "2026-03-01", "-4.50", "Coffee"],
      ["s2", "2026-03-03", "2000.00", "Payroll"],
      ["s3", "2026-03-05", "-1500.00", "Rent"],
      ["s4", "2026-03-07", "-4.50", "Coffee"],
      ["s5", "2026-03-08", "-50.00", "Grocer"],
      ["s6", "2026-03-10", "-20.00", "Bookstore"],
      ["s7", "2026-03-12", "-7.25", "Lunch"],
    ],
    "413.75",
  );
  const sfFetch = (async () => Response.json(sf)) as unknown as typeof fetch;

  beforeAll(async () => {
    env = await makeCtx({ SIMPLEFIN_ACCESS_URL: "https://u:p@bridge.example.com/simplefin" });
    await putCsvProfile(env.ctx, me, "testbank", { columns: { date: "Date", payee: "Description", amount: "Amount" } });
  });
  afterAll(async () => {
    await env.web.stop();
    env.ctx.db.close();
    await rm(env.dir, { recursive: true, force: true });
  });

  test("QFX creates the account and its transactions", async () => {
    const r = await importQfx(env.ctx, me, { filename: "march.qfx", content: qfxFile, accounts: { "111000025:123456789": { name: "Main Checking" } } });
    expect(r).toMatchObject({ added: 5, merged: 0, needsReview: 0 });
    expect(r.createdAccounts[0]).toMatchObject({ slug: "main-checking", hledgerAccount: "Assets:Checking:MainChecking" });
  });

  test("overlapping CSV merges 3 and adds only the new one", async () => {
    const r = await importBankCsv(env.ctx, me, { filename: "march.csv", content: csvFile, profile: "testbank", account: "main-checking" });
    expect(r).toMatchObject({ added: 1, merged: 3, skippedDuplicates: 0, needsReview: 0 });
  });

  test("overlapping SimpleFIN merges 6 and adds only the new one; balance matches", async () => {
    const r = await syncSimplefin(env.ctx, me, { fetch: sfFetch, accounts: { "sf-acct-1": { slug: "main-checking" } } });
    expect(r).toMatchObject({ added: 1, merged: 6, needsReview: 0, errors: [] });
    expect(r.balances).toEqual([{ account: "Main Checking", asOf: "2026-03-31", source: "$413.75", wmma: "$413.75", match: true }]);
  });

  test("the journal holds exactly the 7 real transactions", async () => {
    const entries = existingEntries(await env.ctx.hledger.transactions());
    expect(entries.length).toBe(7);
    const rent = entries.find((e) => e.postings[0]!.amount === cents(-150000))!;
    expect(rent.primary).toEqual({ source: "simplefin", sourceId: "main-checking/s3" });
    expect(rent.alts.map((a) => a.source).sort()).toEqual(["csv", "qfx"]);
    expect(rent.date).toBe("2026-03-05");
    const pay = entries.find((e) => e.postings[0]!.amount === cents(200000))!;
    expect(pay.date).toBe("2026-03-03"); // SimpleFIN's date wins
  });

  test("re-running all three adds and merges nothing", async () => {
    const q = await importQfx(env.ctx, me, { filename: "march.qfx", content: qfxFile });
    const c = await importBankCsv(env.ctx, me, { filename: "march.csv", content: csvFile, profile: "testbank", account: "main-checking" });
    const s = await syncSimplefin(env.ctx, me, { fetch: sfFetch });
    for (const r of [q, c, s]) expect([r.added, r.merged, r.needsReview]).toEqual([0, 0, 0]);
    expect([q.skippedDuplicates, c.skippedDuplicates, s.skippedDuplicates]).toEqual([5, 4, 7]);
    expect(existingEntries(await env.ctx.hledger.transactions()).length).toBe(7);
  });

  test.skipIf(!hledgerBin)("journals still pass hledger check --strict", () => {
    const r = Bun.spawnSync([hledgerBin!, "-f", env.ctx.store.paths.main, "check", "--strict"], { env: { ...process.env, LANG: "C.UTF-8" } });
    expect(r.stderr.toString()).toBe("");
  });

  test("ambiguous matches go to review and can be merged over REST", async () => {
    const handler = createFetchHandler(env.ctx);
    const auth = { "Tailscale-User-Login": me };
    const card = qfx("4111222233334444", [
      ["C1", "2026-04-01", "-9.99", "STREAMING"],
      ["C2", "2026-04-05", "-9.99", "STREAMING"],
    ], { card: true });
    const q = await importQfx(env.ctx, me, { filename: "card.qfx", content: card });
    expect(q.createdAccounts[0]!.kind).toBe("credit");
    const slug = q.createdAccounts[0]!.slug;

    const csv = "Date,Description,Amount\n04/03/2026,STREAMING SVC,-9.99\n";
    const r = await importBankCsv(env.ctx, me, { filename: "card.csv", content: csv, profile: "testbank", account: slug });
    expect(r).toMatchObject({ added: 0, merged: 0, needsReview: 1 });

    const list = (await (await handler(new Request("http://x/api/v1/duplicates", { headers: auth }))).json()) as any;
    expect(list.duplicates.length).toBe(1);
    const dup = list.duplicates[0];
    expect(dup.candidates.length).toBe(2);

    const target = dup.candidates[0];
    const res = await handler(new Request(`http://x/api/v1/duplicates/${dup.id}`, { method: "POST", headers: auth, body: JSON.stringify({ action: "merge", wmmaId: target }) }));
    expect(res.status).toBe(200);
    const again = await handler(new Request(`http://x/api/v1/duplicates/${dup.id}`, { method: "POST", headers: auth, body: JSON.stringify({ action: "discard" }) }));
    expect(again.status).toBe(409);

    const merged = existingEntries(await env.ctx.hledger.transactions()).find((e) => e.wmmaId === target)!;
    expect(merged.alts).toEqual([{ source: "csv", sourceId: dup.source_id }]);

    // Re-importing the CSV now recognises it.
    const r2 = await importBankCsv(env.ctx, me, { filename: "card.csv", content: csv, profile: "testbank", account: slug });
    expect(r2).toMatchObject({ added: 0, needsReview: 0, skippedDuplicates: 1 });
  });

  test("raw files kept, merges audited with before/after", async () => {
    const audit = (await readFile(env.ctx.store.paths.audit, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const sfRun = audit.find((a) => a.operation === "import.simplefin" && a.after.merged?.length === 6);
    expect(sfRun.before.merged.length).toBe(6);
    expect(audit.some((a) => a.operation === "duplicate.merge")).toBe(true);
    expect(JSON.stringify(audit)).not.toContain("u:p@"); // access URL never logged
  });

  test("SimpleFIN errors are surfaced, not fatal", async () => {
    const withErr = (async () => Response.json({ ...sf, errlist: [{ code: "con.auth", msg: "Reconnect your bank" }] })) as unknown as typeof fetch;
    const r = await syncSimplefin(env.ctx, me, { fetch: withErr });
    expect(r.errors).toEqual(["con.auth: Reconnect your bank"]);
  });
});
