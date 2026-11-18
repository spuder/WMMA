/** Budgets, transfers and asset valuations (SPEC §6). */
import { nowIso } from "../db";
import { validateMonth, type BudgetChange } from "../journal/budgets";
import { cleanText, validateDate, type Transaction } from "../journal/format";
import * as M from "../money";
import type { Money } from "../money";
import { accountType, isAssetKind, UNREALIZED } from "../naming";
import { transferPostings } from "../journal/transfers";
import { ulid } from "../ulid";
import { getAccount, getEntity, type AccountRow } from "./accounts";
import { ServiceError, type ServiceContext } from "./context";
import { flatPostings } from "./reports";

function money(v: unknown, what: string): Money {
  try {
    if (typeof v === "number") return M.cents(v);
    if (typeof v === "string") return M.parse(v);
  } catch {
    // fall through
  }
  throw new ServiceError(`${what} must be a decimal string (e.g. "400.00") or integer cents`);
}

function date(v: unknown, what = "date"): string {
  if (typeof v !== "string") throw new ServiceError(`${what} must be YYYY-MM-DD`);
  try {
    validateDate(v);
  } catch {
    throw new ServiceError(`${what} must be YYYY-MM-DD`);
  }
  return v;
}

// ---- Budgets ------------------------------------------------------------

export async function listBudgets(ctx: ServiceContext, entity?: string) {
  const all = await ctx.store.readBudgets();
  return all.filter((c) => !entity || c.entity === entity).map((c) => ({ ...c, amount: M.format(c.amount), amount_cents: M.toCents(c.amount) }));
}

/** Set monthly amounts from `month` onward (later explicit changes still apply). */
export async function setBudgets(
  ctx: ServiceContext,
  actor: string,
  items: Array<{ entity: string; account: string; month: string; amount: unknown }>,
): Promise<number> {
  if (!Array.isArray(items) || items.length === 0) throw new ServiceError("expected a non-empty list of budget amounts");
  const parsed: BudgetChange[] = items.map((i, n) => {
    if (!getEntity(ctx, i.entity)) throw new ServiceError(`item ${n}: unknown entity ${JSON.stringify(i.entity)}`, 404);
    try {
      validateMonth(i.month);
    } catch {
      throw new ServiceError(`item ${n}: month must be YYYY-MM`);
    }
    if (typeof i.account !== "string" || !/^(Expenses|Income):/.test(i.account)) throw new ServiceError(`item ${n}: account must be an Income or Expenses account`);
    const amount = money(i.amount, `item ${n}: amount`);
    if (M.isNegative(amount)) throw new ServiceError(`item ${n}: amount must not be negative`);
    return { entity: i.entity, account: i.account, month: i.month, amount };
  });
  const before = await ctx.store.readBudgets();
  await ctx.store.declareAccounts([...new Set(parsed.map((p) => p.account))].map((name) => ({ name, type: accountType(name) })));
  const after = await ctx.store.updateBudgets((current) => [...current.filter((c) => !parsed.some((p) => p.entity === c.entity && p.account === c.account && p.month === c.month)), ...parsed]);
  await ctx.audit.append({
    actor,
    operation: "budget.set",
    inputs: parsed.map((p) => ({ ...p, amount: M.toCents(p.amount) })),
    before: before.length,
    after: after.length,
  });
  return parsed.length;
}

// ---- Transfers ----------------------------------------------------------

