import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cents } from "../src/money";
import {
  cleanText,
  formatAccountDirective,
  formatTransaction,
  JournalFormatError,
  type Transaction,
} from "../src/journal/format";
import { JournalStore } from "../src/journal/store";
import { hledgerBin } from "./helpers";

const coffee: Transaction = {
  date: "2026-01-02",
  payee: "Blue Bottle",
  status: "*",
  tags: { entity: "personal", source: "manual", wmma_id: "01JABCDEF0000000000000000", custom: "x" },
  postings: [
    { account: "Expenses:Food:Coffee", amount: cents(450) },
    { account: "Assets:Checking:Chase", amount: cents(-450) },
  ],
};

describe("formatTransaction", () => {
  test("renders header, ordered tags, aligned postings", () => {
    expect(formatTransaction(coffee)).toBe(
      [
        "2026-01-02 * Blue Bottle  ; wmma_id:01JABCDEF0000000000000000, source:manual, entity:personal, custom:x",
        "    Expenses:Food:Coffee    $4.50",
        "    Assets:Checking:Chase  $-4.50",
        "",
      ].join("\n"),
    );
  });

  test("note and posting-level tags", () => {
    const out = formatTransaction({
      date: "2026-03-01",
      payee: "Transfer",
      note: "owner draw",
      tags: { wmma_id: "X1" },
      postings: [
        { account: "Assets:DueFrom:Biz", amount: cents(10000), tags: { entity: "personal" } },
        { account: "Liabilities:DueTo:Personal", amount: cents(-10000), tags: { entity: "acme" } },
      ],
    });
    expect(out).toContain("2026-03-01 Transfer | owner draw  ; wmma_id:X1\n");
    expect(out).toContain("$100.00  ; entity:personal\n");
    expect(out).toContain("$-100.00  ; entity:acme\n");
  });

  const invalid: Array<[string, Partial<Transaction>]> = [
    ["bad date", { date: "2026-02-30" }],
    ["bad date format", { date: "1/2/2026" }],
    ["empty payee", { payee: "" }],
    ["payee with semicolon", { payee: "A; B" }],
    ["payee with pipe", { payee: "A|B" }],
    ["payee with newline", { payee: "A\nB" }],
    ["tag value with comma", { tags: { source: "a,b" } }],
    ["bad tag name", { tags: { "bad tag": "x" } }],
    ["unbalanced", { postings: [{ account: "A:B", amount: cents(1) }, { account: "C:D", amount: cents(-2) }] }],
    ["one posting", { postings: [{ account: "A:B", amount: cents(0) }] }],
    ["account double space", { postings: [{ account: "A  B", amount: cents(1) }, { account: "C", amount: cents(-1) }] }],
    ["account empty segment", { postings: [{ account: "A::B", amount: cents(1) }, { account: "C", amount: cents(-1) }] }],
    ["virtual account", { postings: [{ account: "(A:B)", amount: cents(1) }, { account: "C", amount: cents(-1) }] }],
    ["float amount", { postings: [{ account: "A", amount: 1.5 as never }, { account: "C", amount: -1.5 as never }] }],
  ];
  for (const [name, patch] of invalid) {
    test(`rejects ${name}`, () => expect(() => formatTransaction({ ...coffee, ...patch })).toThrow());
  }

  test("rejections are JournalFormatError", () => {
    expect(() => formatTransaction({ ...coffee, payee: "a;b" })).toThrow(JournalFormatError);
  });

  test("cleanText makes upstream text safe", () => {
    const payee = cleanText("  AMZN Mktp; US*|123,  \n foo ");
    expect(payee).toBe("AMZN Mktp US* 123 foo");
    expect(() => formatTransaction({ ...coffee, payee, tags: { orig_category: cleanText("Bills, Utilities") } })).not.toThrow();
  });
});

