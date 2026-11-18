/** Reports computed from hledger's transactions (SPEC §6, §7). */
import type { HledgerTransaction } from "../hledger/web";
import { monthsBetween, effectiveAmount, nextMonth, validateMonth, type BudgetChange } from "../journal/budgets";
import { validateDate } from "../journal/format";
import * as M from "../money";
import type { Money } from "../money";
import { getEntity } from "./accounts";
import { ServiceError, type ServiceContext } from "./context";

export interface FlatPosting {
  wmmaId: string | null;
  date: string;
  account: string;
  amount: Money;
  entity: string | null;
}

/** Every $ posting with its effective entity (posting tag, else transaction tag). */
export function flatPostings(txns: HledgerTransaction[]): FlatPosting[] {
  const out: FlatPosting[] = [];
  for (const t of txns) {
    const tt = new Map(t.ttags);
    for (const p of t.tpostings) {
      const pt = new Map(p.ptags);
      for (const a of p.pamount) {
        if (a.acommodity !== "$") continue;
        out.push({
          wmmaId: tt.get("wmma_id") ?? null,
          date: t.tdate,
          account: p.paccount,
          amount: M.fromHledgerQuantity(a.aquantity),
          entity: pt.get("entity") ?? tt.get("entity") ?? null,
        });
      }
    }
  }
  return out;
}

function checkRange(from: string, to: string) {
  try {
    validateDate(from);
    validateDate(to);
  } catch {
    throw new ServiceError("from and to must be YYYY-MM-DD");
  }
  if (from > to) throw new ServiceError("from must not be after to");
}

export interface PnlLine {
  account: string;
  amount: string;
  amount_cents: number;
}

export interface Pnl {
  entity: string | null;
  from: string;
  to: string;
  income: PnlLine[];
  expenses: PnlLine[];
  totalIncome: string;
  totalExpenses: string;
  net: string;
  net_cents: number;
}

/** Profit and loss for one entity (or all, combined) over [from, to] inclusive. */
export async function pnl(ctx: ServiceContext, q: { entity?: string | null; from: string; to: string }): Promise<Pnl> {
  checkRange(q.from, q.to);
  if (q.entity && !getEntity(ctx, q.entity)) throw new ServiceError(`unknown entity ${JSON.stringify(q.entity)}`, 404);
  const sums = new Map<string, Money>();
  for (const p of flatPostings(await ctx.hledger.transactions())) {
    if (p.date < q.from || p.date > q.to) continue;
    if (q.entity && p.entity !== q.entity) continue;
    if (!p.account.startsWith("Income:") && !p.account.startsWith("Expenses:")) continue;
    sums.set(p.account, M.add(sums.get(p.account) ?? M.ZERO, p.amount));
  }
  const line = (account: string, amt: Money): PnlLine => ({ account, amount: M.format(amt), amount_cents: M.toCents(amt) });
  const income = [...sums].filter(([a]) => a.startsWith("Income:")).map(([a, v]) => [a, M.neg(v)] as const);
  const expenses = [...sums].filter(([a]) => a.startsWith("Expenses:"));
  const ti = M.sum(income.map(([, v]) => v));
  const te = M.sum(expenses.map(([, v]) => v));
  const byAmount = (a: readonly [string, Money], b: readonly [string, Money]) => M.compare(b[1], a[1]) || a[0].localeCompare(b[0]);
  return {
    entity: q.entity ?? null,
    from: q.from,
    to: q.to,
    income: income.filter(([, v]) => !M.isZero(v)).sort(byAmount).map(([a, v]) => line(a, v)),
    expenses: expenses.filter(([, v]) => !M.isZero(v)).sort(byAmount).map(([a, v]) => line(a, v)),
    totalIncome: M.format(ti),
    totalExpenses: M.format(te),
    net: M.format(M.sub(ti, te)),
    net_cents: M.toCents(M.sub(ti, te)),
  };
}

export interface BudgetLine {
  account: string;
  budgeted: string;
  activity: string;
  /** Carried in from previous months (unspent rolls over; overspending carries as negative). */
  rolledOver: string;
  available: string;
  available_cents: number;
}

