/** Transaction queries and edits (SPEC §7): search, recategorise, retag entity, memo, split. */
import { nowIso } from "../db";
import { cleanText, validateAccount } from "../journal/format";
import type { HledgerTransaction } from "../hledger/web";
import * as M from "../money";
import type { Money } from "../money";
import { accountType } from "../naming";
import { getEntity } from "./accounts";
import { ServiceError, type ServiceContext } from "./context";

export interface TxnView {
  wmma_id: string;
  date: string;
  payee: string;
  note: string | null;
  tags: Record<string, string>;
  postings: Array<{ account: string; amount: string; amount_cents: number; entity: string | null }>;
  file: string;
}

function view(t: HledgerTransaction): TxnView | null {
  const tags = Object.fromEntries(t.ttags);
  if (!tags["wmma_id"]) return null;
  const [payee, ...note] = t.tdescription.split(" | ");
  return {
    wmma_id: tags["wmma_id"],
    date: t.tdate,
    payee: payee!.trim(),
    note: note.length ? note.join(" | ").trim() : null,
    tags,
    file: t.tsourcepos[0]?.sourceName ?? "",
    postings: t.tpostings.flatMap((p) => {
      const pe = new Map(p.ptags).get("entity") ?? tags["entity"] ?? null;
      return p.pamount
        .filter((a) => a.acommodity === "$")
        .map((a) => {
          const amt = M.fromHledgerQuantity(a.aquantity);
          return { account: p.paccount, amount: M.format(amt), amount_cents: M.toCents(amt), entity: pe };
        });
    }),
  };
}

const strip = ({ file: _f, ...t }: TxnView): Omit<TxnView, "file"> => t;

export interface TxnQuery {
  from?: string;
  to?: string;
  account?: string;
  entity?: string;
  category?: string;
  text?: string;
  limit?: number;
  offset?: number;
}

/** Newest first. `account`/`category` match an account or any of its subaccounts. */
export async function searchTransactions(ctx: ServiceContext, q: TxnQuery): Promise<{ total: number; transactions: Array<Omit<TxnView, "file">> }> {
  const under = (a: string, prefix: string) => a === prefix || a.startsWith(`${prefix}:`);
  const text = q.text?.toLowerCase();
  const all = (await ctx.hledger.transactions())
    .map(view)
    .filter((t): t is TxnView => t !== null)
    .filter((t) => (!q.from || t.date >= q.from) && (!q.to || t.date <= q.to))
    .filter((t) => !q.account || t.postings.some((p) => under(p.account, q.account!)))
    .filter((t) => !q.category || t.postings.some((p) => under(p.account, q.category!) && /^(Income|Expenses):/.test(p.account)))
    .filter((t) => !q.entity || t.tags["entity"] === q.entity || t.postings.some((p) => p.entity === q.entity))
    .filter((t) => !text || `${t.payee} ${t.note ?? ""} ${t.tags["orig_category"] ?? ""}`.toLowerCase().includes(text))
    .sort((a, b) => (a.date === b.date ? (a.wmma_id < b.wmma_id ? 1 : -1) : a.date < b.date ? 1 : -1));
  const offset = q.offset ?? 0;
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);
  return { total: all.length, transactions: all.slice(offset, offset + limit).map(strip) };
}

export async function getTransaction(ctx: ServiceContext, wmmaId: string): Promise<TxnView> {
  const t = (await ctx.hledger.transactions()).map(view).find((v) => v?.wmma_id === wmmaId);
  if (!t) throw new ServiceError(`transaction ${JSON.stringify(wmmaId)} not found`, 404);
  return t;
}

const isCategory = (a: string) => /^(Income|Expenses):/.test(a);

/** The category posting to change: `from` if given, else the only Income/Expenses posting. */
function categoryPosting(t: TxnView, from?: string): TxnView["postings"][number] {
  const cats = t.postings.filter((p) => (from ? p.account === from : isCategory(p.account)));
  if (cats.length === 0) throw new ServiceError(from ? `transaction has no posting to ${from}` : "transaction has no Income/Expenses posting", 422);
  if (cats.length > 1) throw new ServiceError("transaction has several category postings; say which one with `from`", 422);
  return cats[0]!;
}

function checkCategory(a: string): void {
  try {
    validateAccount(a);
  } catch {
    throw new ServiceError(`invalid account ${JSON.stringify(a)}`);
  }
  if (!/^(Income|Expenses|Equity):/.test(a)) throw new ServiceError("category must be under Income, Expenses or Equity");
}

export interface TxnPatch {
  category?: { to: string; from?: string };
  entity?: string;
  memo?: string | null;
}

