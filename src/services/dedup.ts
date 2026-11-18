/**
 * Cross-source de-duplication (SPEC §13.2, agreed rule):
 *  - same source: by source_id (exact);
 *  - different source: same account, same amount, date within ±3 days;
 *    a unique closest candidate is merged, ties across different dates go to review;
 *  - precedence for the merged entry's primary id and date: simplefin > qfx > csv > ynab.
 *
 * Bank source_ids are "<account-slug>/<upstream id>", so an entry can be
 * claimed at most once per (source, account) — the two sides of a transfer can
 * each be matched by their own account's feed.
 */
import * as M from "../money";
import type { Money } from "../money";

export const DEDUP_WINDOW_DAYS = 3;

export const PRECEDENCE: Readonly<Record<string, number>> = { simplefin: 3, qfx: 2, csv: 1, ynab: 0 };
const rank = (source: string) => PRECEDENCE[source] ?? -1;

export interface SourceRef {
  source: string;
  sourceId: string;
}

export interface ExistingEntry {
  wmmaId: string;
  date: string;
  file: string;
  primary: SourceRef | null;
  alts: SourceRef[];
  postings: Array<{ account: string; amount: Money }>;
}

export interface IncomingRecord {
  source: string;
  sourceId: string;
  /** hledger account the record belongs to */
  account: string;
  date: string;
  amount: Money;
}

export type Decision =
  | { kind: "duplicate" }
  | { kind: "new" }
  | { kind: "match"; entry: ExistingEntry; update: HeaderUpdate }
  | { kind: "ambiguous"; candidates: ExistingEntry[] };

export interface HeaderUpdate {
  date?: string;
  setTags: Record<string, string>;
}

export const refKey = (r: SourceRef) => `${r.source}\u0000${r.sourceId}`;

/** alt_ids tag value: "qfx=chase/123 csv=chase/ab12" */
export function parseAltIds(v: string | undefined): SourceRef[] {
  if (!v) return [];
  return v
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf("=");
      return { source: p.slice(0, i), sourceId: p.slice(i + 1) };
    })
    .filter((r) => r.source && r.sourceId);
}

export function formatAltIds(refs: SourceRef[]): string {
  return refs.map((r) => `${r.source}=${r.sourceId}`).join(" ");
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

const accountScope = (sourceId: string) => {
  const i = sourceId.indexOf("/");
  return i < 0 ? "" : sourceId.slice(0, i);
};

function claimedBy(entry: ExistingEntry, source: string, scope: string): boolean {
  return [entry.primary, ...entry.alts].some((r) => r !== null && r.source === source && accountScope(r.sourceId) === scope);
}

export function allRefs(entries: Iterable<ExistingEntry>): Set<string> {
  const out = new Set<string>();
  for (const e of entries) for (const r of [e.primary, ...e.alts]) if (r) out.add(refKey(r));
  return out;
}

/**
 * Decide what to do with each incoming record. `existing` entries are mutated
 * as matches are planned (via applyMatch) so one entry isn't matched twice.
 */
export function planMatches(
  incoming: IncomingRecord[],
  existing: ExistingEntry[],
  known: Set<string>,
  windowDays = DEDUP_WINDOW_DAYS,
): Decision[] {
  const byAccount = new Map<string, ExistingEntry[]>();
  for (const e of existing) {
    for (const acct of new Set(e.postings.map((p) => p.account))) byAccount.set(acct, [...(byAccount.get(acct) ?? []), e]);
  }
  return incoming.map((rec) => {
    const k = refKey(rec);
    if (known.has(k)) return { kind: "duplicate" };
    known.add(k);
    const scope = accountScope(rec.sourceId);
    const cands = (byAccount.get(rec.account) ?? [])
      .filter((e) => e.postings.some((p) => p.account === rec.account && M.equals(p.amount, rec.amount)))
      .filter((e) => !claimedBy(e, rec.source, scope))
      .map((e) => ({ e, d: Math.abs(daysBetween(e.date, rec.date)) }))
      .filter((c) => c.d <= windowDays)
      .sort((a, b) => a.d - b.d);
    if (cands.length === 0) return { kind: "new" };
    const best = cands.filter((c) => c.d === cands[0]!.d);
    const sameDate = best.every((c) => c.e.date === best[0]!.e.date);
    if (best.length > 1 && !sameDate) return { kind: "ambiguous", candidates: best.map((c) => c.e) };
    const entry = best[0]!.e;
    // Folding the record in also claims the entry for this (source, account).
    return { kind: "match", entry, update: applyMatch(entry, rec) };
  });
}

/**
 * Fold `rec` into `entry` (in memory) and return the header update to write:
 * the highest-precedence id becomes primary (and its date wins); the rest go to alt_ids.
 */
export function applyMatch(entry: ExistingEntry, rec: IncomingRecord): HeaderUpdate {
  const incoming: SourceRef = { source: rec.source, sourceId: rec.sourceId };
  const current = entry.primary;
  let date: string | undefined;
  if (!current || rank(rec.source) > rank(current.source)) {
    if (current) entry.alts.push(current);
    entry.primary = incoming;
    if (entry.date !== rec.date) date = entry.date = rec.date;
  } else {
    entry.alts.push(incoming);
  }
  const setTags: Record<string, string> = { alt_ids: formatAltIds(entry.alts) };
  if (entry.primary) {
    setTags["source"] = entry.primary.source;
    setTags["source_id"] = entry.primary.sourceId;
  }
  return date ? { date, setTags } : { setTags };
}