/** Budget vs actual for one entity and month, with rollover from the first budgeted month. */
export async function budgetReport(ctx: ServiceContext, q: { entity: string; month: string }): Promise<{ entity: string; month: string; lines: BudgetLine[]; unbudgetedSpending: string }> {
  try {
    validateMonth(q.month);
  } catch {
    throw new ServiceError("month must be YYYY-MM");
  }
  if (!getEntity(ctx, q.entity)) throw new ServiceError(`unknown entity ${JSON.stringify(q.entity)}`, 404);
  const changes: BudgetChange[] = (await ctx.store.readBudgets()).filter((c) => c.entity === q.entity);
  const accounts = [...new Set(changes.filter((c) => c.month <= q.month).map((c) => c.account))].sort();

  // Monthly spending per account for this entity.
  const spend = new Map<string, Money>(); // key: account|YYYY-MM
  let unbudgeted = M.ZERO;
  const end = nextMonth(q.month);
  for (const p of flatPostings(await ctx.hledger.transactions())) {
    if (p.entity !== q.entity || !p.account.startsWith("Expenses:")) continue;
    const m = p.date.slice(0, 7);
    if (m >= end) continue;
    if (!accounts.includes(p.account)) {
      if (m === q.month) unbudgeted = M.add(unbudgeted, p.amount);
      continue;
    }
    const k = `${p.account}|${m}`;
    spend.set(k, M.add(spend.get(k) ?? M.ZERO, p.amount));
  }

  const lines = accounts.map((account) => {
    const first = changes.filter((c) => c.account === account).map((c) => c.month).sort()[0]!;
    let carry = M.ZERO;
    let budgeted = M.ZERO;
    let activity = M.ZERO;
    let rolled = M.ZERO;
    for (const m of monthsBetween(first, q.month)) {
      budgeted = effectiveAmount(changes, q.entity, account, m);
      activity = spend.get(`${account}|${m}`) ?? M.ZERO;
      rolled = carry;
      carry = M.sub(M.add(carry, budgeted), activity);
    }
    return {
      account,
      budgeted: M.format(budgeted),
      activity: M.format(activity),
      rolledOver: M.format(rolled),
      available: M.format(carry),
      available_cents: M.toCents(carry),
    };
  });
  return { entity: q.entity, month: q.month, lines, unbudgetedSpending: M.format(unbudgeted) };
}

// ---- Cash flow, spending, net worth --------------------------------------

/** Sankey-ready income -> expenses flow for an entity (or all) over [from, to]. */
export async function cashflow(ctx: ServiceContext, q: { entity?: string | null; from: string; to: string; depth?: number }) {
  const p = await pnl(ctx, q);
  const depth = q.depth ?? 2;
  const group = (a: string) => a.split(":").slice(0, depth).join(":");
  const sumBy = (lines: PnlLine[]) => {
    const m = new Map<string, number>();
    for (const l of lines) if (l.amount_cents > 0) m.set(group(l.account), (m.get(group(l.account)) ?? 0) + l.amount_cents);
    return m;
  };
  const income = sumBy(p.income);
  const expenses = sumBy(p.expenses);
  const nodes: Array<{ id: string; label: string; kind: "income" | "hub" | "expense" | "savings" | "deficit" }> = [{ id: "Income", label: "Income", kind: "hub" }];
  const links: Array<{ source: string; target: string; value_cents: number; value: string }> = [];
  const link = (source: string, target: string, c: number) => links.push({ source, target, value_cents: c, value: M.format(M.cents(c)) });
  for (const [a, c] of income) {
    nodes.push({ id: a, label: a.split(":").slice(1).join(" / ") || a, kind: "income" });
    link(a, "Income", c);
  }
  for (const [a, c] of expenses) {
    nodes.push({ id: a, label: a.split(":").slice(1).join(" / ") || a, kind: "expense" });
    link("Income", a, c);
  }
  const net = [...income.values()].reduce((x, y) => x + y, 0) - [...expenses.values()].reduce((x, y) => x + y, 0);
  if (net > 0) {
    nodes.push({ id: "Savings", label: "Saved", kind: "savings" });
    link("Income", "Savings", net);
  } else if (net < 0) {
    nodes.push({ id: "Deficit", label: "From savings", kind: "deficit" });
    link("Deficit", "Income", -net);
  }
  return { entity: p.entity, from: p.from, to: p.to, nodes, links, net: M.format(M.cents(net)) };
}

/** Spending by category (Expenses), grouped to `depth` account levels. */
export async function spending(ctx: ServiceContext, q: { entity?: string | null; from: string; to: string; depth?: number }) {
  const p = await pnl(ctx, q);
  const depth = q.depth ?? 2;
  const m = new Map<string, number>();
  for (const l of p.expenses) {
    const k = l.account.split(":").slice(0, depth).join(":");
    m.set(k, (m.get(k) ?? 0) + l.amount_cents);
  }
  const total = [...m.values()].reduce((a, b) => a + b, 0);
  return {
    entity: p.entity,
    from: p.from,
    to: p.to,
    total: M.format(M.cents(total)),
    categories: [...m]
      .sort((a, b) => b[1] - a[1])
      .map(([account, c]) => ({ account, amount: M.format(M.cents(c)), amount_cents: c, share: total ? Math.round((c / total) * 1000) / 10 : 0 })),
  };
}