export async function patchTransaction(ctx: ServiceContext, actor: string, wmmaId: string, patch: TxnPatch): Promise<Omit<TxnView, "file">> {
  const before = await getTransaction(ctx, wmmaId);
  const setTags: Record<string, string> = {};
  let replaceAccount: { from: string; to: string } | undefined;
  if (patch.category) {
    checkCategory(patch.category.to);
    const p = categoryPosting(before, patch.category.from);
    if (p.account !== patch.category.to) {
      replaceAccount = { from: p.account, to: patch.category.to };
      setTags["cat_by"] = "manual";
      await ctx.store.declareAccounts([{ name: patch.category.to, type: accountType(patch.category.to) }]);
    }
  }
  if (patch.entity !== undefined) {
    const e = getEntity(ctx, patch.entity);
    if (!e) throw new ServiceError(`unknown entity ${JSON.stringify(patch.entity)}`, 404);
    setTags["entity"] = patch.entity;
  }
  let note: string | null | undefined;
  if (patch.memo !== undefined) note = patch.memo === null ? null : cleanText(patch.memo) || null;
  if (!replaceAccount && Object.keys(setTags).length === 0 && note === undefined) return strip(before);

  await ctx.store.updateTransaction(before.file, wmmaId, {
    ...(Object.keys(setTags).length ? { setTags } : {}),
    ...(replaceAccount ? { replaceAccount } : {}),
    ...(note !== undefined ? { note } : {}),
  });
  if (replaceAccount) {
    ctx.db
      .query("UPDATE review_queue SET status = 'changed', chosen = ?, reason = 'manual', resolved_at = ? WHERE wmma_id = ? AND status = 'pending'")
      .run(replaceAccount.to, nowIso(), wmmaId);
  }
  const after = await getTransaction(ctx, wmmaId);
  await ctx.audit.append({ actor, operation: "transaction.patch", inputs: { wmmaId, ...patch }, before: strip(before), after: strip(after) });
  return strip(after);
}

/** Split the category posting into several postings that add up to it. */
export async function splitTransaction(
  ctx: ServiceContext,
  actor: string,
  wmmaId: string,
  input: { from?: string; postings: Array<{ account: string; amount: unknown }> },
): Promise<Omit<TxnView, "file">> {
  const before = await getTransaction(ctx, wmmaId);
  const target = categoryPosting(before, input.from);
  if (!Array.isArray(input.postings) || input.postings.length < 2) throw new ServiceError("a split needs at least two postings");
  const parts = input.postings.map((p, i) => {
    if (typeof p?.account !== "string") throw new ServiceError(`postings[${i}].account is required`);
    checkCategory(p.account);
    let amount: Money;
    try {
      amount = typeof p.amount === "number" ? M.cents(p.amount) : M.parse(String(p.amount));
    } catch {
      throw new ServiceError(`postings[${i}].amount must be a decimal string or integer cents`);
    }
    return { account: p.account, amount };
  });
  const total = M.sum(parts.map((p) => p.amount));
  if (!M.equals(total, M.cents(target.amount_cents))) {
    throw new ServiceError(`split postings add up to ${M.format(total)}, but the posting being split is ${target.amount}`);
  }
  await ctx.store.declareAccounts([...new Set(parts.map((p) => p.account))].map((name) => ({ name, type: accountType(name) })));
  await ctx.store.updateTransaction(before.file, wmmaId, { setTags: { cat_by: "manual" }, replacePosting: { from: target.account, to: parts } });
  ctx.db.query("UPDATE review_queue SET status = 'changed', chosen = 'split', reason = 'manual', resolved_at = ? WHERE wmma_id = ? AND status = 'pending'").run(nowIso(), wmmaId);
  const after = await getTransaction(ctx, wmmaId);
  await ctx.audit.append({ actor, operation: "transaction.split", inputs: { wmmaId, from: target.account, postings: parts.map((p) => ({ ...p, amount: M.toCents(p.amount) })) }, before: strip(before), after: strip(after) });
  return strip(after);
}

// ---- Mappings -----------------------------------------------------------

export function listMappings(ctx: ServiceContext, source?: string): Array<{ source: string; source_category: string; target_account: string }> {
  return (source
    ? ctx.db.query("SELECT * FROM mappings WHERE source = ? ORDER BY source_category").all(source)
    : ctx.db.query("SELECT * FROM mappings ORDER BY source, source_category").all()) as Array<{ source: string; source_category: string; target_account: string }>;
}

/**
 * Change where a source category maps to. With `apply`, existing transactions
 * categorised by that mapping (and not changed since) move to the new account.
 */
export async function updateMapping(
  ctx: ServiceContext,
  actor: string,
  input: { source: string; sourceCategory: string; target: string; apply?: boolean },
): Promise<{ mapping: { source: string; source_category: string; target_account: string }; regenerated: number }> {
  if (!input.source || !input.sourceCategory) throw new ServiceError("source and sourceCategory are required");
  checkCategory(input.target);
  const before = ctx.db.query("SELECT * FROM mappings WHERE source = ? AND source_category = ?").get(input.source, input.sourceCategory) as { target_account: string } | null;
  ctx.db.query("INSERT OR REPLACE INTO mappings (source, source_category, target_account) VALUES (?, ?, ?)").run(input.source, input.sourceCategory, input.target);
  await ctx.store.declareAccounts([{ name: input.target, type: accountType(input.target) }]);
  let regenerated = 0;
  if (input.apply && before && before.target_account !== input.target) {
    for (const t of (await ctx.hledger.transactions()).map(view)) {
      if (!t || t.tags["cat_by"] !== "mapping" || t.tags["orig_category"] !== input.sourceCategory) continue;
      const sources = new Set([t.tags["source"], ...(t.tags["alt_ids"] ?? "").split(" ").map((x) => x.split("=")[0])]);
      if (!sources.has(input.source)) continue;
      if (!t.postings.some((p) => p.account === before.target_account)) continue;
      await ctx.store.updateTransaction(t.file, t.wmma_id, { replaceAccount: { from: before.target_account, to: input.target } });
      regenerated++;
    }
  }
  const mapping = { source: input.source, source_category: input.sourceCategory, target_account: input.target };
  await ctx.audit.append({ actor, operation: "mapping.update", inputs: input, before, after: { mapping, regenerated } });
  return { mapping, regenerated };
}
