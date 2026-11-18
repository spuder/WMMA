/**
 * YNAB API importer: fetch a plan's accounts, categories and full transaction
 * history, keep the raw JSON, and normalise it.
 * Docs: https://api.ynab.com/v1 (plans were called budgets before 2025).
 */
import * as M from "../../money";
import type { YnabAccount, YnabAccountType, YnabCategory, YnabDataset, YnabLine, YnabTransaction } from "./model";

/** The subset of the API response WMMA uses. Stored raw under imports/ynab/. */
export interface YnabRawExport {
  fetchedAt: string;
  planId: string;
  accounts: RawAccount[];
  categoryGroups: RawCategoryGroup[];
  transactions: RawTransaction[];
}

interface RawAccount {
  id: string;
  name: string;
  type: string;
  closed: boolean;
  balance: number;
  deleted: boolean;
}
interface RawCategoryGroup {
  id: string;
  name: string;
  deleted?: boolean;
  categories: Array<{ id: string; name: string; category_group_id?: string; deleted?: boolean }>;
}
interface RawSub {
  id: string;
  amount: number;
  memo: string | null;
  payee_name: string | null;
  category_id: string | null;
  category_name: string | null;
  transfer_account_id: string | null;
  transfer_transaction_id: string | null;
  deleted?: boolean;
}
interface RawTransaction extends RawSub {
  date: string;
  cleared: "cleared" | "uncleared" | "reconciled";
  account_id: string;
  subtransactions?: RawSub[];
}

export interface RawBudgetMonth {
  month: string;
  deleted?: boolean;
  categories: Array<{ name: string; category_group_name?: string; budgeted: number; deleted?: boolean; hidden?: boolean }>;
}

export interface YnabBudgetAmount {
  /** YYYY-MM */
  month: string;
  group: string;
  name: string;
  amount: M.Money;
}

export function normaliseBudgetMonths(months: RawBudgetMonth[]): YnabBudgetAmount[] {
  const out: YnabBudgetAmount[] = [];
  for (const m of months) {
    if (m.deleted) continue;
    for (const c of m.categories) {
      if (c.deleted || !c.category_group_name) continue;
      out.push({ month: m.month.slice(0, 7), group: c.category_group_name, name: c.name, amount: M.fromMilliunits(c.budgeted) });
    }
  }
  return out;
}

export class YnabApiError extends Error {
  override name = "YnabApiError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface YnabApiOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class YnabApi {
  readonly #token: string;
  readonly #base: string;
  readonly #fetch: typeof fetch;

  constructor(token: string, opts: YnabApiOptions = {}) {
    if (!token) throw new YnabApiError("YNAB_TOKEN is not set", 0);
    this.#token = token;
    this.#base = (opts.baseUrl ?? "https://api.ynab.com/v1").replace(/\/$/, "");
    this.#fetch = opts.fetch ?? fetch;
  }

  async #get<T>(path: string): Promise<T> {
    const res = await this.#fetch(this.#base + path, {
      headers: { Authorization: `Bearer ${this.#token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { error?: { detail?: string } };
        detail = body.error?.detail ?? "";
      } catch {
        // ignore
      }
      throw new YnabApiError(`YNAB API ${path.split("?")[0]}: HTTP ${res.status}${detail ? ` (${detail})` : ""}`, res.status);
    }
    return ((await res.json()) as { data: T }).data;
  }

  /** Monthly budgeted amounts per category, from the full plan export. */
  async fetchBudgetMonths(planId = "last-used"): Promise<RawBudgetMonth[]> {
    const data = await this.#get<{ plan: { months?: RawBudgetMonth[] } }>(`/plans/${encodeURIComponent(planId)}`);
    return data.plan.months ?? [];
  }

  async fetchPlan(planId = "last-used"): Promise<YnabRawExport> {
    const p = `/plans/${encodeURIComponent(planId)}`;
    const [acc, cats, txns] = await Promise.all([
      this.#get<{ accounts: RawAccount[] }>(`${p}/accounts`),
      this.#get<{ category_groups: RawCategoryGroup[] }>(`${p}/categories`),
      // since_date defaults to one year ago; ask for everything.
      this.#get<{ transactions: RawTransaction[] }>(`${p}/transactions?since_date=1900-01-01`),
    ]);
    return {
      fetchedAt: new Date().toISOString(),
      planId,
      accounts: acc.accounts,
      categoryGroups: cats.category_groups,
      transactions: txns.transactions,
    };
  }
}

const ACCOUNT_TYPES: ReadonlySet<string> = new Set([
  "checking",
  "savings",
  "cash",
  "creditCard",
  "lineOfCredit",
  "otherAsset",
  "otherLiability",
  "mortgage",
  "autoLoan",
  "studentLoan",
  "personalLoan",
  "medicalDebt",
  "otherDebt",
]);

export function normaliseApiExport(raw: YnabRawExport): YnabDataset {
  const categories = new Map<string, YnabCategory>();
  for (const g of raw.categoryGroups) {
    for (const c of g.categories) categories.set(c.id, { group: g.name, name: c.name });
  }
  const category = (id: string | null, name: string | null): YnabCategory | null => {
    if (id && categories.has(id)) return categories.get(id)!;
    return name ? { group: "Ungrouped", name } : null;
  };

  const line = (r: RawSub): YnabLine => ({
    key: r.id,
    amount: M.fromMilliunits(r.amount),
    payee: r.payee_name,
    memo: r.memo,
    category: r.transfer_account_id ? null : category(r.category_id, r.category_name),
    transferAccountKey: r.transfer_account_id,
    transferPeerKey: r.transfer_transaction_id,
  });

  const accounts: YnabAccount[] = raw.accounts
    .filter((a) => !a.deleted)
    .map((a) => ({
      key: a.id,
      name: a.name,
      type: ACCOUNT_TYPES.has(a.type) ? (a.type as YnabAccountType) : null,
      closed: a.closed,
      balance: M.fromMilliunits(a.balance),
    }));

  const transactions: YnabTransaction[] = raw.transactions
    .filter((t) => !t.deleted)
    .map((t) => {
      const subs = (t.subtransactions ?? []).filter((s) => !s.deleted).map(line);
      return { ...line(t), accountKey: t.account_id, date: t.date, cleared: t.cleared !== "uncleared", subs };
    });

  return { accounts, transactions };
}
