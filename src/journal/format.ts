/**
 * Pure formatting of hledger journal text. Validation is strict: callers
 * (importers) must sanitise upstream text with `cleanText` before building
 * transactions, so the writer never emits a journal hledger would misread.
 */
import * as M from "../money";
import type { Money } from "../money";

export type Tags = Readonly<Record<string, string>>;

export interface Posting {
  readonly account: string;
  readonly amount: Money;
  /** Posting-level tags, e.g. `entity` for inter-entity transfers (SPEC §13.1). */
  readonly tags?: Tags;
}

export interface Transaction {
  /** YYYY-MM-DD */
  readonly date: string;
  readonly payee: string;
  readonly note?: string;
  /** "" unmarked, "!" pending, "*" cleared */
  readonly status?: "" | "!" | "*";
  readonly tags: Tags;
  readonly postings: readonly Posting[];
}

export class JournalFormatError extends Error {
  override name = "JournalFormatError";
}

/** Known WMMA tags are written first, in this order; others follow alphabetically. */
export const TAG_ORDER = ["type", "wmma_id", "source", "source_id", "entity", "orig_category", "cat_by", "jev_conf"] as const;

const TAG_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function fail(msg: string): never {
  throw new JournalFormatError(msg);
}

/**
 * Make upstream free text safe for a payee, note, or tag value:
 * collapses whitespace and replaces characters with journal meaning.
 */
export function cleanText(s: string): string {
  return s
    .replace(/[;|,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function validateDate(date: string): void {
  const m = DATE_RE.exec(date);
  if (!m) fail(`invalid date ${JSON.stringify(date)} (want YYYY-MM-DD)`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    fail(`invalid calendar date ${JSON.stringify(date)}`);
  }
}

export function validateAccount(name: string): void {
  const bad =
    name.length === 0 ||
    name !== name.trim() ||
    /[\t\r\n;]/.test(name) ||
    / {2}/.test(name) ||
    /^[([]/.test(name) ||
    /[)\]]$/.test(name) ||
    name.split(":").some((seg) => seg.trim().length === 0);
  if (bad) fail(`invalid account name ${JSON.stringify(name)}`);
}

function validateFreeText(what: string, s: string, allowEmpty: boolean): void {
  if (!allowEmpty && s.length === 0) fail(`${what} must not be empty`);
  if (s !== s.trim() || /[\r\n\t;|]/.test(s)) fail(`invalid ${what} ${JSON.stringify(s)}`);
}

export function validateTags(tags: Tags): void {
  for (const [k, v] of Object.entries(tags)) {
    if (!TAG_NAME_RE.test(k)) fail(`invalid tag name ${JSON.stringify(k)}`);
    if (v !== v.trim() || /[\r\n,]/.test(v)) fail(`invalid value for tag ${k}: ${JSON.stringify(v)}`);
  }
}

export function validateTransaction(t: Transaction): void {
  validateDate(t.date);
  validateFreeText("payee", t.payee, false);
  if (t.note !== undefined) validateFreeText("note", t.note, true);
  validateTags(t.tags);
  if (t.postings.length < 2) fail("a transaction needs at least two postings");
  for (const p of t.postings) {
    validateAccount(p.account);
    M.cents(p.amount); // asserts integer cents
    if (p.tags) validateTags(p.tags);
  }
  const total = M.sum(t.postings.map((p) => p.amount));
  if (!M.isZero(total)) fail(`transaction does not balance (off by ${M.format(total)})`);
}

function orderedTagEntries(tags: Tags): Array<[string, string]> {
  const known = new Set<string>(TAG_ORDER);
  const out: Array<[string, string]> = [];
  for (const k of TAG_ORDER) if (k in tags) out.push([k, tags[k]!]);
  const rest = Object.keys(tags)
    .filter((k) => !known.has(k))
    .sort();
  for (const k of rest) out.push([k, tags[k]!]);
  return out;
}

/** Parse a tag comment as WMMA writes it ("k:v, k2:v2"). */
export function parseTagComment(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(",")) {
    const i = part.indexOf(":");
    if (i < 1) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function formatTags(tags: Tags): string {
  return orderedTagEntries(tags)
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");
}

/** Render one transaction as journal text (ends with a newline). */
export function formatTransaction(t: Transaction): string {
  validateTransaction(t);
  const status = t.status ? `${t.status} ` : "";
  const desc = t.note !== undefined && t.note !== "" ? `${t.payee} | ${t.note}` : t.payee;
  const header = `${t.date} ${status}${desc}`;
  const tagStr = formatTags(t.tags);
  const lines = [tagStr ? `${header}  ; ${tagStr}` : header];

  const width = Math.max(...t.postings.map((p) => p.account.length));
  const amounts = t.postings.map((p) => M.toJournal(p.amount));
  const amtWidth = Math.max(...amounts.map((a) => a.length));
  t.postings.forEach((p, i) => {
    let line = `    ${p.account.padEnd(width)}  ${amounts[i]!.padStart(amtWidth)}`;
    const pt = p.tags ? formatTags(p.tags) : "";
    if (pt) line += `  ; ${pt}`;
    lines.push(line);
  });
  return lines.join("\n") + "\n";
}

/** hledger account types (A L E R X C V). */
export type AccountType = "A" | "L" | "E" | "R" | "X" | "C" | "V";

export function formatAccountDirective(name: string, opts: { type?: AccountType; tags?: Tags } = {}): string {
  validateAccount(name);
  const tags: Record<string, string> = {};
  if (opts.type) tags["type"] = opts.type;
  Object.assign(tags, opts.tags ?? {});
  validateTags(tags);
  const t = formatTags(tags);
  return t ? `account ${name}  ; ${t}\n` : `account ${name}\n`;
}
