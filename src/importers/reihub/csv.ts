/**
 * REI Hub transaction CSV export. The exact columns aren't documented, so
 * header names are matched case-insensitively against common candidates and
 * can be overridden. Categories are kept via `mappings` (source "reihub").
 */
import { createHash } from "node:crypto";
import * as M from "../../money";
import type { Money } from "../../money";
import { parseCsv } from "../csv";
import { detectDateFormat, parseDate, type DateFormat } from "../ynab/csv";

export interface ReiHubColumns {
  date: string;
  amount?: string;
  /** Separate income / expense columns (both positive), instead of `amount`. */
  income?: string;
  expense?: string;
  category: string;
  payee?: string;
  memo?: string;
  property?: string;
  account?: string;
  id?: string;
}

export interface ReiHubOptions {
  columns?: Partial<ReiHubColumns>;
  dateFormat?: DateFormat;
  /** Flip signs if the export shows expenses as positive. */
  invertAmount?: boolean;
}

export interface ReiHubRecord {
  externalId: string;
  date: string;
  amount: Money;
  payee: string;
  memo: string | null;
  category: string;
  property: string | null;
  account: string | null;
}

export class ReiHubError extends Error {
  override name = "ReiHubError";
}

const CANDIDATES: Record<keyof ReiHubColumns, string[]> = {
  date: ["date", "transaction date", "posted date"],
  amount: ["amount", "total"],
  income: ["income", "money in", "credit"],
  expense: ["expense", "expenses", "money out", "debit"],
  category: ["category", "account category", "type"],
  payee: ["payee", "vendor", "payee/payer", "name", "contact"],
  memo: ["description", "memo", "notes", "note"],
  property: ["property", "property name", "unit"],
  account: ["account", "bank account", "financial account"],
  id: ["id", "transaction id", "reference"],
};

function money(s: string): Money {
  const t = s.trim();
  return t === "" ? M.ZERO : M.parse(t);
}

export function parseReiHubCsv(text: string, opts: ReiHubOptions = {}): ReiHubRecord[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const lower = new Map(header.map((h, i) => [h.trim().toLowerCase(), i]));
  const col = (k: keyof ReiHubColumns): number | undefined => {
    const override = opts.columns?.[k];
    if (override !== undefined) {
      const i = lower.get(override.toLowerCase());
      if (i === undefined) throw new ReiHubError(`column ${JSON.stringify(override)} not found (have: ${header.join(", ")})`);
      return i;
    }
    for (const c of CANDIDATES[k]) if (lower.has(c)) return lower.get(c);
    return undefined;
  };
  const idx = Object.fromEntries((Object.keys(CANDIDATES) as Array<keyof ReiHubColumns>).map((k) => [k, col(k)])) as Record<keyof ReiHubColumns, number | undefined>;
  if (idx.date === undefined) throw new ReiHubError("no date column found; set columns.date");
  if (idx.category === undefined) throw new ReiHubError("no category column found; set columns.category");
  const signed = idx.amount !== undefined;
  if (!signed && (idx.income === undefined || idx.expense === undefined)) throw new ReiHubError("no amount column (or income + expense columns) found");

  const get = (r: string[], i: number | undefined) => (i === undefined ? "" : (r[i] ?? "").trim());
  const data = rows.filter((r) => r.some((f) => f.trim() !== ""));
  const fmt = opts.dateFormat ?? detectDateFormat(data.map((r) => get(r, idx.date)));
  const seen = new Map<string, number>();
  return data.map((r, n) => {
    let amount: Money;
    try {
      amount = signed ? money(get(r, idx.amount)) : M.sub(M.abs(money(get(r, idx.income))), M.abs(money(get(r, idx.expense))));
    } catch (e) {
      throw new ReiHubError(`row ${n + 2}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (opts.invertAmount) amount = M.neg(amount);
    const date = parseDate(get(r, idx.date), fmt);
    const category = get(r, idx.category) || "Uncategorized";
    const payee = get(r, idx.payee);
    const memo = get(r, idx.memo) || null;
    const property = get(r, idx.property) || null;
    let externalId = get(r, idx.id);
    if (!externalId) {
      const base = createHash("sha256").update([date, M.toCents(amount), payee, memo ?? "", category, property ?? ""].join("\u001f")).digest("hex").slice(0, 24);
      const k = seen.get(base) ?? 0;
      seen.set(base, k + 1);
      externalId = k === 0 ? base : `${base}-${k}`;
    }
    return { externalId, date, amount, payee: payee || memo || category, memo: payee ? memo : null, category, property, account: get(r, idx.account) || null };
  });
}

/** Default Schedule E account for a REI Hub category name. */
export function defaultReiHubAccount(category: string, inflow: boolean): string {
  const c = category.toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/rent|lease/, inflow ? "Income:Rents" : "Expenses:Rent:Property"],
    [/royalt/, "Income:Royalties"],
    [/advertis|marketing|listing/, "Expenses:Advertising"],
    [/auto|travel|mileage/, "Expenses:AutoTravel"],
    [/clean|maintenance|landscap|lawn|pest/, "Expenses:CleaningMaintenance"],
    [/commission/, "Expenses:Commissions"],
    [/insurance/, "Expenses:Insurance:Rental"],
    [/legal|professional|accounting|attorney/, "Expenses:LegalProfessional"],
    [/management|property manager/, "Expenses:ManagementFees"],
    [/mortgage interest/, "Expenses:Interest:Mortgage"],
    [/interest/, "Expenses:Interest:Other"],
    [/repair/, "Expenses:Repairs"],
    [/suppl/, "Expenses:Supplies"],
    [/tax/, "Expenses:Taxes:Property"],
    [/utilit|water|electric|gas|trash|sewer/, "Expenses:Utilities"],
    [/depreciation/, "Expenses:Depreciation"],
  ];
  for (const [re, account] of rules) if (re.test(c)) return account;
  return inflow ? "Income:OtherRental" : "Expenses:OtherRental";
}
