/** Normalised output of the single-account bank importers (QFX/OFX, CSV, SimpleFIN). */
import type { AccountKind } from "../db";
import type { Money } from "../money";

export interface BankRecord {
  /** Upstream id (FITID, SimpleFIN id) or a content hash; unique within the account. */
  externalId: string;
  /** YYYY-MM-DD */
  date: string;
  /** Positive = money into the account. */
  amount: Money;
  payee: string;
  memo: string | null;
  /** Category account, when the source supplies one (REI Hub). */
  category?: string;
  /** Source category, verbatim (tag `orig_category`). */
  origCategory?: string;
  /** Entity override for this record (e.g. by rental property). */
  entity?: string;
  /** Extra transaction tags (e.g. `property`). */
  tags?: Record<string, string>;
}

export interface BankAccountData {
  /** Upstream account identity (e.g. "<bankid>:<acctid>" or a SimpleFIN account id). */
  externalKey: string;
  name: string;
  kindHint: AccountKind | null;
  /** The institution's website domain, when the source says (SimpleFIN org.domain). */
  domain?: string | null;
  balance: { amount: Money; asOf: string } | null;
  records: BankRecord[];
}

/** Make an upstream id safe inside a tag value and an alt_ids list. */
export function safeId(s: string): string {
  return s.trim().replace(/[\s,=;]+/g, "_") || "_";
}
