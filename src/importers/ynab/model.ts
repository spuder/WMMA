/**
 * Normalised YNAB data. Both the API and the CSV importer produce this shape;
 * one converter (convert.ts) turns it into journal transactions.
 */
import type { Money } from "../../money";

export type YnabAccountType =
  | "checking"
  | "savings"
  | "cash"
  | "creditCard"
  | "lineOfCredit"
  | "otherAsset"
  | "otherLiability"
  | "mortgage"
  | "autoLoan"
  | "studentLoan"
  | "personalLoan"
  | "medicalDebt"
  | "otherDebt";

export interface YnabAccount {
  /** API account id, or the account name for CSV. */
  key: string;
  name: string;
  /** Unknown for CSV exports. */
  type: YnabAccountType | null;
  closed: boolean;
  /** Balance as YNAB reports it (API), or the sum of exported rows (CSV); null if unknown. */
  balance: Money | null;
}

export interface YnabCategory {
  group: string;
  name: string;
}

export interface YnabLine {
  /** Stable upstream id: API id, or a content hash for CSV. */
  key: string;
  amount: Money;
  payee: string | null;
  memo: string | null;
  /** null = uncategorised (also the case for transfers and tracking accounts). */
  category: YnabCategory | null;
  transferAccountKey: string | null;
  /** Key of the line on the other side of a transfer, when known. */
  transferPeerKey: string | null;
}

export interface YnabTransaction extends YnabLine {
  accountKey: string;
  /** YYYY-MM-DD */
  date: string;
  cleared: boolean;
  /** Non-empty for split transactions; the parent's category is then ignored. */
  subs: YnabLine[];
}

export interface YnabDataset {
  accounts: YnabAccount[];
  transactions: YnabTransaction[];
}

/** "Inflow: Ready to Assign" (and its older name "To be Budgeted"). */
export function isReadyToAssign(c: YnabCategory | null): boolean {
  if (!c) return false;
  const full = `${c.group}: ${c.name}`.toLowerCase();
  return (
    full === "inflow: ready to assign" ||
    full === "internal master category: inflow: ready to assign" ||
    c.name.toLowerCase() === "inflow: ready to assign" ||
    /to be budgeted/.test(full)
  );
}

/** YNAB's own "Uncategorized" bucket counts as no category. */
export function isUncategorized(c: YnabCategory | null): boolean {
  return !c || c.name.toLowerCase() === "uncategorized" || c.name.toLowerCase() === "split";
}

export const categoryLabel = (c: YnabCategory) => `${c.group}: ${c.name}`;
