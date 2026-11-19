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
import { isJevFatal, JEV_MAX_OPTIONS, JevError, type JevClient } from "../jev";
import * as M from "../money";
import type { Money } from "../money";
import { accountType, recurringPayeeKey, UNCATEGORIZED_EXPENSE, UNCATEGORIZED_INCOME } from "../naming";
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
  /** A recurring series' payee key (reference codes ignored), see recurringPayeeKey. */
  recurringKey?: string;
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

/**
 * Transactions Jev categorized (cat_by: jev), shaped like Uncategorized with the current category in
 * `uncategorized`, so apply() can move them. Anything a person, a rule or an import mapping set is left out.
 */
export function findJevCategorized(txns: HledgerTransaction[]): Uncategorized[] {
  const out: Uncategorized[] = [];
  for (const t of txns) {
    const tags = new Map(t.ttags);
    const wmmaId = tags.get("wmma_id");
    if (!wmmaId || tags.get("cat_by") !== "jev" || t.tpostings.length !== 2) continue;
    const cat = t.tpostings.find((p) => /^(Income|Expenses):/.test(p.paccount) && !UNCATEGORIZED.has(p.paccount));
    const bank = t.tpostings.find((p) => p !== cat);
    if (!cat || !bank || !/^(Assets|Liabilities):/.test(bank.paccount) || bank.pamount.length !== 1 || bank.pamount[0]!.acommodity !== "$") continue;
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
      uncategorized: cat.paccount,
    });
  }
  return out;
}