/** Assets minus liabilities at each month end, per entity and combined. */
export async function netWorth(ctx: ServiceContext, q: { from: string; to: string }) {
  try {
    validateMonth(q.from);
    validateMonth(q.to);
  } catch {
    throw new ServiceError("from and to must be YYYY-MM");
  }
  if (q.from > q.to) throw new ServiceError("from must not be after to");
  const months = monthsBetween(q.from, q.to);
  if (months.length > 240) throw new ServiceError("at most 240 months");
  const postings = flatPostings(await ctx.hledger.transactions())
    .filter((p) => p.account.startsWith("Assets:") || p.account.startsWith("Liabilities:"))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const entities = [...new Set(postings.map((p) => p.entity ?? "(none)"))].sort();
  const running = new Map<string, Money>();
  const assets = new Map<string, Money>();
  let i = 0;
  const series = months.map((m) => {
    const end = nextMonth(m);
    for (; i < postings.length && postings[i]!.date.slice(0, 7) < end; i++) {
      const p = postings[i]!;
      const e = p.entity ?? "(none)";
      running.set(e, M.add(running.get(e) ?? M.ZERO, p.amount));
      if (p.account.startsWith("Assets:")) assets.set(e, M.add(assets.get(e) ?? M.ZERO, p.amount));
    }
    const byEntity = Object.fromEntries(entities.map((e) => [e, M.toCents(running.get(e) ?? M.ZERO)]));
    const total = M.sum(entities.map((e) => running.get(e) ?? M.ZERO));
    const totalAssets = M.sum(entities.map((e) => assets.get(e) ?? M.ZERO));
    return { month: m, net_worth_cents: M.toCents(total), net_worth: M.format(total), assets_cents: M.toCents(totalAssets), liabilities_cents: M.toCents(M.sub(totalAssets, total)), by_entity_cents: byEntity };
  });
  return { from: q.from, to: q.to, entities, series };
}

/** Monthly income and expenses for an entity (or all), for trend charts. */
export async function trend(ctx: ServiceContext, q: { entity?: string | null; from: string; to: string }) {
  try {
    validateMonth(q.from);
    validateMonth(q.to);
  } catch {
    throw new ServiceError("from and to must be YYYY-MM");
  }
  if (q.from > q.to) throw new ServiceError("from must not be after to");
  if (q.entity && !getEntity(ctx, q.entity)) throw new ServiceError(`unknown entity ${JSON.stringify(q.entity)}`, 404);
  const months = monthsBetween(q.from, q.to);
  if (months.length > 240) throw new ServiceError("at most 240 months");
  const inc = new Map<string, number>();
  const exp = new Map<string, number>();
  for (const p of flatPostings(await ctx.hledger.transactions())) {
    const m = p.date.slice(0, 7);
    if (m < q.from || m > q.to || (q.entity && p.entity !== q.entity)) continue;
    if (p.account.startsWith("Income:")) inc.set(m, (inc.get(m) ?? 0) - M.toCents(p.amount));
    else if (p.account.startsWith("Expenses:")) exp.set(m, (exp.get(m) ?? 0) + M.toCents(p.amount));
  }
  return { entity: q.entity ?? null, months: months.map((m) => ({ month: m, income_cents: inc.get(m) ?? 0, expenses_cents: exp.get(m) ?? 0, net_cents: (inc.get(m) ?? 0) - (exp.get(m) ?? 0) })) };
}

/** Income/Expenses accounts to pick from (declared or used), excluding the uncategorised buckets. */
export async function categories(ctx: ServiceContext): Promise<string[]> {
  const names = new Set<string>();
  try {
    for (const a of await ctx.hledger.accountNames()) names.add(a);
  } catch {
    // fall through to transactions only
  }
  for (const p of flatPostings(await ctx.hledger.transactions())) names.add(p.account);
  const leafish = [...names].filter((a) => /^(Income|Expenses):/.test(a) && a !== "Income:Uncategorized" && a !== "Expenses:Uncategorized");
  // Drop parents that only exist because a child does (hledger lists both).
  return leafish.filter((a) => !leafish.some((b) => b.startsWith(`${a}:`))).sort();
}
