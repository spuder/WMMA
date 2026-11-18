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
