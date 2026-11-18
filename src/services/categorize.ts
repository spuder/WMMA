/**
 * Categorization pipeline (SPEC §5): mapping (done at import) -> rules -> Jev
 * -> review queue. Jev failures or a missing key send transactions to the
 * queue; the pipeline never fails an import.
 *
 * Learning: the 3rd time the same payee is accepted into the same category,
 * a rule is created (created_from: swipe) and applied to matching pending items.
 */
import { nowIso } from "../db";
import { validateAccount } from "../journal/format";
import type { HledgerTransaction } from "../hledger/web";
import { JEV_MAX_OPTIONS, JevError, type JevClient } from "../jev";
import * as M from "../money";
import type { Money } from "../money";
import { accountType, UNCATEGORIZED_EXPENSE, UNCATEGORIZED_INCOME } from "../naming";
import { ulid } from "../ulid";
import { getEntity } from "./accounts";
import { templateAccounts } from "../templates";
import { ServiceError, type ServiceContext } from "./context";

export const JEV_APPLY_THRESHOLD = 0.9;
export const SWIPES_FOR_RULE = 3;
const UNCATEGORIZED = new Set([UNCATEGORIZED_EXPENSE, UNCATEGORIZED_INCOME]);

/** "GROCER #12 SALT LAKE" -> "grocer salt lake"; store numbers and punctuation dropped. */
export function payeeKey(payee: string): string {
  return payee
    .toLowerCase()
    .replace(/[^a-z\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface RuleMatch {
  payeeKey?: string;
  payeeContains?: string;
  amountMin?: number;
  amountMax?: number;
  account?: string;
}

export interface Rule {
  id: string;
  match: RuleMatch;
  target_account: string;
  entity_override: string | null;
  created_from: "swipe" | "manual";
  hit_count: number;
  created_at: string;
}

/** An entry the pipeline can categorise: one bank-side posting, one uncategorised posting. */
export interface Uncategorized {
  wmmaId: string;
  file: string;
  date: string;
  payee: string;
  memo: string | null;
  amount: Money;
  account: string;
  entity: string | null;
  uncategorized: string;
}

export function findUncategorized(txns: HledgerTransaction[]): Uncategorized[] {
  const out: Uncategorized[] = [];
  for (const t of txns) {
    const tags = new Map(t.ttags);
    const wmmaId = tags.get("wmma_id");
    if (!wmmaId || t.tpostings.length !== 2) continue;
    const u = t.tpostings.find((p) => UNCATEGORIZED.has(p.paccount));
    const bank = t.tpostings.find((p) => p !== u);
    if (!u || !bank || bank.pamount.length !== 1 || bank.pamount[0]!.acommodity !== "$") continue;
    const [payee, ...memo] = t.tdescription.split(" | ");
    out.push({
      wmmaId,
      file: t.tsourcepos[0]?.sourceName ?? "",
      date: t.tdate,
      payee: payee!.trim(),
      memo: memo.length ? memo.join(" | ").trim() : null,
      amount: M.fromHledgerQuantity(bank.pamount[0]!.aquantity),
      account: bank.paccount,
      entity: tags.get("entity") ?? null,
      uncategorized: u.paccount,
    });
  }
  return out;
}

export function ruleMatches(rule: RuleMatch, u: Pick<Uncategorized, "payee" | "amount" | "account">): boolean {
  if (rule.payeeKey !== undefined && payeeKey(u.payee) !== rule.payeeKey) return false;
  if (rule.payeeContains !== undefined && !u.payee.toLowerCase().includes(rule.payeeContains.toLowerCase())) return false;
  const c = M.toCents(u.amount);
  if (rule.amountMin !== undefined && c < rule.amountMin) return false;
  if (rule.amountMax !== undefined && c > rule.amountMax) return false;
  if (rule.account !== undefined && u.account !== rule.account) return false;
  return true;
}

export function listRules(ctx: ServiceContext): Rule[] {
  // Manual rules take priority over learned ones; older first within each.
  return (ctx.db.query("SELECT * FROM rules ORDER BY created_from = 'swipe', created_at, id").all() as Array<Omit<Rule, "match"> & { match: string }>).map(
    (r) => ({ ...r, match: JSON.parse(r.match) as RuleMatch }),
  );
}

export function validateRuleMatch(v: unknown): RuleMatch {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ServiceError("match must be an object");
  const o = v as Record<string, unknown>;
  const out: RuleMatch = {};
  for (const k of ["payeeKey", "payeeContains", "account"] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== "string" || !o[k]) throw new ServiceError(`match.${k} must be a non-empty string`);
    out[k] = o[k] as string;
  }
  for (const k of ["amountMin", "amountMax"] as const) {
    if (o[k] === undefined) continue;
    if (!Number.isSafeInteger(o[k])) throw new ServiceError(`match.${k} must be integer cents`);
    out[k] = o[k] as number;
  }
  if (out.payeeKey === undefined && out.payeeContains === undefined && out.account === undefined) {
    throw new ServiceError("match needs payeeKey, payeeContains or account");
  }
  return out;
}

function checkTarget(target: string): void {
  try {
    validateAccount(target);
  } catch {
    throw new ServiceError(`invalid account ${JSON.stringify(target)}`);
  }
  if (!/^(Income|Expenses|Equity|Assets|Liabilities):/.test(target)) throw new ServiceError("target must be under Income, Expenses, Equity, Assets or Liabilities");
}

export async function createRule(
  ctx: ServiceContext,
  actor: string,
  input: { match: unknown; target: string; entityOverride?: string | null; createdFrom?: "manual" | "swipe" },
): Promise<Rule> {
  const match = validateRuleMatch(input.match);
  checkTarget(input.target);
  if (input.entityOverride && !getEntity(ctx, input.entityOverride)) throw new ServiceError(`unknown entity ${JSON.stringify(input.entityOverride)}`, 404);
  const id = ulid();
  ctx.db
    .query("INSERT INTO rules (id, match, target_account, entity_override, created_from, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, JSON.stringify(match), input.target, input.entityOverride ?? null, input.createdFrom ?? "manual", nowIso());
  const rule = listRules(ctx).find((r) => r.id === id)!;
  await ctx.audit.append({ actor, operation: "rule.create", inputs: input, before: null, after: rule });
  return rule;
}

// ---- Jev ----------------------------------------------------------------

/** "Expenses:Fun:Games" -> "Expense: Fun / Games" */
export function describeAccount(a: string): string {
  const [top, ...rest] = a.split(":");
  const kind = top === "Expenses" ? "Expense" : top === "Income" ? "Income" : top;
  return `${kind}: ${rest.map((s) => s.replace(/([a-z])([A-Z])/g, "$1 $2")).join(" / ")}`;
}

/**
 * Categories Jev may pick for an entity: its template's Income/Expenses
 * accounts plus those it already uses (all accounts if that's fewer than
 * two), most-used first, capped at Jev's option limit.
 */
export function allowedCategories(txns: HledgerTransaction[], declared: string[], entity: string | null, inflow: boolean, template: string[] = []): string[] {
  const isCat = (a: string) => (a.startsWith("Expenses:") || (inflow && a.startsWith("Income:"))) && !UNCATEGORIZED.has(a);
  const usage = new Map<string, number>();
  const entityUsage = new Map<string, number>();
  for (const a of declared) if (isCat(a)) usage.set(a, 0);
  for (const t of txns) {
    const tEntity = new Map(t.ttags).get("entity") ?? null;
    for (const p of t.tpostings) {
      if (!isCat(p.paccount)) continue;
      usage.set(p.paccount, (usage.get(p.paccount) ?? 0) + 1);
      const pEntity = new Map(p.ptags).get("entity") ?? tEntity;
      if (entity && pEntity === entity) entityUsage.set(p.paccount, (entityUsage.get(p.paccount) ?? 0) + 1);
    }
  }
  const pool = new Map(entityUsage.size >= 2 ? entityUsage : usage);
  // The entity's template categories are always on offer.
  for (const a of template) if (isCat(a) && !pool.has(a)) pool.set(a, 0);
  return [...pool.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, JEV_MAX_OPTIONS)
    .map(([a]) => a);
}

function jevState(u: Uncategorized): string {
  return [
    "Bank transaction",
    `Payee: ${u.payee}`,
    ...(u.memo ? [`Memo: ${u.memo}`] : []),
    `Amount: ${M.format(u.amount)} (${M.isNegative(u.amount) ? "money out" : "money in"})`,
    `Account: ${u.account}`,
    `Date: ${u.date}`,
  ].join("\n");
}

// ---- Pipeline -----------------------------------------------------------

export interface CategorizeSummary {
  considered: number;
  byRule: number;
  byJev: number;
  queued: number;
  jevCalls: number;
  errors: string[];
}

interface Change {
  wmma_id: string;
  from: string;
  to: string;
  by: "rule" | "jev" | "swipe";
  rule?: string;
  jev_conf?: number;
}

async function apply(ctx: ServiceContext, u: Uncategorized, to: string, tags: Record<string, string>): Promise<void> {
  await ctx.store.declareAccounts([{ name: to, type: accountType(to) }]);
  await ctx.store.updateTransaction(u.file, u.wmmaId, { setTags: tags, replaceAccount: { from: u.uncategorized, to } });
}

/** Categorise uncategorised entries (optionally only `wmmaIds`). */
export async function categorize(ctx: ServiceContext, actor: string, opts: { wmmaIds?: ReadonlySet<string> } = {}): Promise<CategorizeSummary> {
  const summary: CategorizeSummary = { considered: 0, byRule: 0, byJev: 0, queued: 0, jevCalls: 0, errors: [] };
  const txns = await ctx.hledger.transactions();
  const queued = new Set((ctx.db.query("SELECT wmma_id FROM review_queue").all() as Array<{ wmma_id: string }>).map((r) => r.wmma_id));
  const todo = findUncategorized(txns).filter((u) => !queued.has(u.wmmaId) && (!opts.wmmaIds || opts.wmmaIds.has(u.wmmaId)));
  summary.considered = todo.length;
  if (todo.length === 0) return summary;

  const rules = listRules(ctx);
  const changes: Change[] = [];
  const toJev: Uncategorized[] = [];
  const bumpRule = ctx.db.query("UPDATE rules SET hit_count = hit_count + 1 WHERE id = ?");

  for (const u of todo) {
    const rule = rules.find((r) => ruleMatches(r.match, u));
    if (!rule) {
      toJev.push(u);
      continue;
    }
    const tags: Record<string, string> = { cat_by: "rule" };
    if (rule.entity_override) tags["entity"] = rule.entity_override;
    await apply(ctx, u, rule.target_account, tags);
    bumpRule.run(rule.id);
    changes.push({ wmma_id: u.wmmaId, from: u.uncategorized, to: rule.target_account, by: "rule", rule: rule.id });
    summary.byRule++;
  }

  const enqueue = ctx.db.query(
    "INSERT OR IGNORE INTO review_queue (wmma_id, jev_choices, date, payee, amount_cents, account, entity, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const queue = (u: Uncategorized, choices: Array<{ account: string; probability: number }>, reason: string) => {
    enqueue.run(u.wmmaId, JSON.stringify(choices), u.date, u.payee, M.toCents(u.amount), u.account, u.entity, reason, nowIso());
    summary.queued++;
  };

  if (toJev.length > 0) {
    const jev = ctx.jev ?? null;
    if (!jev) {
      for (const u of toJev) queue(u, [], "jev not configured");
    } else {
      let declared: string[] = [];
      try {
        declared = await ctx.hledger.accountNames();
      } catch {
        // fall back to accounts seen in transactions
      }
      const before = jev.calls;
      let consecutiveFailures = 0;
      for (const u of toJev) {
        const type = u.entity ? getEntity(ctx, u.entity)?.type : undefined;
        const options = allowedCategories(txns, declared, u.entity, !M.isNegative(u.amount), type ? templateAccounts(type) : []);
        if (options.length === 0) {
          queue(u, [], "no categories to choose from");
          continue;
        }
        if (consecutiveFailures >= 3) {
          queue(u, [], "jev unavailable");
          continue;
        }
        try {
          const criteria = Object.fromEntries(options.map((a) => [a, describeAccount(a)]));
          const ans = await jev.choose(jevState(u), "Pick the bookkeeping category for this bank transaction.", criteria);
          consecutiveFailures = 0;
          if (ans.confidence >= JEV_APPLY_THRESHOLD) {
            await apply(ctx, u, ans.choice, { cat_by: "jev", jev_conf: ans.confidence.toFixed(2) });
            changes.push({ wmma_id: u.wmmaId, from: u.uncategorized, to: ans.choice, by: "jev", jev_conf: ans.confidence });
            summary.byJev++;
          } else {
            const top = Object.entries(ans.probabilities)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 3)
              .map(([account, probability]) => ({ account, probability }));
            queue(u, top.length ? top : [{ account: ans.choice, probability: ans.confidence }], "low confidence");
          }
        } catch (e) {
          consecutiveFailures++;
          const msg = e instanceof JevError ? e.message : `Jev: ${e instanceof Error ? e.message : String(e)}`;
          if (!summary.errors.includes(msg)) summary.errors.push(msg);
          queue(u, [], msg);
        }
      }
      summary.jevCalls = jev.calls - before;
    }
  }

  if (changes.length > 0 || summary.queued > 0) {
    await ctx.audit.append({ actor, operation: "categorize", inputs: { wmmaIds: opts.wmmaIds ? [...opts.wmmaIds] : "all" }, before: null, after: { changes, summary } });
  }
  return summary;
}

// ---- Review queue -------------------------------------------------------

export interface ReviewItem {
  wmma_id: string;
  jev_choices: Array<{ account: string; probability: number }>;
  status: "pending" | "accepted" | "changed";
  date: string;
  payee: string;
  amount_cents: number;
  amount: string;
  account: string;
  entity: string | null;
  reason: string | null;
  chosen: string | null;
}

function toItem(r: Record<string, unknown>): ReviewItem {
  return { ...(r as unknown as ReviewItem), jev_choices: JSON.parse(String(r["jev_choices"])), amount: M.format(M.cents(Number(r["amount_cents"]))) };
}

export function listReview(ctx: ServiceContext, status = "pending", limit = 200, order: "oldest" | "newest" = "oldest"): ReviewItem[] {
  const sql = `SELECT * FROM review_queue WHERE status = ? ORDER BY ${order === "newest" ? "date DESC, wmma_id DESC" : "date, wmma_id"} LIMIT ?`;
  return (ctx.db.query(sql).all(status, limit) as Array<Record<string, unknown>>).map(toItem);
}

export interface ReviewResult {
  item: ReviewItem;
  ruleCreated: Rule | null;
  autoResolved: string[];
}

/** Accept Jev's pick or change it (a "swipe"). */
export async function resolveReview(ctx: ServiceContext, actor: string, wmmaId: string, account: string): Promise<ReviewResult> {
  checkTarget(account);
  const row = ctx.db.query("SELECT * FROM review_queue WHERE wmma_id = ?").get(wmmaId) as Record<string, unknown> | null;
  if (!row) throw new ServiceError("not found", 404);
  const item = toItem(row);
  if (item.status !== "pending") throw new ServiceError(`already ${item.status}`, 409);

  const txns = await ctx.hledger.transactions();
  const u = findUncategorized(txns).find((x) => x.wmmaId === wmmaId);
  if (!u) throw new ServiceError("transaction is no longer uncategorised", 409);

  await apply(ctx, u, account, { cat_by: "swipe" });
  const status = item.jev_choices[0]?.account === account ? "accepted" : "changed";
  ctx.db.query("UPDATE review_queue SET status = ?, chosen = ?, resolved_at = ? WHERE wmma_id = ?").run(status, account, nowIso(), wmmaId);

  const key = payeeKey(u.payee);
  let ruleCreated: Rule | null = null;
  const autoResolved: string[] = [];
  if (key) {
    ctx.db
      .query("INSERT INTO swipe_counts (payee_key, target_account, accepted_count) VALUES (?, ?, 1) ON CONFLICT DO UPDATE SET accepted_count = accepted_count + 1")
      .run(key, account);
    const { accepted_count } = ctx.db.query("SELECT accepted_count FROM swipe_counts WHERE payee_key = ? AND target_account = ?").get(key, account) as { accepted_count: number };
    const exists = listRules(ctx).some((r) => r.match.payeeKey === key);
    if (accepted_count >= SWIPES_FOR_RULE && !exists) {
      ruleCreated = await createRule(ctx, actor, { match: { payeeKey: key }, target: account, createdFrom: "swipe" });
      // Apply the new rule to other pending items from the same payee.
      const pending = findUncategorized(await ctx.hledger.transactions());
      const queuedIds = new Set(listReview(ctx).map((r) => r.wmma_id));
      for (const p of pending) {
        if (!queuedIds.has(p.wmmaId) || payeeKey(p.payee) !== key) continue;
        await apply(ctx, p, account, { cat_by: "rule" });
        ctx.db.query("UPDATE review_queue SET status = 'accepted', chosen = ?, reason = 'rule', resolved_at = ? WHERE wmma_id = ?").run(account, nowIso(), p.wmmaId);
        ctx.db.query("UPDATE rules SET hit_count = hit_count + 1 WHERE id = ?").run(ruleCreated.id);
        autoResolved.push(p.wmmaId);
      }
    }
  }

  const after = toItem(ctx.db.query("SELECT * FROM review_queue WHERE wmma_id = ?").get(wmmaId) as Record<string, unknown>);
  await ctx.audit.append({
    actor,
    operation: "review.resolve",
    inputs: { wmmaId, account },
    before: { account: u.uncategorized, status: item.status },
    after: { account, status, ruleCreated: ruleCreated?.id ?? null, autoResolved },
  });
  return { item: after, ruleCreated, autoResolved };
}
