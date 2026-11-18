/** Turning upstream names into hledger account segments and slugs. */
import type { AccountKind } from "./db";

/** "Chase Sapphire (4321)" -> "ChaseSapphire4321"; "🏠 Rent/Mortgage" -> "RentMortgage". */
export function accountSegment(name: string, fallback = "Unnamed"): string {
  const words = name.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
  const seg = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");
  return seg || fallback;
}

/** "Chase Sapphire (4321)" -> "chase-sapphire-4321" */
export function slugify(name: string, fallback = "account"): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  return s || fallback;
}

/** Pick a slug not in `taken` by appending -2, -3, ... */
export function uniqueSlug(base: string, taken: (s: string) => boolean): string {
  if (!taken(base)) return base;
  for (let i = 2; ; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`;
}

export const KIND_PREFIX: Record<AccountKind, string> = {
  bank: "Assets:Checking",
  credit: "Liabilities:CreditCards",
  investment: "Assets:Investments",
  vehicle: "Assets:Vehicles",
  real_estate: "Assets:RealEstate",
  other_asset: "Assets:Other",
  loan: "Liabilities:Loans",
};

export const isAssetKind = (k: AccountKind) => KIND_PREFIX[k].startsWith("Assets:");

export const UNCATEGORIZED_INCOME = "Income:Uncategorized";
export const UNCATEGORIZED_EXPENSE = "Expenses:Uncategorized";
export const UNREALIZED = "Equity:Unrealized";
export const OPENING_BALANCES = "Equity:OpeningBalances";
/** Clearing account for transfers YNAB records as split-to-split (see ynab/convert.ts). */
export const TRANSFER_CLEARING = "Equity:Transfers";

/** hledger account type letter from the top-level name. */
export function accountType(hledgerAccount: string): "A" | "L" | "E" | "R" | "X" {
  const top = hledgerAccount.split(":")[0];
  switch (top) {
    case "Assets":
      return "A";
    case "Liabilities":
      return "L";
    case "Equity":
      return "E";
    case "Income":
      return "R";
    default:
      return "X";
  }
}
