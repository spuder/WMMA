/**
 * Monarch / YNAB-style "apply to similar transactions": after a category is set on one
 * transaction, find the other transactions from the same payee (same payeeKey: store numbers and
 * punctuation ignored), recategorize them in one go, and optionally keep a rule for future imports.
 */
import { nowIso } from "../db";
import { validateAccount } from "../journal/format";
import type { HledgerTransaction } from "../hledger/web";
import * as M from "../money";
import { accountType, UNCATEGORIZED_EXPENSE, UNCATEGORIZED_INCOME } from "../naming";
import { createRule, listRules, payeeKey, type Rule } from "./categorize";
import { ServiceError, type ServiceContext } from "./context";

const UNCATEGORIZED = new Set([UNCATEGORIZED_EXPENSE, UNCATEGORIZED_INCOME]);

export interface SimilarTxn {
  wmma_id: string;
  date: string;
  payee: string;
  amount_cents: number;
  /** Current category; Expenses/Income:Uncategorized when it has none. */
  category: string;
  cat_by: string | null;
}

export interface SimilarResult {
  payeeKey: string;
  /** Other transactions from the same payee (newest first), excluding the one asked about. */
  transactions: SimilarTxn[];
  /** The rule that already matches this payee, if any. */
  rule: Rule | null;
}

interface Located extends SimilarTxn {
  file: string;
}

/** Simple bank transactions: one $ bank posting and one Income/Expenses posting (splits and transfers are skipped). */
function locate(txns: HledgerTransaction[]): Located[] {
  const out: Located[] = [];
  for (const t of txns) {
    const tags = new Map(t.ttags);
    const id = tags.get("wmma_id");
    if (!id || t.tpostings.length !== 2) continue;
    const cat = t.tpostings.find((p) => /^(Income|Expenses):/.test(p.paccount));
    const bank = t.tpostings.find((p) => p !== cat);
    if (!cat || !bank || !/^(Assets|Liabilities):/.test(bank.paccount) || bank.pamount.length !== 1 || bank.pamount[0]!.acommodity !== "$") continue;
    out.push({
      wmma_id: id,
      date: t.tdate,
      payee: t.tdescription.split(" | ")[0]!.trim(),
      amount_cents: M.toCents(M.fromHledgerQuantity(bank.pamount[0]!.aquantity)),
      category: cat.paccount,
      cat_by: tags.get("cat_by") ?? null,
      file: t.tsourcepos[0]?.sourceName ?? "",
    });
  }
  return out;
}

const ruleFor = (ctx: ServiceContext, key: string) => listRules(ctx).find((r) => r.match.payeeKey === key && Object.keys(r.match).length === 1) ?? null;

async function matches(ctx: ServiceContext, wmmaId: string): Promise<{ key: string; self: Located; others: Located[] }> {
  const all = locate(await ctx.hledger.transactions());
  const self = all.find((t) => t.wmma_id === wmmaId);
  if (!self) throw new ServiceError("transaction not found, or it is split / a transfer", 404);
  const key = payeeKey(self.payee);
  if (!key) return { key, self, others: [] };
  const others = all.filter((t) => t.wmma_id !== wmmaId && payeeKey(t.payee) === key).sort((a, b) => b.date.localeCompare(a.date));
  return { key, self, others };
}

export async function similarTransactions(ctx: ServiceContext, wmmaId: string): Promise<SimilarResult> {
  const { key, others } = await matches(ctx, wmmaId);
  return { payeeKey: key, transactions: others.map(({ file: _f, ...t }) => t), rule: key ? ruleFor(ctx, key) : null };
}

export interface ApplySimilarInput {
  wmmaId: string;
  category: string;
  /** Also move transactions that already have a (different) category. Default: only uncategorized ones. */
  includeCategorized?: boolean;
  /** Create (or retarget) the payee's rule so future imports get the category. */
  createRule?: boolean;
}

export interface ApplySimilarResult {
  updated: string[];
  rule: Rule | null;
  ruleCreated: boolean;
}

export async function applyToSimilar(ctx: ServiceContext, actor: string, input: ApplySimilarInput): Promise<ApplySimilarResult> {
  try {
    validateAccount(input.category);
  } catch {
    throw new ServiceError(`invalid category ${JSON.stringify(input.category)}`);
  }
  if (!/^(Income|Expenses):/.test(input.category) || UNCATEGORIZED.has(input.category)) throw new ServiceError("category must be an Income or Expenses category");
  const { key, others } = await matches(ctx, input.wmmaId);
  if (!key) throw new ServiceError("this payee has no name to match on", 422);

  await ctx.store.declareAccounts([{ name: input.category, type: accountType(input.category) }]);
  const updated: string[] = [];
  const before: Array<{ wmma_id: string; category: string }> = [];
  const resolveQueued = ctx.db.query("UPDATE review_queue SET status = 'changed', chosen = ?, reason = 'manual', resolved_at = ? WHERE wmma_id = ? AND status = 'pending'");
  for (const t of others) {
    if (t.category === input.category) continue;
    if (!UNCATEGORIZED.has(t.category) && !input.includeCategorized) continue;
    // A person chose this: Jev re-runs leave it alone.
    await ctx.store.updateTransaction(t.file, t.wmma_id, { setTags: { cat_by: "manual" }, replaceAccount: { from: t.category, to: input.category } });
    resolveQueued.run(input.category, nowIso(), t.wmma_id);
    before.push({ wmma_id: t.wmma_id, category: t.category });
    updated.push(t.wmma_id);
  }

  let rule: Rule | null = ruleFor(ctx, key);
  let ruleCreated = false;
  if (input.createRule) {
    if (!rule) {
      rule = await createRule(ctx, actor, { match: { payeeKey: key }, target: input.category, createdFrom: "manual" });
      ruleCreated = true;
    } else if (rule.target_account !== input.category) {
      const old = rule;
      ctx.db.query("UPDATE rules SET target_account = ?, created_from = 'manual' WHERE id = ?").run(input.category, rule.id);
      rule = listRules(ctx).find((r) => r.id === old.id)!;
      await ctx.audit.append({ actor, operation: "rule.update", inputs: { id: old.id, target: input.category }, before: old, after: rule });
    }
  }
  if (rule && updated.length > 0) ctx.db.query("UPDATE rules SET hit_count = hit_count + ? WHERE id = ?").run(updated.length, rule.id);
  await ctx.audit.append({ actor, operation: "transaction.apply_similar", inputs: input, before, after: { updated, rule: rule?.id ?? null } });
  return { updated, rule, ruleCreated };
}

export async function deleteRule(ctx: ServiceContext, actor: string, id: string): Promise<void> {
  const rule = listRules(ctx).find((r) => r.id === id);
  if (!rule) throw new ServiceError("rule not found", 404);
  ctx.db.query("DELETE FROM rules WHERE id = ?").run(id);
  await ctx.audit.append({ actor, operation: "rule.delete", inputs: { id }, before: rule, after: null });
}
