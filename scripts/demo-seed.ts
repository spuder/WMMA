/**
 * Fill a running WMMA with synthetic demo data (no real financial data):
 * two entities, accounts, a year of transactions, budgets and a review queue.
 *
 *   WMMA_DEV_USER=you@example.com bun scripts/demo-seed.ts
 */
const user = process.env.WMMA_DEV_USER;
if (!user) throw new Error("set WMMA_DEV_USER to a login listed in WMMA_ALLOWED_USERS");
const base = `http://127.0.0.1:${process.env.WMMA_PORT || "3000"}/api/v1`;
const headers = { "Tailscale-User-Login": user };

async function call(method: string, path: string, body?: unknown, form?: FormData) {
  const res = await fetch(base + path, { method, headers, body: form ?? (body === undefined ? null : JSON.stringify(body)) });
  const json = await res.json();
  if (!res.ok && res.status !== 409) throw new Error(`${method} ${path}: ${JSON.stringify(json)}`);
  return json;
}

// Deterministic pseudo-random so the demo looks the same every time.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
const cents = (min: number, max: number) => Math.round((min + rnd() * (max - min)) * 100) / 100;
const iso = (d: Date) => d.toISOString().slice(0, 10);

await call("POST", "/entities", { name: "Household", type: "personal", slug: "household" });
await call("POST", "/entities", { name: "Studio LLC", type: "schedule_c", slug: "studio" });
for (const [name, kind, entity] of [
  ["Everyday Checking", "bank", "household"],
  ["Rewards Card", "credit", "household"],
  ["High Yield Savings", "bank", "household"],
  ["Studio Checking", "bank", "studio"],
  ["Home", "real_estate", "household"],
  ["Brokerage", "investment", "household"],
] as const) {
  await call("POST", "/accounts", { name, kind, entity });
}

const rules: Array<[string, string]> = [
  ["payroll", "Income:Salary"],
  ["landlord", "Expenses:Housing:Rent"],
  ["power co", "Expenses:Housing:Utilities"],
  ["fresh market", "Expenses:Food:Groceries"],
  ["corner cafe", "Expenses:Food:Dining"],
  ["metro transit", "Expenses:Transportation"],
  ["streamflix", "Expenses:Subscriptions"],
  ["client", "Income:GrossReceipts"],
  ["adspot", "Expenses:Advertising"],
  ["cloudhost", "Expenses:Office"],
];
const existing = (await call("GET", "/rules")).rules.map((r: any) => r.match.payeeContains);
for (const [p, t] of rules) if (!existing.includes(p)) await call("POST", "/rules", { match: { payeeContains: p }, target: t });

function qfx(acct: string, txns: Array<[string, string, string]>) {
  let n = 0;
  const body = txns
    .map(([d, a, name]) => `<STMTTRN><TRNTYPE>OTHER<DTPOSTED>${d.replaceAll("-", "")}<TRNAMT>${a}<FITID>DEMO-${acct}-${d}-${n++}<NAME>${name}</STMTTRN>`)
    .join("\n");
  return `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>DEMO<ACCTID>${acct}<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST>\n${body}\n</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
}

const now = new Date();
const home: Array<[string, string, string]> = [];
const studio: Array<[string, string, string]> = [];
for (let m = 11; m >= 0; m--) {
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, 1));
  const day = (d: number) => {
    const x = new Date(first);
    x.setUTCDate(d);
    return x > now ? null : iso(x);
  };
  const add = (list: typeof home, d: number, amt: number, name: string) => {
    const date = day(d);
    if (date) list.push([date, amt.toFixed(2), name]);
  };
  add(home, 1, 4200, "PAYROLL ACME CORP");
  add(home, 15, 4200, "PAYROLL ACME CORP");
  add(home, 2, -1850, "LANDLORD PROPERTY MGMT");
  add(home, 8, -cents(70, 140), "POWER CO UTILITY");
  add(home, 12, -15.99, "STREAMFLIX");
  for (let i = 0; i < 6; i++) add(home, 3 + i * 4, -cents(35, 160), "FRESH MARKET #" + (100 + Math.floor(rnd() * 9)));
  for (let i = 0; i < 5; i++) add(home, 2 + i * 5, -cents(8, 45), "CORNER CAFE");
  for (let i = 0; i < 2; i++) add(home, 6 + i * 13, -cents(2.5, 30), "METRO TRANSIT");
  if (m < 2) for (let i = 0; i < 3; i++) add(home, 9 + i * 6, -cents(12, 220), pick(["HARDWARE DEPOT", "BOOKNOOK", "PETPAL SUPPLIES", "GADGET HUB", "MOUNTAIN OUTFITTERS"]));
  add(studio, 5, cents(2500, 7000), "CLIENT " + pick(["NORTHWIND", "CONTOSO", "FABRIKAM"]));
  add(studio, 20, cents(1500, 4000), "CLIENT " + pick(["NORTHWIND", "CONTOSO", "FABRIKAM"]));
  add(studio, 10, -cents(150, 600), "ADSPOT MEDIA");
  add(studio, 11, -cents(40, 90), "CLOUDHOST INC");
  if (m < 2) add(studio, 17, -cents(30, 400), pick(["PAPER & INK CO", "LENS RENTAL PRO", "COWORK DESK"]));
}

const form = (name: string, content: string, account: string) => {
  const f = new FormData();
  f.set("type", "qfx");
  f.set("file", new File([content], name));
  f.set("options", JSON.stringify({ account }));
  return f;
};
const r1 = await call("POST", "/imports", undefined, form("everyday.qfx", qfx("1001", home), "everyday-checking"));
const r2 = await call("POST", "/imports", undefined, form("studio.qfx", qfx("2001", studio), "studio-checking"));
console.log(`imported ${r1.added + r2.added} transactions; ${r1.categorization.queued + r2.categorization.queued} queued for review`);

const thisMonth = iso(now).slice(0, 7);
const start = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1))).slice(0, 7);
await call("PUT", "/budgets", [
  { entity: "household", account: "Expenses:Food:Groceries", month: start, amount: "600.00" },
  { entity: "household", account: "Expenses:Food:Dining", month: start, amount: "120.00" },
  { entity: "household", account: "Expenses:Housing:Utilities", month: start, amount: "110.00" },
  { entity: "household", account: "Expenses:Transportation", month: start, amount: "60.00" },
  { entity: "household", account: "Expenses:Subscriptions", month: start, amount: "20.00" },
  { entity: "household", account: "Expenses:Shopping", month: thisMonth, amount: "150.00" },
]);
await call("POST", "/transfers", { from: "everyday-checking", to: "high-yield-savings", amount: "1500.00", date: iso(now) });
await call("POST", "/transfers", { from: "studio-checking", to: "everyday-checking", amount: "2000.00", date: iso(now), memo: "owner draw" });
await call("POST", "/valuations", { account: "home", date: `${start}-01`, value: "485000.00" });
await call("POST", "/valuations", { account: "home", date: iso(now), value: "512000.00" });
await call("POST", "/valuations", { account: "brokerage", date: `${start}-01`, value: "64000.00" });
await call("POST", "/valuations", { account: "brokerage", date: iso(now), value: "71850.00" });
console.log("demo data ready");

export {};
