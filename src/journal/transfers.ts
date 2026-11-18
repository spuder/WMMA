import * as M from "../money";
import type { Money } from "../money";
import { accountSegment } from "../naming";
import type { Posting } from "./format";

export const dueFrom = (entity: string) => `Assets:DueFrom:${accountSegment(entity)}`;
export const dueTo = (entity: string) => `Liabilities:DueTo:${accountSegment(entity)}`;

/**
 * Postings for moving `amount` from one account to another. Between entities
 * the money goes through due-to / due-from accounts so neither P&L sees it.
 */
export function transferPostings(from: { hledgerAccount: string; entity: string }, to: { hledgerAccount: string; entity: string }, amount: Money): Posting[] {
  if (from.entity === to.entity) {
    return [
      { account: from.hledgerAccount, amount: M.neg(amount) },
      { account: to.hledgerAccount, amount },
    ];
  }
  return [
    { account: from.hledgerAccount, amount: M.neg(amount), tags: { entity: from.entity } },
    { account: dueFrom(to.entity), amount, tags: { entity: from.entity } },
    { account: to.hledgerAccount, amount, tags: { entity: to.entity } },
    { account: dueTo(from.entity), amount: M.neg(amount), tags: { entity: to.entity } },
  ];
}