export function ruleMatches(rule: RuleMatch, u: Pick<Uncategorized, "payee" | "amount" | "account">): boolean {
  if (rule.payeeKey !== undefined && payeeKey(u.payee) !== rule.payeeKey) return false;
  if (rule.recurringKey !== undefined && recurringPayeeKey(u.payee) !== rule.recurringKey) return false;
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
  for (const k of ["payeeKey", "recurringKey", "payeeContains", "account"] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== "string" || !o[k]) throw new ServiceError(`match.${k} must be a non-empty string`);
    out[k] = o[k] as string;
  }
  for (const k of ["amountMin", "amountMax"] as const) {
    if (o[k] === undefined) continue;
    if (!Number.isSafeInteger(o[k])) throw new ServiceError(`match.${k} must be integer cents`);
    out[k] = o[k] as number;
  }
  if (out.payeeKey === undefined && out.recurringKey === undefined && out.payeeContains === undefined && out.account === undefined) {
    throw new ServiceError("match needs payeeKey, recurringKey, payeeContains or account");
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

/**
 * Create or update the rule for a recurring series, so future charges from the
 * payee get its category and business. Returns the rule and whether it was new.
 */
export async function upsertRecurringRule(
  ctx: ServiceContext,
  actor: string,
  input: { recurringKey: string; kind: "expense" | "income"; target: string; entity: string },
): Promise<{ rule: Rule; created: boolean }> {
  const match: RuleMatch = { recurringKey: input.recurringKey, ...(input.kind === "expense" ? { amountMax: -1 } : { amountMin: 1 }) };
  const existing = listRules(ctx).find((r) => r.match.recurringKey === input.recurringKey && (input.kind === "expense" ? r.match.amountMax !== undefined : r.match.amountMin !== undefined));
  if (!existing) return { rule: await createRule(ctx, actor, { match, target: input.target, entityOverride: input.entity }), created: true };
  checkTarget(input.target);
  if (!getEntity(ctx, input.entity)) throw new ServiceError(`unknown entity ${JSON.stringify(input.entity)}`, 404);
  ctx.db.query("UPDATE rules SET target_account = ?, entity_override = ? WHERE id = ?").run(input.target, input.entity, existing.id);
  const rule = listRules(ctx).find((r) => r.id === existing.id)!;
  await ctx.audit.append({ actor, operation: "rule.update", inputs: input, before: existing, after: rule });
  return { rule, created: false };
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
  /** Left for another run when `limit` cut the list short. */
  remaining?: number;
  /** Per transaction, when asked for (`outcomes: true`): the category applied, or Jev's suggestions. */
  outcomes?: Record<string, CategorizeOutcome>;
}

export interface CategorizeOutcome {
  /** Category applied (by a rule or a confident Jev pick). */
  category?: string;
  by?: "rule" | "jev";
  /** Jev's top choices when it wasn't confident enough to apply. */
  choices?: Array<{ account: string; probability: number }>;
  /** Why it was left uncategorized. */
  reason?: string;
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

export interface CategorizeOptions {
  wmmaIds?: ReadonlySet<string>;
  /**
   * Also re-run pending review items: by default only those that never got a Jev answer
   * (no key yet, Jev down, out of credits); with includeLowConfidence, every pending item.
   */
  retry?: { includeLowConfidence?: boolean };
  /** Most transactions to look at in one run (newest first when retrying). */
  limit?: number;
  /** Report what happened to each transaction in `summary.outcomes`. */
  outcomes?: boolean;
}

/** Categorise uncategorised entries (optionally only `wmmaIds`). */
export async function categorize(ctx: ServiceContext, actor: string, opts: CategorizeOptions = {}): Promise<CategorizeSummary> {
  const summary: CategorizeSummary = { considered: 0, byRule: 0, byJev: 0, queued: 0, jevCalls: 0, errors: [] };
  const txns = await ctx.hledger.transactions();
  const queueRows = ctx.db.query("SELECT wmma_id, status, jev_choices FROM review_queue").all() as Array<{ wmma_id: string; status: string; jev_choices: string }>;
  const skip = new Set(
    queueRows
      .filter((r) => !opts.retry || r.status !== "pending" || (!opts.retry.includeLowConfidence && r.jev_choices !== "[]"))
      .map((r) => r.wmma_id),
  );
  let todo = findUncategorized(txns).filter((u) => !skip.has(u.wmmaId) && (!opts.wmmaIds || opts.wmmaIds.has(u.wmmaId)));
  if (opts.limit !== undefined && todo.length > opts.limit) {
    todo.sort((a, b) => b.date.localeCompare(a.date));
    summary.remaining = todo.length - opts.limit;
    todo = todo.slice(0, opts.limit);
  }
  summary.considered = todo.length;
  if (opts.outcomes) summary.outcomes = {};
  const outcome = (id: string, o: CategorizeOutcome) => {
    if (summary.outcomes) summary.outcomes[id] = o;
  };
  if (todo.length === 0) return summary;
  // A retried item that gets a category leaves the review queue as accepted.
  const resolveQueued = ctx.db.query("UPDATE review_queue SET status = 'accepted', chosen = ?, reason = ?, resolved_at = ? WHERE wmma_id = ? AND status = 'pending'");

  const rules = listRules(ctx);
  // Business first: the first matching rule that sets one wins, even when another
  // rule picks the category (e.g. a recurring series tagged to a business).
  for (const u of todo) {
    const entity = rules.find((r) => r.entity_override && ruleMatches(r.match, u))?.entity_override;
    if (entity && entity !== u.entity) {
      await ctx.store.updateTransaction(u.file, u.wmmaId, { setTags: { entity } });
      u.entity = entity;
    }
  }
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
    resolveQueued.run(rule.target_account, "rule", nowIso(), u.wmmaId);
    outcome(u.wmmaId, { category: rule.target_account, by: "rule" });
    bumpRule.run(rule.id);
    changes.push({ wmma_id: u.wmmaId, from: u.uncategorized, to: rule.target_account, by: "rule", rule: rule.id });
    summary.byRule++;
  }

  const enqueue = ctx.db.query(
    "INSERT INTO review_queue (wmma_id, jev_choices, date, payee, amount_cents, account, entity, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT (wmma_id) DO UPDATE SET jev_choices = excluded.jev_choices, reason = excluded.reason, entity = excluded.entity WHERE review_queue.status = 'pending'",
  );
  const queue = (u: Uncategorized, choices: Array<{ account: string; probability: number }>, reason: string) => {
    enqueue.run(u.wmmaId, JSON.stringify(choices), u.date, u.payee, M.toCents(u.amount), u.account, u.entity, reason, nowIso());
    outcome(u.wmmaId, { choices, reason });
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
          queue(u, [], summary.errors.at(-1) ?? "jev unavailable");
          continue;
        }
        try {
          const criteria = Object.fromEntries(options.map((a) => [a, describeAccount(a)]));
          const ans = await jev.choose(jevState(u), "Pick the bookkeeping category for this bank transaction.", criteria);
          consecutiveFailures = 0;
          if (ans.confidence >= JEV_APPLY_THRESHOLD) {
            await apply(ctx, u, ans.choice, { cat_by: "jev", jev_conf: ans.confidence.toFixed(2) });
            resolveQueued.run(ans.choice, "jev", nowIso(), u.wmmaId);
            outcome(u.wmmaId, { category: ans.choice, by: "jev" });
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
          // A bad key or no credits fails every call the same way: stop asking after the first.
          consecutiveFailures = e instanceof JevError && isJevFatal(e.status) ? 3 : consecutiveFailures + 1;
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

/** Uncategorized transactions (optionally one entity's), newest first: the ids "Send all to Jev" walks through. */
export async function uncategorizedIds(ctx: ServiceContext, entity?: string | null): Promise<string[]> {
  return findUncategorized(await ctx.hledger.transactions())
    .filter((u) => !entity || u.entity === entity)
    .sort((a, b) => b.date.localeCompare(a.date) || b.wmmaId.localeCompare(a.wmmaId))
    .map((u) => u.wmmaId);
}

/** Transactions Jev categorized (optionally one entity's), newest first: what "Re-run Jev" walks through. */
export async function jevCategorizedIds(ctx: ServiceContext, entity?: string | null): Promise<string[]> {
  return findJevCategorized(await ctx.hledger.transactions())
    .filter((u) => !entity || u.entity === entity)
    .sort((a, b) => b.date.localeCompare(a.date) || b.wmmaId.localeCompare(a.wmmaId))
    .map((u) => u.wmmaId);
}

export interface RerunSummary {
  considered: number;
  /** Moved to a different category Jev is now confident about. */
  changed: number;
  /** Jev confidently picked the same category again. */
  confirmed: number;
  /** Jev wasn't confident: the existing category stays. */
  kept: number;
  jevCalls: number;
  errors: string[];
  outcomes: Record<string, { from: string; to?: string; confidence?: number }>;
}

/**
 * Ask Jev again about transactions it categorized earlier (e.g. after new categories were added).
 * A confident answer replaces the category; an unsure one never removes it.
 */
export async function rerunJev(ctx: ServiceContext, actor: string, wmmaIds: ReadonlySet<string>): Promise<RerunSummary> {
  const jev = ctx.jev;
  if (!jev) throw new ServiceError("Jev isn't configured: add a key in Settings", 409);
  const summary: RerunSummary = { considered: 0, changed: 0, confirmed: 0, kept: 0, jevCalls: 0, errors: [], outcomes: {} };
  const txns = await ctx.hledger.transactions();
  const todo = findJevCategorized(txns).filter((u) => wmmaIds.has(u.wmmaId));
  summary.considered = todo.length;
  if (todo.length === 0) return summary;
  let declared: string[] = [];
  try {
    declared = await ctx.hledger.accountNames();
  } catch {
    // fall back to accounts seen in transactions
  }
  const before = jev.calls;
  const changes: Change[] = [];
  for (const u of todo) {
    const type = u.entity ? getEntity(ctx, u.entity)?.type : undefined;
    const options = allowedCategories(txns, declared, u.entity, !M.isNegative(u.amount), type ? templateAccounts(type) : []);
    if (!options.includes(u.uncategorized) && options.length < JEV_MAX_OPTIONS) options.push(u.uncategorized);
    try {
      const criteria = Object.fromEntries(options.map((a) => [a, describeAccount(a)]));
      const ans = await jev.choose(jevState(u), "Pick the bookkeeping category for this bank transaction.", criteria);
      const conf = ans.confidence.toFixed(2);
      if (ans.confidence < JEV_APPLY_THRESHOLD) {
        summary.kept++;
        summary.outcomes[u.wmmaId] = { from: u.uncategorized, confidence: ans.confidence };
      } else if (ans.choice === u.uncategorized) {
        await ctx.store.updateTransaction(u.file, u.wmmaId, { setTags: { jev_conf: conf } });
        summary.confirmed++;
        summary.outcomes[u.wmmaId] = { from: u.uncategorized, to: ans.choice, confidence: ans.confidence };
      } else {
        await apply(ctx, u, ans.choice, { cat_by: "jev", jev_conf: conf });
        changes.push({ wmma_id: u.wmmaId, from: u.uncategorized, to: ans.choice, by: "jev", jev_conf: ans.confidence });
        summary.changed++;
        summary.outcomes[u.wmmaId] = { from: u.uncategorized, to: ans.choice, confidence: ans.confidence };
      }
    } catch (e) {
      const msg = e instanceof JevError ? e.message : `Jev: ${e instanceof Error ? e.message : String(e)}`;
      if (!summary.errors.includes(msg)) summary.errors.push(msg);
      summary.outcomes[u.wmmaId] = { from: u.uncategorized };
      // Every later call would fail the same way (bad key, no credits, Jev down): stop here.
      break;
    }
  }
  summary.jevCalls = jev.calls - before;
  if (changes.length > 0) await ctx.audit.append({ actor, operation: "categorize.rerun", inputs: { wmmaIds: [...wmmaIds] }, before: null, after: { changes, summary: { ...summary, outcomes: undefined } } });
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
