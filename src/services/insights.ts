/**
 * Monarch-style report data: period overviews (categories, merchants, stats),
 * income/expense series by day/week/month/quarter/year, account balance history
 * (net worth, investments, forecasting), recurring-charge detection, and
 * per-business profit and loss statements.
 *
 * Everything is computed from hledger's transactions in integer cents.
 */
import type { AccountKind, EntityType } from "../db";
import type { HledgerTransaction } from "../hledger/web";
import { validateDate } from "../journal/format";
import * as M from "../money";
import { KIND_PREFIX, recurringPayeeKey } from "../naming";
import { TEMPLATES } from "../templates";
import { getEntity, listAccounts } from "./accounts";
import { ServiceError, type ServiceContext } from "./context";
import { listEntities } from "./entities";
import { upsertRecurringRule } from "./categorize";
import { patchTransaction } from "./transactions";

// ---- shared ----------------------------------------------------------------

export type Interval = "day" | "week" | "month" | "quarter" | "year";
export const INTERVALS: readonly Interval[] = ["day", "week", "month", "quarter", "year"];
const MAX_PERIODS = 800;

const isoToday = () => new Date().toISOString().slice(0, 10);
const toDate = (d: string) => new Date(`${d}T00:00:00Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 10);
export function addDays(d: string, n: number): string {
  const x = toDate(d);
  x.setUTCDate(x.getUTCDate() + n);
  return fmt(x);
}
export function addMonths(d: string, n: number): string {
  const x = toDate(d);
  const day = x.getUTCDate();
  x.setUTCDate(1);
  x.setUTCMonth(x.getUTCMonth() + n);
  const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(day, last));
  return fmt(x);
}
const daysBetween = (a: string, b: string) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000);

/** First day of the period containing `d`. */
export function periodStart(d: string, interval: Interval): string {
  const x = toDate(d);
  switch (interval) {
    case "day":
      return d;
    case "week": {
      const dow = (x.getUTCDay() + 6) % 7; // Monday = 0
      return addDays(d, -dow);
    }
    case "month":
      return `${d.slice(0, 7)}-01`;
    case "quarter":
      return `${d.slice(0, 4)}-${String(Math.floor(x.getUTCMonth() / 3) * 3 + 1).padStart(2, "0")}-01`;
    case "year":
      return `${d.slice(0, 4)}-01-01`;
  }
}
function nextPeriod(start: string, interval: Interval): string {
  switch (interval) {
    case "day":
      return addDays(start, 1);
    case "week":
      return addDays(start, 7);
    case "month":
      return addMonths(start, 1);
    case "quarter":
      return addMonths(start, 3);
    case "year":
      return addMonths(start, 12);
  }
}

export interface Period {
  /** First day of the period. */
  start: string;
  /** Last day of the period (clipped to the requested range). */
  end: string;
}

/** Periods covering [from, to]; the first and last are clipped to the range. */
export function periodsBetween(from: string, to: string, interval: Interval): Period[] {
  const out: Period[] = [];
  for (let s = periodStart(from, interval); s <= to; s = nextPeriod(s, interval)) {
    if (out.length >= MAX_PERIODS) throw new ServiceError(`at most ${MAX_PERIODS} periods; choose a longer interval`);
    const end = addDays(nextPeriod(s, interval), -1);
    out.push({ start: s < from ? from : s, end: end > to ? to : end });
  }
  return out;
}

function checkDay(v: string, name: string) {
  try {
    validateDate(v);
  } catch {
    throw new ServiceError(`${name} must be YYYY-MM-DD`);
  }
}
function checkInterval(v: string | null | undefined): Interval {
  if (!v) return "month";
  if (!INTERVALS.includes(v as Interval)) throw new ServiceError(`interval must be one of ${INTERVALS.join(", ")}`);
  return v as Interval;
}
function checkEntity(ctx: ServiceContext, entity: string | null | undefined) {
  if (entity && !getEntity(ctx, entity)) throw new ServiceError(`unknown entity ${JSON.stringify(entity)}`, 404);
}

/** Which entities a report covers: one (`entity`), or everything except `exclude`. */
export interface Scope {
  entity?: string | null;
  /** Only these businesses (nothing = all). Postings with no business are left out when set. */
  entities?: readonly string[] | null;
  exclude?: readonly string[] | null;
  /** Categories (and their subcategories) to leave out, e.g. "Expenses:Taxes". */
  excludeCategories?: readonly string[] | null;
}
/** Predicate over a posting's account: false for excluded categories and their subcategories. */
export function categoryFilter(q: { excludeCategories?: readonly string[] | null }): (account: string) => boolean {
  const ex = q.excludeCategories ?? [];
  if (ex.length === 0) return () => true;
  return (a) => !ex.some((c) => a === c || a.startsWith(`${c}:`));
}
/** Validate a scope and return a predicate over a posting's entity. */
export function scopeFilter(ctx: ServiceContext | null, q: Scope): (entity: string | null) => boolean {
  // Unknown slugs in `exclude` are ignored: leaving out something that doesn't exist is harmless.
  if (ctx) checkEntity(ctx, q.entity);
  const ex = new Set(q.exclude ?? []);
  const only = new Set(q.entities ?? []);
  if (q.entity) return (e) => e === q.entity;
  if (ex.size === 0 && only.size === 0) return () => true;
  return (e) => (only.size === 0 ? e === null || !ex.has(e) : e !== null && only.has(e) && !ex.has(e));
}

interface Line {
  account: string;
  cents: number;
  entity: string | null;
}
interface Txn {
  id: string | null;
  date: string;
  payee: string;
  tags: Map<string, string>;
  lines: Line[];
}

function txns(raw: HledgerTransaction[]): Txn[] {
  return raw
    .map((t) => {
      const tags = new Map(t.ttags);
      return {
        id: tags.get("wmma_id") ?? null,
        date: t.tdate,
        payee: (t.tdescription.split(" | ")[0] ?? "").trim() || "(no payee)",
        tags,
        lines: t.tpostings.flatMap((p) => {
          const pe = new Map(p.ptags).get("entity") ?? tags.get("entity") ?? null;
          return p.pamount.filter((a) => a.acommodity === "$").map((a) => ({ account: p.paccount, cents: M.toCents(M.fromHledgerQuantity(a.aquantity)), entity: pe }));
        }),
      };
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

const isIncome = (a: string) => a.startsWith("Income:");
const isExpense = (a: string) => a.startsWith("Expenses:");

/** Resolve an optional [from, to] to the data's bounds (all time) and today. */
function range(all: Txn[], q: { from?: string | null; to?: string | null }, today: string) {
  const firstData = all.find((t) => t.lines.some((l) => isIncome(l.account) || isExpense(l.account)))?.date ?? today;
  const from = q.from || firstData;
  const to = q.to || (today > (all.at(-1)?.date ?? today) ? today : all.at(-1)!.date);
  checkDay(from, "from");
  checkDay(to, "to");
  if (from > to) throw new ServiceError("from must not be after to");
  return { from, to };
}

// ---- overview --------------------------------------------------------------

interface KindStats {
  total_cents: number;
  count: number;
  largest_cents: number;
  average_cents: number;
  first_date: string | null;
  last_date: string | null;
  categories: Array<{ account: string; cents: number; count: number }>;
  merchants: Array<{ name: string; cents: number; count: number; category: string | null }>;
}

/** Income and spending for [from, to] (all time when omitted): totals, categories, merchants and stats. */
export async function overview(ctx: ServiceContext, q: Scope & { from?: string | null; to?: string | null; today?: string }) {
  const keep = scopeFilter(ctx, q);
  const keepCat = categoryFilter(q);
  const all = txns(await ctx.hledger.transactions());
  const today = q.today ?? isoToday();
  const { from, to } = range(all, q, today);
  const build = (pick: (a: string) => boolean, sign: 1 | -1): KindStats => {
    const cats = new Map<string, { cents: number; count: number }>();
    const merch = new Map<string, { name: string; cents: number; count: number; cats: Map<string, number> }>();
    let total = 0;
    let count = 0;
    let largest = 0;
    let first: string | null = null;
    let last: string | null = null;
    for (const t of all) {
      if (t.date < from || t.date > to) continue;
      const mine = t.lines.filter((l) => pick(l.account) && keep(l.entity) && keepCat(l.account));
      if (mine.length === 0) continue;
      const tc = mine.reduce((s, l) => s + sign * l.cents, 0);
      total += tc;
      count++;
      largest = Math.max(largest, tc);
      first ??= t.date;
      last = t.date;
      for (const l of mine) {
        const c = cats.get(l.account) ?? { cents: 0, count: 0 };
        c.cents += sign * l.cents;
        c.count++;
        cats.set(l.account, c);
      }
      const key = t.payee.toLowerCase();
      const m = merch.get(key) ?? { name: t.payee, cents: 0, count: 0, cats: new Map<string, number>() };
      m.cents += tc;
      m.count++;
      for (const l of mine) m.cats.set(l.account, (m.cats.get(l.account) ?? 0) + 1);
      merch.set(key, m);
    }
    return {
      total_cents: total,
      count,
      largest_cents: largest,
      average_cents: count ? Math.round(total / count) : 0,
      first_date: first,
      last_date: last,
      categories: [...cats].map(([account, v]) => ({ account, ...v })).filter((c) => c.cents !== 0).sort((a, b) => b.cents - a.cents || a.account.localeCompare(b.account)),
      merchants: [...merch.values()]
        .filter((m) => m.cents !== 0)
        .sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name))
        .slice(0, 200)
        .map((m) => ({ name: m.name, cents: m.cents, count: m.count, category: [...m.cats].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null })),
    };
  };
  const income = build(isIncome, -1);
  const expenses = build(isExpense, 1);
  const net = income.total_cents - expenses.total_cents;
  return {
    entity: q.entity ?? null,
    from,
    to,
    income,
    expenses,
    net_cents: net,
    savings_rate: income.total_cents > 0 ? Math.round((Math.max(0, net) / income.total_cents) * 1000) / 10 : 0,
  };
}

// ---- series ----------------------------------------------------------------

/**
 * Income, expenses and net per period. With `stack`, also each period's amount
 * for the range's top categories of that kind (the rest summed as "Other").
 */
export async function series(
  ctx: ServiceContext,
  q: Scope & { from?: string | null; to?: string | null; interval?: string | null; stack?: "income" | "expense" | null; top?: number; today?: string },
) {
  const keep = scopeFilter(ctx, q);
  const keepCat = categoryFilter(q);
  const interval = checkInterval(q.interval);
  const all = txns(await ctx.hledger.transactions());
  const { from, to } = range(all, q, q.today ?? isoToday());
  const periods = periodsBetween(from, to, interval);
  const idx = new Map(periods.map((p, i) => [periodStart(p.start, interval), i]));
  const inc = periods.map(() => 0);
  const exp = periods.map(() => 0);
  const stackSums = new Map<string, number[]>();
  for (const t of all) {
    if (t.date < from || t.date > to) continue;
    const i = idx.get(periodStart(t.date, interval));
    if (i === undefined) continue;
    for (const l of t.lines) {
      if (!keep(l.entity) || !keepCat(l.account)) continue;
      if (isIncome(l.account)) inc[i]! -= l.cents;
      else if (isExpense(l.account)) exp[i]! += l.cents;
      else continue;
      if (q.stack && (q.stack === "income" ? isIncome(l.account) : isExpense(l.account))) {
        const row = stackSums.get(l.account) ?? periods.map(() => 0);
        row[i]! += q.stack === "income" ? -l.cents : l.cents;
        stackSums.set(l.account, row);
      }
    }
  }
  let stack: { keys: string[]; values: number[][] } | null = null;
  if (q.stack) {
    const top = Math.max(1, Math.min(q.top ?? 8, 20));
    const ranked = [...stackSums].sort((a, b) => b[1].reduce((x, y) => x + y, 0) - a[1].reduce((x, y) => x + y, 0));
    const keys = ranked.slice(0, top).map(([k]) => k);
    const values = ranked.slice(0, top).map(([, v]) => v);
    if (ranked.length > top) {
      keys.push("Other");
      values.push(periods.map((_, i) => ranked.slice(top).reduce((s, [, v]) => s + v[i]!, 0)));
    }
    stack = { keys, values };
  }
  return {
    entity: q.entity ?? null,
    from,
    to,
    interval,
    periods: periods.map((p, i) => ({ ...p, income_cents: inc[i]!, expenses_cents: exp[i]!, net_cents: inc[i]! - exp[i]! })),
    stack,
  };
}

// ---- account balance history ------------------------------------------------

function kindOf(account: string): AccountKind {
  const hit = (Object.entries(KIND_PREFIX) as Array<[AccountKind, string]>).find(([, p]) => account === p || account.startsWith(`${p}:`));
  if (hit) return hit[0];
  if (account.startsWith("Assets:Savings") || account.startsWith("Assets:Cash")) return "bank";
  return account.startsWith("Liabilities:") ? "loan" : "other_asset";
}

/**
 * Balance of every asset and liability account at the end of each period, plus
 * each period's money moved in or out (`flow`) and valuation changes (`valuation`,
 * market moves recorded against Equity:Unrealized). With `entity`, only postings
 * tagged with that entity count.
 */
export async function accountHistory(ctx: ServiceContext, q: Scope & { from: string; to?: string | null; interval?: string | null; today?: string }) {
  const keep = scopeFilter(ctx, q);
  const interval = checkInterval(q.interval);
  const to = q.to || (q.today ?? isoToday());
  checkDay(q.from, "from");
  checkDay(to, "to");
  if (q.from > to) throw new ServiceError("from must not be after to");
  const periods = periodsBetween(q.from, to, interval);
  const all = txns(await ctx.hledger.transactions());
  const registered = new Map(listAccounts(ctx).map((a) => [a.hledger_account, a]));
  type Row = { balance: number[]; flow: number[]; valuation: number[] };
  const rows = new Map<string, Row>();
  const row = (a: string) => {
    let r = rows.get(a);
    if (!r) rows.set(a, (r = { balance: periods.map(() => 0), flow: periods.map(() => 0), valuation: periods.map(() => 0) }));
    return r;
  };
  const running = new Map<string, number>();
  let i = 0;
  const close = (upto: number) => {
    // Write running balances for periods [i, upto).
    for (; i < upto; i++) for (const [a, b] of running) row(a).balance[i] = b;
  };
  for (const t of all) {
    if (t.date > to) break;
    let p = i;
    while (p < periods.length && t.date > periods[p]!.end) p++;
    close(p);
    const valuation = t.tags.get("kind") === "valuation";
    for (const l of t.lines) {
      if (!l.account.startsWith("Assets:") && !l.account.startsWith("Liabilities:")) continue;
      if (!keep(l.entity)) continue;
      running.set(l.account, (running.get(l.account) ?? 0) + l.cents);
      if (t.date >= q.from && i < periods.length) {
        const r = row(l.account);
        if (valuation) r.valuation[i]! += l.cents;
        else r.flow[i]! += l.cents;
      }
    }
  }
  close(periods.length);
  const accounts = [...rows]
    .filter(([, r]) => r.balance.some((b) => b !== 0) || r.flow.some((b) => b !== 0))
    .map(([account, r]) => {
      const reg = registered.get(account);
      return {
        account,
        slug: reg?.slug ?? null,
        name: reg?.name ?? account.split(":").slice(1).join(" ") ?? account,
        kind: reg?.kind ?? kindOf(account),
        entity: reg?.default_entity ?? null,
        status: reg?.status ?? "open",
        liability: account.startsWith("Liabilities:"),
        balance_cents: r.balance,
        flow_cents: r.flow,
        valuation_cents: r.valuation,
      };
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  const total = periods.map((_, k) => accounts.reduce((s, a) => s + a.balance_cents[k]!, 0));
  const assets = periods.map((_, k) => accounts.filter((a) => !a.liability).reduce((s, a) => s + a.balance_cents[k]!, 0));
  return {
    entity: q.entity ?? null,
    from: q.from,
    to,
    interval,
    periods,
    accounts,
    net_worth_cents: total,
    assets_cents: assets,
    liabilities_cents: periods.map((_, k) => assets[k]! - total[k]!),
  };
}

// ---- recurring -------------------------------------------------------------

export type Frequency = "weekly" | "biweekly" | "monthly" | "bimonthly" | "quarterly" | "semiannual" | "yearly";
const FREQS: Array<{ f: Frequency; days: number; perYear: number; min: number; max: number; need: number }> = [
  { f: "weekly", days: 7, perYear: 52, min: 5, max: 9, need: 4 },
  { f: "biweekly", days: 14, perYear: 26, min: 12, max: 17, need: 3 },
  { f: "monthly", days: 30.44, perYear: 12, min: 26, max: 35, need: 3 },
  { f: "bimonthly", days: 60.88, perYear: 6, min: 54, max: 68, need: 3 },
  { f: "quarterly", days: 91.31, perYear: 4, min: 82, max: 100, need: 3 },
  { f: "semiannual", days: 182.6, perYear: 2, min: 168, max: 197, need: 2 },
  { f: "yearly", days: 365.25, perYear: 1, min: 340, max: 390, need: 2 },
];

export interface RecurringItem {
  key: string;
  payee: string;
  kind: "expense" | "income";
  category: string;
  entity: string | null;
  /** True when the series' transactions are split across businesses. */
  entity_mixed: boolean;
  frequency: Frequency;
  amount_cents: number;
  average_cents: number;
  variable: boolean;
  count: number;
  last_date: string;
  next_date: string;
  monthly_cents: number;
  yearly_cents: number;
  status: "active" | "late" | "inactive";
  history: Array<{ date: string; cents: number }>;
}

/** Group key for a payee (see recurringPayeeKey). */
export const payeeKey = recurringPayeeKey;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** A transaction's place in a recurring series: its direction, amount and series key (null if it can't be part of one). */
function seriesOf(t: Txn, keep: (e: string | null) => boolean, keepCat: (a: string) => boolean) {
  if (t.tags.get("kind") === "transfer" || t.tags.get("kind") === "valuation") return null;
  const mine = t.lines.filter((l) => (isIncome(l.account) || isExpense(l.account)) && keep(l.entity) && keepCat(l.account));
  if (mine.length === 0) return null;
  const exp = mine.filter((l) => isExpense(l.account)).reduce((s, l) => s + l.cents, 0);
  const inc = -mine.filter((l) => isIncome(l.account)).reduce((s, l) => s + l.cents, 0);
  const kind: "expense" | "income" = inc > exp ? "income" : "expense";
  const cents = kind === "income" ? inc - exp : exp - inc;
  const pk = payeeKey(t.payee);
  if (cents <= 0 || !pk) return null;
  return { kind, cents, mine, key: `${kind}:${pk}` };
}

/** Detect recurring income and charges: same payee, steady cadence, similar amounts. */
export function detectRecurring(raw: HledgerTransaction[], q: Scope & { today: string }): RecurringItem[] {
  const keep = scopeFilter(null, q);
  const keepCat = categoryFilter(q);
  const since = addDays(q.today, -800);
  const groups = new Map<string, { payee: string; kind: "expense" | "income"; byDate: Map<string, number>; cats: Map<string, number>; ents: Map<string, number> }>();
  for (const t of txns(raw)) {
    if (t.date < since || t.date > q.today) continue;
    const c = seriesOf(t, keep, keepCat);
    if (!c) continue;
    const { kind, cents, mine, key } = c;
    const g = groups.get(key) ?? { payee: t.payee, kind, byDate: new Map(), cats: new Map(), ents: new Map() };
    g.payee = t.payee; // most recent spelling (txns are sorted by date)
    g.byDate.set(t.date, (g.byDate.get(t.date) ?? 0) + cents);
    for (const l of mine) g.cats.set(l.account, (g.cats.get(l.account) ?? 0) + Math.abs(l.cents));
    if (mine[0]!.entity) g.ents.set(mine[0]!.entity, (g.ents.get(mine[0]!.entity) ?? 0) + 1);
    groups.set(key, g);
  }
  const out: RecurringItem[] = [];
  for (const [key, g] of groups) {
    const hist = [...g.byDate].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, cents]) => ({ date, cents }));
    if (hist.length < 2) continue;
    const gaps = hist.slice(1).map((h, i) => daysBetween(hist[i]!.date, h.date));
    const med = median(gaps);
    const freq = FREQS.find((f) => med >= f.min && med <= f.max);
    if (!freq || hist.length < freq.need) continue;
    // Most gaps must fit the cadence (a skipped month counts as two).
    const fits = gaps.filter((d) => (d >= freq.min && d <= freq.max) || (d >= freq.min * 2 && d <= freq.max * 2)).length;
    if (fits / gaps.length < 0.75) continue;
    const amounts = hist.map((h) => h.cents);
    const m = median(amounts);
    const spread = median(amounts.map((a) => Math.abs(a - m))) / m;
    if (spread > 0.35) continue;
    const last = hist.at(-1)!;
    const next = freq.days >= 28 ? addMonths(last.date, Math.round(freq.days / 30.44)) : addDays(last.date, Math.round(freq.days));
    const overdue = daysBetween(next, q.today);
    if (overdue > freq.days * 1.5 + 7) continue; // stopped long ago
    const status = overdue > Math.max(5, freq.days * 0.25) ? (overdue > freq.days * 0.75 + 5 ? "inactive" : "late") : "active";
    const recent = amounts.slice(-6);
    const average = Math.round(recent.reduce((a, b) => a + b, 0) / recent.length);
    out.push({
      key,
      payee: g.payee,
      kind: g.kind,
      category: [...g.cats].sort((a, b) => b[1] - a[1])[0]![0],
      entity: [...g.ents].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      entity_mixed: g.ents.size > 1,
      frequency: freq.f,
      amount_cents: last.cents,
      average_cents: average,
      variable: spread > 0.03,
      count: hist.length,
      last_date: last.date,
      next_date: next,
      monthly_cents: Math.round((average * freq.perYear) / 12),
      yearly_cents: average * freq.perYear,
      status,
      history: hist.slice(-12),
    });
  }
  return out.sort((a, b) => (a.next_date < b.next_date ? -1 : a.next_date > b.next_date ? 1 : b.amount_cents - a.amount_cents));
}

export async function recurring(ctx: ServiceContext, q: Scope & { today?: string }) {
  scopeFilter(ctx, q);
  const today = q.today ?? isoToday();
  const items = detectRecurring(await ctx.hledger.transactions(), { entity: q.entity ?? null, entities: q.entities ?? null, exclude: q.exclude ?? null, excludeCategories: q.excludeCategories ?? null, today });
  const live = items.filter((i) => i.status !== "inactive");
  const sum = (k: "expense" | "income") => live.filter((i) => i.kind === k).reduce((s, i) => s + i.monthly_cents, 0);
  return { entity: q.entity ?? null, today, items, monthly_expense_cents: sum("expense"), monthly_income_cents: sum("income") };
}

/**
 * Tag every transaction in a recurring series (all of its history) with a
 * business, and optionally add a rule so future charges get it too.
 */
export async function assignRecurring(ctx: ServiceContext, actor: string, q: { key: string; entity: string; future?: boolean; today?: string }) {
  const ent = getEntity(ctx, q.entity);
  if (!ent) throw new ServiceError(`unknown entity ${JSON.stringify(q.entity)}`, 404);
  const m = /^(expense|income):(.+)$/.exec(q.key);
  if (!m) throw new ServiceError("key must look like expense:<payee> or income:<payee>");
  const kind = m[1] as "expense" | "income";
  const all = txns(await ctx.hledger.transactions());
  const members = all.flatMap((t) => {
    const c = seriesOf(t, () => true, () => true);
    return c && c.key === q.key && t.id ? [{ t, c }] : [];
  });
  if (members.length === 0) throw new ServiceError("no transactions found for this recurring series", 404);
  let updated = 0;
  for (const { t, c } of members) {
    if (c.mine.every((l) => l.entity === q.entity) && t.tags.get("entity") === q.entity) continue;
    await patchTransaction(ctx, actor, t.id!, { entity: q.entity });
    updated++;
  }
  let rule: { id: string; created: boolean } | null = null;
  if (q.future !== false) {
    const cats = new Map<string, number>();
    for (const { c } of members) for (const l of c.mine) cats.set(l.account, (cats.get(l.account) ?? 0) + Math.abs(l.cents));
    const target = [...cats].sort((a, b) => b[1] - a[1])[0]![0];
    const r = await upsertRecurringRule(ctx, actor, { recurringKey: m[2]!, kind, target, entity: q.entity });
    rule = { id: r.rule.id, created: r.created };
  }
  return { key: q.key, entity: q.entity, transactions: members.length, updated, rule };
}

// ---- business P&L ----------------------------------------------------------

/** Income, expenses and net per entity for [from, to], with a monthly net series. */
export async function businesses(ctx: ServiceContext, q: { from?: string | null; to?: string | null; interval?: string | null; entities?: readonly string[] | null; exclude?: readonly string[] | null; excludeCategories?: readonly string[] | null; today?: string }) {
  const keep = scopeFilter(ctx, { entities: q.entities ?? null, exclude: q.exclude ?? null });
  const keepCat = categoryFilter(q);
  const interval = checkInterval(q.interval);
  const all = txns(await ctx.hledger.transactions());
  const { from, to } = range(all, q, q.today ?? isoToday());
  const periods = periodsBetween(from, to, interval);
  const idx = new Map(periods.map((p, i) => [periodStart(p.start, interval), i]));
  const ents = listEntities(ctx, "all").filter((e) => keep(e.slug));
  const acc = new Map(ents.map((e) => [e.slug, { income: 0, expenses: 0, inc: periods.map(() => 0), exp: periods.map(() => 0) }]));
  for (const t of all) {
    if (t.date < from || t.date > to) continue;
    const i = idx.get(periodStart(t.date, interval))!;
    for (const l of t.lines) {
      const a = l.entity ? acc.get(l.entity) : undefined;
      if (!a || !keepCat(l.account)) continue;
      if (isIncome(l.account)) {
        a.income -= l.cents;
        a.inc[i]! -= l.cents;
      } else if (isExpense(l.account)) {
        a.expenses += l.cents;
        a.exp[i]! += l.cents;
      }
    }
  }
  return {
    from,
    to,
    interval,
    periods,
    entities: ents
      .map((e) => {
        const a = acc.get(e.slug)!;
        const net = a.income - a.expenses;
        return {
          slug: e.slug,
          name: e.name,
          type: e.type,
          status: e.status,
          color: e.color,
          income_cents: a.income,
          expenses_cents: a.expenses,
          net_cents: net,
          margin: a.income > 0 ? Math.round((net / a.income) * 1000) / 10 : null,
          income_series: a.inc,
          expense_series: a.exp,
        };
      })
      .filter((e) => e.status === "active" || e.income_cents !== 0 || e.expenses_cents !== 0),
  };
}

/** A P&L statement: each Income/Expenses account per period, with tax-form lines for business entities. */
export async function statement(ctx: ServiceContext, q: { entity: string; from?: string | null; to?: string | null; interval?: string | null; excludeCategories?: readonly string[] | null; today?: string }) {
  const keepCat = categoryFilter(q);
  const ent = getEntity(ctx, q.entity);
  if (!ent) throw new ServiceError(`unknown entity ${JSON.stringify(q.entity)}`, 404);
  const interval = q.interval === "total" ? "year" : checkInterval(q.interval);
  const all = txns(await ctx.hledger.transactions());
  const { from, to } = range(all, q, q.today ?? isoToday());
  const periods = q.interval === "total" ? [{ start: from, end: to }] : periodsBetween(from, to, interval);
  const idx = (d: string) => (q.interval === "total" ? 0 : periods.findIndex((p) => d >= p.start && d <= p.end));
  const sums = new Map<string, number[]>();
  for (const t of all) {
    if (t.date < from || t.date > to) continue;
    const i = idx(t.date);
    if (i < 0) continue;
    for (const l of t.lines) {
      if (l.entity !== q.entity || !(isIncome(l.account) || isExpense(l.account)) || !keepCat(l.account)) continue;
      const r = sums.get(l.account) ?? periods.map(() => 0);
      r[i]! += isIncome(l.account) ? -l.cents : l.cents;
      sums.set(l.account, r);
    }
  }
  const form = TEMPLATES[ent.type as EntityType] ?? [];
  const lineOf = new Map(form.filter((f) => f.line).map((f) => [f.account, f.line!]));
  const lineNo = (l: string | undefined) => (l ? parseFloat(l) + (/[a-z]$/.test(l) ? (l.charCodeAt(l.length - 1) - 96) / 100 : 0) : 999);
  const lines = (pick: (a: string) => boolean) =>
    [...sums]
      .filter(([a]) => pick(a))
      .map(([account, values]) => ({ account, line: lineOf.get(account) ?? null, values, total_cents: values.reduce((s, v) => s + v, 0) }))
      .filter((l) => l.values.some((v) => v !== 0))
      .sort((a, b) => lineNo(a.line ?? undefined) - lineNo(b.line ?? undefined) || b.total_cents - a.total_cents);
  const cogs = (a: string) => a === "Expenses:CostOfGoodsSold" || a.startsWith("Expenses:CostOfGoodsSold:");
  const income = lines(isIncome);
  const costOfGoods = lines(cogs);
  const expenses = lines((a) => isExpense(a) && !cogs(a));
  const col = (ls: typeof income) => periods.map((_, i) => ls.reduce((s, l) => s + l.values[i]!, 0));
  const ti = col(income);
  const tc = col(costOfGoods);
  const te = col(expenses);
  const gross = periods.map((_, i) => ti[i]! - tc[i]!);
  const net = periods.map((_, i) => gross[i]! - te[i]!);
  const tot = (xs: number[]) => xs.reduce((s, v) => s + v, 0);
  return {
    entity: { slug: ent.slug, name: ent.name, type: ent.type },
    from,
    to,
    interval: q.interval === "total" ? "total" : interval,
    periods,
    form_lines: form.map((f) => ({ account: f.account, line: f.line ?? null })),
    income,
    cost_of_goods: costOfGoods,
    expenses,
    totals: {
      income: ti,
      cost_of_goods: tc,
      gross_profit: gross,
      expenses: te,
      net,
      income_total: tot(ti),
      cost_of_goods_total: tot(tc),
      gross_profit_total: tot(gross),
      expenses_total: tot(te),
      net_total: tot(net),
    },
  };
}