export async function recordTransfer(
  ctx: ServiceContext,
  actor: string,
  input: { from: string; to: string; amount: unknown; date: unknown; memo?: string },
): Promise<{ wmma_id: string; postings: Array<{ account: string; amount: string; entity?: string }> }> {
  const from = getAccount(ctx, input.from);
  const to = getAccount(ctx, input.to);
  if (!from) throw new ServiceError(`unknown account ${JSON.stringify(input.from)}`, 404);
  if (!to) throw new ServiceError(`unknown account ${JSON.stringify(input.to)}`, 404);
  if (from.slug === to.slug) throw new ServiceError("from and to must differ");
  const amount = money(input.amount, "amount");
  if (M.isZero(amount)) throw new ServiceError("amount must not be zero");
  if (M.isNegative(amount)) throw new ServiceError("amount must be positive");
  const d = date(input.date);
  const postings = transferPostings({ hledgerAccount: from.hledger_account, entity: from.default_entity }, { hledgerAccount: to.hledger_account, entity: to.default_entity }, amount);
  const wmmaId = ulid();
  const memo = cleanText(input.memo ?? "");
  const txn: Transaction = {
    date: d,
    payee: `Transfer : ${cleanText(to.name)}`,
    ...(memo ? { note: memo } : {}),
    status: "*",
    tags: { wmma_id: wmmaId, source: "manual", source_id: wmmaId, entity: from.default_entity, kind: "transfer" },
    postings,
  };
  await ctx.store.declareAccounts([...new Set(postings.map((p) => p.account))].map((name) => ({ name, type: accountType(name) })));
  await ctx.store.appendTransactions(from.slug, [txn]);
  await ctx.audit.append({ actor, operation: "transfer.record", inputs: { ...input, amount: M.toCents(amount) }, before: null, after: { wmma_id: wmmaId, postings: postings.map((p) => ({ ...p, amount: M.toCents(p.amount) })) } });
  return { wmma_id: wmmaId, postings: postings.map((p) => ({ account: p.account, amount: M.format(p.amount), ...(p.tags?.["entity"] ? { entity: p.tags["entity"] } : {}) })) };
}

// ---- Valuations ---------------------------------------------------------

/**
 * Record an asset's value as of a date: the difference from its current
 * balance posts to Equity:Unrealized, so valuations never touch P&L.
 */
export async function recordValuation(
  ctx: ServiceContext,
  actor: string,
  input: { account: string; date: unknown; value: unknown },
): Promise<{ wmma_id: string | null; previous: string; value: string; change: string }> {
  const a: AccountRow | null = getAccount(ctx, input.account);
  if (!a) throw new ServiceError(`unknown account ${JSON.stringify(input.account)}`, 404);
  if (!isAssetKind(a.kind) || a.kind === "bank") throw new ServiceError("valuations are for investment, vehicle, real estate and other asset accounts");
  const d = date(input.date);
  const value = money(input.value, "value");
  const balance = M.sum(
    flatPostings(await ctx.hledger.transactions())
      .filter((p) => p.account === a.hledger_account && p.date <= d)
      .map((p) => p.amount),
  );
  const change = M.sub(value, balance);
  ctx.db.query("INSERT OR REPLACE INTO balance_snapshots (account_slug, as_of, source, balance_cents) VALUES (?, ?, 'valuation', ?)").run(a.slug, d, M.toCents(value));
  let wmmaId: string | null = null;
  if (!M.isZero(change)) {
    wmmaId = ulid();
    await ctx.store.declareAccounts([{ name: UNREALIZED, type: "E" }, { name: a.hledger_account, type: "A" }]);
    await ctx.store.appendTransactions(a.slug, [
      {
        date: d,
        payee: "Valuation",
        note: `value ${M.format(value)}`,
        status: "*",
        tags: { wmma_id: wmmaId, source: "manual", source_id: wmmaId, entity: a.default_entity, kind: "valuation" },
        postings: [
          { account: a.hledger_account, amount: change },
          { account: UNREALIZED, amount: M.neg(change) },
        ],
      },
    ]);
  }
  const result = { wmma_id: wmmaId, previous: M.format(balance), value: M.format(value), change: M.format(change) };
  await ctx.audit.append({ actor, operation: "valuation.record", inputs: { ...input, value: M.toCents(value) }, before: { balance: M.toCents(balance) }, after: { ...result, at: nowIso() } });
  return result;
}
