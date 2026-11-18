/**
 * YNAB register CSV export -> YnabDataset.
 *
 * The export has no ids, so each line's key is a content hash (date, account,
 * payee, category, memo, amount) plus an occurrence counter for identical
 * rows. Cleared status and flags are left out of the hash so they can change
 * between exports without creating duplicates.
 *
 * Splits appear as consecutive rows whose memo starts "Split (i/n)".
 * Transfers appear on both accounts with payee "Transfer : <account>"; the two
 * sides are paired by date and opposite amount.
 */
import { createHash } from "node:crypto";
import * as M from "../../money";
import type { Money } from "../../money";
import { parseCsvRecords } from "../csv";
import type { YnabAccount, YnabCategory, YnabDataset, YnabLine, YnabTransaction } from "./model";

export type DateFormat = "MM/DD/YYYY" | "DD/MM/YYYY" | "YYYY-MM-DD";

export class YnabCsvError extends Error {
  override name = "YnabCsvError";
}

const SPLIT_RE = /^\s*\(?\s*split\s*\(?\s*(\d+)\s*\/\s*(\d+)\s*\)?\s*/i;
const TRANSFER_RE = /^\s*Transfer\s*:\s*(.+?)\s*$/i;

interface Row {
  n: number;
  account: string;
  date: string;
  payee: string;
  category: YnabCategory | null;
  memo: string;
  amount: Money;
  cleared: boolean;
  split: { i: number; of: number } | null;
}

function field(r: Record<string, string>, ...names: string[]): string {
  for (const n of names) if (n in r) return r[n]!.trim();
  return "";
}

export function parseDate(s: string, fmt: DateFormat): string {
  const parts = s.trim().split(/[/.-]/);
  if (parts.length !== 3) throw new YnabCsvError(`invalid date ${JSON.stringify(s)}`);
  const [a, b, c] = parts as [string, string, string];
  const [y, m, d] = fmt === "YYYY-MM-DD" ? [a, b, c] : fmt === "MM/DD/YYYY" ? [c, a, b] : [c, b, a];
  if (!/^\d{4}$/.test(y) || !/^\d{1,2}$/.test(m) || !/^\d{1,2}$/.test(d)) throw new YnabCsvError(`invalid date ${JSON.stringify(s)}`);
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

/** Guess the date format from the data: any first field > 12 means DD/MM. */
export function detectDateFormat(dates: string[]): DateFormat {
  if (dates.some((d) => /^\d{4}-/.test(d.trim()))) return "YYYY-MM-DD";
  if (dates.some((d) => Number(d.trim().split(/[/.-]/)[0]) > 12)) return "DD/MM/YYYY";
  return "MM/DD/YYYY";
}

function amount(outflow: string, inflow: string): Money {
  const out = outflow ? M.parse(outflow) : M.ZERO;
  const inn = inflow ? M.parse(inflow) : M.ZERO;
  return M.sub(inn, out);
}

function hash(parts: string[]): string {
  return createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 24);
}

function rowCategory(r: Record<string, string>): YnabCategory | null {
  const group = field(r, "Category Group", "Master Category");
  const name = field(r, "Category", "Sub Category");
  if (!group && !name) {
    const combined = field(r, "Category Group/Category");
    if (!combined) return null;
    const i = combined.indexOf(":");
    return i < 0 ? { group: "Ungrouped", name: combined } : { group: combined.slice(0, i).trim(), name: combined.slice(i + 1).trim() };
  }
  return { group: group || "Ungrouped", name: name || group };
}

export function parseYnabRegisterCsv(text: string, opts: { dateFormat?: DateFormat } = {}): YnabDataset {
  const records = parseCsvRecords(text);
  if (records.length === 0) return { accounts: [], transactions: [] };
  const first = records[0]!;
  for (const col of ["Account", "Date", "Payee", "Outflow", "Inflow"]) {
    if (!(col in first)) throw new YnabCsvError(`not a YNAB register export: missing column ${JSON.stringify(col)}`);
  }
  const fmt = opts.dateFormat ?? detectDateFormat(records.map((r) => field(r, "Date")));

  const rows: Row[] = records.map((r, n) => {
    let memo = field(r, "Memo");
    let split: Row["split"] = null;
    const sm = SPLIT_RE.exec(memo);
    if (sm) {
      split = { i: Number(sm[1]), of: Number(sm[2]) };
      memo = memo.slice(sm[0].length).trim();
    }
    return {
      n: n + 2,
      account: field(r, "Account"),
      date: parseDate(field(r, "Date"), fmt),
      payee: field(r, "Payee"),
      category: rowCategory(r),
      memo,
      amount: amount(field(r, "Outflow"), field(r, "Inflow")),
      cleared: /^(cleared|reconciled)$/i.test(field(r, "Cleared")),
      split,
    };
  });

  // Content keys with occurrence counters.
  const seen = new Map<string, number>();
  const rowKey = (row: Row): string => {
    const base = hash([row.account, row.date, row.payee, row.category ? `${row.category.group}:${row.category.name}` : "", row.memo, String(M.toCents(row.amount)), row.split ? `${row.split.i}/${row.split.of}` : ""]);
    const k = seen.get(base) ?? 0;
    seen.set(base, k + 1);
    return k === 0 ? base : `${base}-${k}`;
  };

  const toLine = (row: Row, key: string): YnabLine => {
    const tm = TRANSFER_RE.exec(row.payee);
    return {
      key,
      amount: row.amount,
      payee: row.payee || null,
      memo: row.memo || null,
      category: tm ? null : row.category,
      transferAccountKey: tm ? tm[1]! : null,
      transferPeerKey: null,
    };
  };

  // Group rows into transactions (splits = runs of rows i/n in one account and date).
  const transactions: YnabTransaction[] = [];
  for (let i = 0; i < rows.length; ) {
    const row = rows[i]!;
    if (row.split && row.split.of > 1) {
      const group: Row[] = [row];
      while (
        group.length < row.split.of &&
        i + group.length < rows.length &&
        rows[i + group.length]!.split?.of === row.split.of &&
        rows[i + group.length]!.account === row.account &&
        rows[i + group.length]!.date === row.date
      ) {
        group.push(rows[i + group.length]!);
      }
      if (group.length !== row.split.of) throw new YnabCsvError(`incomplete split at CSV row ${row.n}`);
      const subKeys = group.map(rowKey);
      const key = hash(["split", ...subKeys]);
      const subs = group.map((g, j) => toLine(g, `${key}/${j + 1}`));
      const total = M.sum(group.map((g) => g.amount));
      transactions.push({
        key,
        amount: total,
        payee: group.find((g) => !TRANSFER_RE.test(g.payee))?.payee || row.payee || null,
        memo: null,
        category: null,
        transferAccountKey: null,
        transferPeerKey: null,
        accountKey: row.account,
        date: row.date,
        cleared: group.every((g) => g.cleared),
        subs,
      });
      i += group.length;
    } else {
      const line = toLine(row, rowKey(row));
      transactions.push({ ...line, accountKey: row.account, date: row.date, cleared: row.cleared, subs: [] });
      i++;
    }
  }

  // Pair transfer sides: same date, opposite amounts, each pointing at the other account.
  type Side = { line: YnabLine; account: string; date: string };
  const sides: Side[] = [];
  for (const t of transactions) {
    for (const l of t.subs.length ? t.subs : [t]) if (l.transferAccountKey) sides.push({ line: l, account: t.accountKey, date: t.date });
  }
  const open = new Map<string, Side[]>();
  for (const s of sides) {
    const want = `${s.line.transferAccountKey}|${s.account}|${s.date}|${M.toCents(M.neg(s.line.amount))}`;
    const queue = open.get(want);
    const match = queue?.shift();
    if (match) {
      match.line.transferPeerKey = s.line.key;
      s.line.transferPeerKey = match.line.key;
    } else {
      const mine = `${s.account}|${s.line.transferAccountKey}|${s.date}|${M.toCents(s.line.amount)}`;
      open.set(mine, [...(open.get(mine) ?? []), s]);
    }
  }

  // Accounts: every account named in a row or as a transfer target.
  // Accounts only seen as a transfer target have no rows, so their balance is unknown.
  const balances = new Map<string, Money | null>();
  for (const r of rows) balances.set(r.account, M.add(balances.get(r.account) ?? M.ZERO, r.amount));
  for (const s of sides) if (!balances.has(s.line.transferAccountKey!)) balances.set(s.line.transferAccountKey!, null);
  const accounts: YnabAccount[] = [...balances].map(([name, balance]) => ({ key: name, name, type: null, closed: false, balance }));

  return { accounts, transactions };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "Jan 2026" | "January 2026" | "2026-01" | "01/2026" -> "2026-01" */
export function parsePlanMonth(s: string): string {
  const t = s.trim();
  let m = /^(\d{4})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}`;
  m = /^([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{4})$/.exec(t);
  if (m && MONTHS.includes(m[1]!.toLowerCase())) return `${m[2]}-${String(MONTHS.indexOf(m[1]!.toLowerCase()) + 1).padStart(2, "0")}`;
  m = /^(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return `${m[2]}-${m[1]!.padStart(2, "0")}`;
  throw new YnabCsvError(`invalid plan month ${JSON.stringify(s)}`);
}

/** YNAB plan (budget) CSV export -> monthly assigned amounts per category. */
export function parseYnabPlanCsv(text: string): Array<{ month: string; group: string; name: string; amount: Money }> {
  const records = parseCsvRecords(text);
  if (records.length === 0) return [];
  const first = records[0]!;
  const assignedCol = "Assigned" in first ? "Assigned" : "Budgeted" in first ? "Budgeted" : null;
  if (!("Month" in first) || !assignedCol) throw new YnabCsvError("not a YNAB plan export: needs Month and Assigned (or Budgeted) columns");
  return records.map((r) => {
    const c = rowCategory(r) ?? { group: "Ungrouped", name: "Uncategorized" };
    return { month: parsePlanMonth(field(r, "Month")), group: c.group, name: c.name, amount: M.parse(field(r, assignedCol) || "0") };
  });
}
