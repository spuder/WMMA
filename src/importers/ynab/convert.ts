/**
 * YnabDataset -> journal transactions (SPEC §4, YNAB specifics).
 *
 * Transfers: YNAB stores both sides. We emit one journal entry per transfer:
 *  - top-level <-> top-level: only the side with the smaller key is emitted;
 *  - split sub <-> top-level: the split emits it, the top-level side is skipped;
 *  - split sub <-> split sub: each split posts to TRANSFER_CLEARING, which nets
 *    to zero, so neither account is double-counted.
 */
import { cleanText, type Posting, type Tags, type Transaction } from "../../journal/format";
import * as M from "../../money";
import type { Money } from "../../money";
import {
  accountSegment,
  OPENING_BALANCES,
  TRANSFER_CLEARING,
  UNCATEGORIZED_EXPENSE,
  UNCATEGORIZED_INCOME,
  UNREALIZED,
} from "../../naming";
import type { AccountKind } from "../../db";
import { transferPostings } from "../../journal/transfers";
import { categoryLabel, isReadyToAssign, isUncategorized, type YnabCategory, type YnabDataset, type YnabLine, type YnabTransaction } from "./model";

export interface ResolvedAccount {
  slug: string;
  hledgerAccount: string;
  entity: string;
  kind: AccountKind;
}

export interface ConvertContext {
  source: "ynab";
  accounts: ReadonlyMap<string, ResolvedAccount>;
  /** Existing category mapping (source category label -> hledger account), if any. */
  lookupMapping: (label: string) => string | undefined;
  newId: () => string;
}

export interface ConvertedTxn {
  slug: string;
  sourceId: string;
  txn: Transaction;
}

export interface ConvertResult {
  txns: ConvertedTxn[];
  /** Transfer counterparts skipped because the other side carries them. */
  pairedSkips: number;
  /** Default mappings created for categories seen for the first time. */
  newMappings: Map<string, string>;
  /** Every hledger account referenced. */
  usedAccounts: Set<string>;
}

export function defaultCategoryAccount(c: YnabCategory): string {
  return `Expenses:${accountSegment(c.group, "Ungrouped")}:${accountSegment(c.name, "Category")}`;
}

const ASSETISH: ReadonlySet<AccountKind> = new Set(["investment", "vehicle", "real_estate", "other_asset"]);

export function convert(ds: YnabDataset, ctx: ConvertContext): ConvertResult {
  const result: ConvertResult = { txns: [], pairedSkips: 0, newMappings: new Map(), usedAccounts: new Set() };

  // Index lines so transfer peers can be classified.
  const subKeys = new Set<string>();
  const topKeys = new Set<string>();
  for (const t of ds.transactions) {
    if (t.subs.length > 0) for (const s of t.subs) subKeys.add(s.key);
    else topKeys.add(t.key);
  }

  const account = (key: string): ResolvedAccount => {
    const a = ctx.accounts.get(key);
    if (!a) throw new Error(`YNAB account ${JSON.stringify(key)} has not been resolved`);
    return a;
  };

  const categoryTarget = (line: YnabLine, owner: ResolvedAccount, t: YnabTransaction): { account: string; mapped: boolean } => {
    const c = line.category;
    if (isReadyToAssign(c) || isUncategorized(c)) {
      if ((t.payee ?? "").trim().toLowerCase() === "starting balance") return { account: OPENING_BALANCES, mapped: false };
      if (isReadyToAssign(c)) return { account: UNCATEGORIZED_INCOME, mapped: false };
      if (ASSETISH.has(owner.kind)) return { account: UNREALIZED, mapped: false };
      return { account: M.isNegative(line.amount) ? UNCATEGORIZED_EXPENSE : UNCATEGORIZED_INCOME, mapped: false };
    }
    const label = cleanText(categoryLabel(c!));
    let target = ctx.lookupMapping(label) ?? result.newMappings.get(label);
    if (!target) {
      target = defaultCategoryAccount(c!);
      result.newMappings.set(label, target);
    }
    return { account: target, mapped: true };
  };

  for (const t of ds.transactions) {
    const owner = account(t.accountKey);

    if (t.subs.length === 0 && t.transferAccountKey) {
      const peer = t.transferPeerKey;
      if (peer && subKeys.has(peer)) {
        result.pairedSkips++;
        continue;
      }
      if (peer && topKeys.has(peer) && peer < t.key) {
        result.pairedSkips++;
        continue;
      }
    }

    // Postings: the counter-side of each line (the owner account gets the total).
    const postings: Posting[] = [];
    const lines = t.subs.length > 0 ? t.subs : [t];
    let allMapped = true;
    let anyCategory = false;
    for (const line of lines) {
      let target: string;
      const tags: Record<string, string> = {};
      if (line.transferAccountKey) {
        const other = account(line.transferAccountKey);
        const splitToSplit = t.subs.length > 0 && line.transferPeerKey !== null && subKeys.has(line.transferPeerKey);
        if (!splitToSplit && other.entity !== owner.entity) {
          // Between entities: route through due-to / due-from so neither P&L sees it.
          // The owner's own posting is added below (as the line total), so drop it here.
          const me = { hledgerAccount: owner.hledgerAccount, entity: owner.entity };
          const them = { hledgerAccount: other.hledgerAccount, entity: other.entity };
          const outflow = M.isNegative(line.amount);
          const legs = outflow ? transferPostings(me, them, M.neg(line.amount)) : transferPostings(them, me, line.amount);
          postings.push(...legs.filter((p) => p.account !== owner.hledgerAccount));
          continue;
        }
        target = splitToSplit ? TRANSFER_CLEARING : other.hledgerAccount;
      } else {
        const ct = categoryTarget(line, owner, t);
        target = ct.account;
        if (ct.mapped) anyCategory = true;
        else allMapped = false;
        if (t.subs.length > 0 && line.category) tags["orig_category"] = cleanText(categoryLabel(line.category));
      }
      postings.push({ account: target, amount: M.neg(line.amount), ...(Object.keys(tags).length ? { tags } : {}) });
    }
    const total: Money = M.sum(lines.map((l) => l.amount));
    postings.unshift({ account: owner.hledgerAccount, amount: total });
    for (const p of postings) result.usedAccounts.add(p.account);

    const tags: Record<string, string> = {
      wmma_id: ctx.newId(),
      source: ctx.source,
      source_id: t.key,
      entity: owner.entity,
    };
    if (t.subs.length === 0 && t.category && !isUncategorized(t.category)) {
      tags["orig_category"] = cleanText(categoryLabel(t.category));
    }
    if (anyCategory && allMapped) tags["cat_by"] = "mapping";

    const payee = cleanText(t.payee ?? "") || "(no payee)";
    const note = cleanText(t.memo ?? "");
    result.txns.push({
      slug: owner.slug,
      sourceId: t.key,
      txn: {
        date: t.date,
        payee,
        ...(note ? { note } : {}),
        status: t.cleared ? "*" : "",
        tags: tags as Tags,
        postings,
      },
    });
  }

  result.txns.sort((a, b) => (a.txn.date === b.txn.date ? (a.sourceId < b.sourceId ? -1 : 1) : a.txn.date < b.txn.date ? -1 : 1));
  return result;
}