describe("formatAccountDirective", () => {
  test("with type", () => expect(formatAccountDirective("Assets:Checking", { type: "A" })).toBe("account Assets:Checking  ; type:A\n"));
  test("plain", () => expect(formatAccountDirective("Expenses:Food")).toBe("account Expenses:Food\n"));
});

describe("JournalStore", () => {
  let dir: string;
  let store: JournalStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wmma-test-"));
    store = new JournalStore(dir);
    await store.init();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  test("init creates the data layout and is idempotent", async () => {
    await store.init();
    expect((await readdir(join(dir, "imports"))).sort()).toEqual(["csv", "qfx", "reihub", "simplefin", "ynab"]);
    const main = await readFile(store.paths.main, "utf8");
    expect(main).toContain("include accounts.journal\ninclude prices.journal\ninclude budgets.journal\n");
    expect(main).not.toContain("include accounts/");
  });

  test("init does not overwrite existing journals", async () => {
    await writeFile(store.paths.prices, "P 2026-01-01 X $1\n");
    await store.init();
    expect(await readFile(store.paths.prices, "utf8")).toBe("P 2026-01-01 X $1\n");
  });

  test("appendTransactions creates the account file and its include", async () => {
    await store.appendTransactions("chase", [coffee]);
    await store.appendTransactions("chase", [{ ...coffee, date: "2026-01-03" }]);
    const f = await readFile(store.accountJournalPath("chase"), "utf8");
    expect(f.match(/Blue Bottle/g)?.length).toBe(2);
    expect(await readFile(store.paths.main, "utf8")).toContain("include accounts/chase.journal\n");
  });

  test("an invalid transaction writes nothing", async () => {
    await expect(store.appendTransactions("amex", [coffee, { ...coffee, payee: "" }])).rejects.toThrow();
    expect(await store.listAccountJournals()).toEqual([]);
  });

  test("rejects unsafe slugs", () => {
    expect(() => store.accountJournalPath("../evil")).toThrow();
    expect(() => store.accountJournalPath("Chase")).toThrow();
  });

  test("concurrent appends are serialised", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.appendTransactions("chase", [{ ...coffee, tags: { wmma_id: `ID${i}` } }]),
      ),
    );
    const f = await readFile(store.accountJournalPath("chase"), "utf8");
    for (let i = 0; i < 20; i++) expect(f).toContain(`wmma_id:ID${i}\n`);
    expect((await readdir(store.paths.accountsDir)).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  test("declareAccount is idempotent", async () => {
    expect(await store.declareAccount("Assets:Checking:Chase", { type: "A" })).toBe(true);
    expect(await store.declareAccount("Assets:Checking:Chase", { type: "A" })).toBe(false);
    expect(await store.declareAccount("Assets:Checking")).toBe(true);
    const f = await readFile(store.paths.accounts, "utf8");
    expect(f.match(/^account /gm)?.length).toBe(2);
  });

  test.skipIf(!hledgerBin)("hledger reads the written journal and agrees on balances", async () => {
    await store.declareAccount("Assets:Checking:Chase", { type: "A" });
    await store.declareAccount("Expenses:Food:Coffee", { type: "X" });
    await store.appendTransactions("chase", [coffee, { ...coffee, date: "2026-01-05", payee: cleanText("Café; Ünïcode") }]);
    const run = (args: string[]) =>
      Bun.spawnSync([hledgerBin!, "-f", store.paths.main, ...args], { env: { ...process.env, LANG: "C.UTF-8" } });
    const check = run(["check", "--strict"]);
    expect(check.stderr.toString()).toBe("");
    expect(check.exitCode).toBe(0);
    const bal = run(["bal", "Assets:Checking:Chase", "-N", "--flat", "-O", "csv"]).stdout.toString();
    expect(bal).toContain('"Assets:Checking:Chase","$-9.00"');
    const tagged = run(["reg", "tag:entity=personal", "-O", "csv"]).stdout.toString();
    expect(tagged.trim().split("\n").length).toBe(5); // header + 2 txns x 2 postings
  });
});
