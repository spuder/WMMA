/**
 * Generic bank CSV import driven by a per-bank column-mapping profile.
 * Records without an id column get a content hash (+ occurrence counter).
 */
import { createHash } from "node:crypto";
import * as M from "../money";
import type { Money } from "../money";
import { parseCsv } from "./csv";
import { detectDateFormat, parseDate, type DateFormat } from "./ynab/csv";
import type { BankRecord } from "./bank";

export interface CsvProfile {
  /** Header names of the columns to read. */
  columns: {
    date: string;
    payee: string;
    memo?: string;
    /** Signed amount column... */
    amount?: string;
    /** ...or separate debit/credit columns (both positive numbers). */
    debit?: string;
    credit?: string;
    /** Bank-provided transaction id, if the export has one. */
    id?: string;
  };
  dateFormat?: DateFormat;
  /** Flip signs (e.g. card exports where purchases are positive). */
  invertAmount?: boolean;
  delimiter?: string;
  /** Lines to skip before the header row. */
  skipRows?: number;
}

export class CsvProfileError extends Error {
  override name = "CsvProfileError";
}

const DATE_FORMATS: readonly DateFormat[] = ["MM/DD/YYYY", "DD/MM/YYYY", "YYYY-MM-DD"];

/** Validate an untrusted profile object. */
export function validateProfile(v: unknown): CsvProfile {
  const fail = (m: string): never => {
    throw new CsvProfileError(m);
  };
  if (typeof v !== "object" || v === null) fail("profile must be an object");
  const p = v as Record<string, unknown>;
  const c = p.columns as Record<string, unknown> | undefined;
  if (typeof c !== "object" || c === null) fail("profile.columns is required");
  for (const k of ["date", "payee"]) if (typeof c![k] !== "string" || !c![k]) fail(`columns.${k} is required`);
  for (const k of ["memo", "amount", "debit", "credit", "id"]) if (c![k] !== undefined && typeof c![k] !== "string") fail(`columns.${k} must be a string`);
  const hasAmount = typeof c!.amount === "string";
  const hasDc = typeof c!.debit === "string" && typeof c!.credit === "string";
  if (hasAmount === hasDc) fail("set either columns.amount or both columns.debit and columns.credit");
  if (p.dateFormat !== undefined && !DATE_FORMATS.includes(p.dateFormat as DateFormat)) fail(`dateFormat must be one of ${DATE_FORMATS.join(", ")}`);
  if (p.invertAmount !== undefined && typeof p.invertAmount !== "boolean") fail("invertAmount must be a boolean");
  if (p.delimiter !== undefined && (typeof p.delimiter !== "string" || p.delimiter.length !== 1)) fail("delimiter must be one character");
  if (p.skipRows !== undefined && (!Number.isInteger(p.skipRows) || (p.skipRows as number) < 0)) fail("skipRows must be a non-negative integer");
  return p as unknown as CsvProfile;
}

function parseAmount(s: string): Money {
  const t = s.trim();
  return t === "" ? M.ZERO : M.parse(t);
}

export function parseBankCsv(text: string, profile: CsvProfile): BankRecord[] {
  const rows = parseCsv(text, profile.delimiter ?? ",").slice(profile.skipRows ?? 0);
  const [header, ...data] = rows;
  if (!header) return [];
  const idx = new Map(header.map((h, i) => [h.trim(), i]));
  const col = (name: string | undefined) => {
    if (name === undefined) return undefined;
    const i = idx.get(name);
    if (i === undefined) throw new CsvProfileError(`column ${JSON.stringify(name)} not found (have: ${[...idx.keys()].join(", ")})`);
    return i;
  };
  const c = profile.columns;
  const [iDate, iPayee, iMemo, iAmount, iDebit, iCredit, iId] = [c.date, c.payee, c.memo, c.amount, c.debit, c.credit, c.id].map(col);
  const get = (r: string[], i: number | undefined) => (i === undefined ? "" : (r[i] ?? "").trim());
  const fmt = profile.dateFormat ?? detectDateFormat(data.map((r) => get(r, iDate)));

  const seen = new Map<string, number>();
  return data
    .filter((r) => r.some((f) => f.trim() !== ""))
    .map((r, n) => {
      let amount: Money;
      try {
        amount = iAmount !== undefined ? parseAmount(get(r, iAmount)) : M.sub(parseAmount(get(r, iCredit)), M.abs(parseAmount(get(r, iDebit))));
      } catch (e) {
        throw new CsvProfileError(`row ${n + 2}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (profile.invertAmount) amount = M.neg(amount);
      const date = parseDate(get(r, iDate), fmt);
      const payee = get(r, iPayee);
      const memo = get(r, iMemo) || null;
      let externalId = get(r, iId);
      if (!externalId) {
        const base = createHash("sha256").update([date, M.toCents(amount), payee, memo ?? ""].join("\u001f")).digest("hex").slice(0, 24);
        const k = seen.get(base) ?? 0;
        seen.set(base, k + 1);
        externalId = k === 0 ? base : `${base}-${k}`;
      }
      return { externalId, date, amount, payee: payee || memo || "Unknown", memo: payee ? memo : null };
    });
}
