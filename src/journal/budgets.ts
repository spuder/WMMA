/**
 * Budgets as hledger periodic transactions (SPEC §6), in budgets.journal.
 *
 * Model: per entity, a list of changes (account, month, amount): the amount
 * applies from that month until the next change. Rendered as one bounded
 * periodic transaction per entity per range, with unbalanced virtual postings:
 *
 *   ~ monthly from 2026-01-01 to 2026-03-01  ; wmma_budget:personal
 *       (Expenses:Food:Groceries)  $400.00
 *
 * WMMA is the only writer, so it can read its own format back.
 */
import * as M from "../money";
import type { Money } from "../money";
import { validateAccount } from "./format";

export interface BudgetChange {
  entity: string;
  account: string;
  /** YYYY-MM */
  month: string;
  amount: Money;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function validateMonth(m: string): void {
  if (!MONTH_RE.test(m)) throw new Error(`invalid month ${JSON.stringify(m)} (want YYYY-MM)`);
}

export function nextMonth(m: string): string {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
}

export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m = nextMonth(m)) out.push(m);
  return out;
}

/** Amount in effect for (entity, account) in `month`, or zero. */
export function effectiveAmount(changes: BudgetChange[], entity: string, account: string, month: string): Money {
  let best: BudgetChange | undefined;
  for (const c of changes) {
    if (c.entity === entity && c.account === account && c.month <= month && (!best || c.month > best.month)) best = c;
  }
  return best ? best.amount : M.ZERO;
}

/** Drop changes that repeat the amount already in effect; sort. */
export function normalise(changes: BudgetChange[]): BudgetChange[] {
  const sorted = [...changes].sort((a, b) => a.entity.localeCompare(b.entity) || a.account.localeCompare(b.account) || a.month.localeCompare(b.month));
  const out: BudgetChange[] = [];
  const last = new Map<string, BudgetChange>();
  for (const c of sorted) {
    const k = `${c.entity}\u0000${c.account}`;
    const prev = last.get(k);
    if (prev && prev.month === c.month) {
      out[out.indexOf(prev)] = c; // same month: later value wins
      last.set(k, c);
      continue;
    }
    if ((prev && M.equals(prev.amount, c.amount)) || (!prev && M.isZero(c.amount))) continue;
    out.push(c);
    last.set(k, c);
  }
  return out;
}

export function renderBudgets(changes: BudgetChange[], header: string): string {
  const norm = normalise(changes);
  const parts = [header.trimEnd(), ""];
  const entities = [...new Set(norm.map((c) => c.entity))].sort();
  for (const entity of entities) {
    const mine = norm.filter((c) => c.entity === entity);
    const accounts = [...new Set(mine.map((c) => c.account))].sort();
    const months = [...new Set(mine.map((c) => c.month))].sort();
    months.forEach((from, i) => {
      const to = months[i + 1];
      const postings = accounts
        .map((a) => [a, effectiveAmount(mine, entity, a, from)] as const)
        .filter(([, amt]) => !M.isZero(amt));
      if (postings.length === 0) return;
      parts.push(`~ monthly from ${from}-01${to ? ` to ${to}-01` : ""}  ; wmma_budget:${entity}`);
      const w = Math.max(...postings.map(([a]) => a.length + 2));
      for (const [a, amt] of postings) parts.push(`    ${`(${a})`.padEnd(w)}  ${M.toJournal(amt)}`);
      parts.push("");
    });
  }
  return parts.join("\n") + (parts[parts.length - 1] === "" ? "" : "\n");
}

export function parseBudgets(text: string): BudgetChange[] {
  const changes: BudgetChange[] = [];
  const blocks: Array<{ entity: string; from: string; to: string | null; amounts: Map<string, Money> }> = [];
  let cur: (typeof blocks)[number] | null = null;
  for (const line of text.split("\n")) {
    const h = /^~ monthly from (\d{4}-\d{2})-01(?: to (\d{4}-\d{2})-01)?\s+;\s*wmma_budget:([a-z0-9-]+)\s*$/.exec(line);
    if (h) {
      cur = { from: h[1]!, to: h[2] ?? null, entity: h[3]!, amounts: new Map() };
      blocks.push(cur);
      continue;
    }
    const p = /^ {4}\((.+)\)\s{2,}(\S+)$/.exec(line);
    if (p && cur) {
      cur.amounts.set(p[1]!, M.parse(p[2]!));
      continue;
    }
    if (line.trim() === "" || line.startsWith(";")) {
      if (line.trim() === "") cur = null;
      continue;
    }
    throw new Error(`budgets.journal: unexpected line ${JSON.stringify(line)}`);
  }
  // Reconstruct changes: each block sets every listed account; accounts that
  // disappear from one block to the next drop to zero.
  // A block whose `to` isn't followed by another block means everything stops there.
  const sorted = blocks.sort((a, b) => a.entity.localeCompare(b.entity) || a.from.localeCompare(b.from));
  const prevByEntity = new Map<string, Map<string, Money>>();
  sorted.forEach((b, i) => {
    const prev = prevByEntity.get(b.entity) ?? new Map<string, Money>();
    for (const [account, amount] of b.amounts) changes.push({ entity: b.entity, account, month: b.from, amount });
    for (const account of prev.keys()) if (!b.amounts.has(account)) changes.push({ entity: b.entity, account, month: b.from, amount: M.ZERO });
    prevByEntity.set(b.entity, b.amounts);
    const next = sorted[i + 1];
    if (b.to && !(next && next.entity === b.entity && next.from === b.to)) {
      for (const account of b.amounts.keys()) changes.push({ entity: b.entity, account, month: b.to, amount: M.ZERO });
      prevByEntity.set(b.entity, new Map());
    }
  });
  return normalise(changes);
}

export function validateChange(c: BudgetChange): void {
  validateMonth(c.month);
  validateAccount(c.account);
  if (!c.account.startsWith("Expenses:") && !c.account.startsWith("Income:")) throw new Error("budgets are for Income and Expenses accounts");
  if (M.isNegative(c.amount)) throw new Error("budget amounts must not be negative");
}
