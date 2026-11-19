/**
 * Merchant and bank logos.
 *
 * A payee resolves to a website domain (manual/agent override, then the built-in
 * hints, then a "name com" payee) or, failing that, to a glyph for money movements
 * (transfers, deposits, payroll...). The server fetches each domain's icon once and
 * caches it in SQLite; the browser only ever loads /api/v1/logos/img/<domain>.
 */
import { nowIso } from "../db";
import { findLogo } from "../logos/fetch";
import { GLYPH_RULES, GLYPHS, MERCHANT_DOMAINS, type Glyph } from "../logos/seed";
import type { AccountRow } from "./accounts";
import { payeeKey } from "./categorize";
import { ServiceError, type ServiceContext } from "./context";

export type Logo = { domain: string } | { glyph: Glyph } | null;
/**
 * A logo plus what the cache knows about it, for the browser: `v` versions the image URL and
 * `missing` means the site has no usable icon (show initials, keep the website).
 */
export type LogoWithStatus = { domain: string; v?: string; missing?: true } | { glyph: Glyph } | null;

/**
 * Logos are kept indefinitely. A site that had no logo is only asked again when someone
 * opens one of its transactions (retryLogo), and at most this often.
 */
const RETRY_COOLDOWN = 10 * 60_000;
/** Settings key (UI-writable) that turns off all outbound logo fetches when "off". */
export const FETCH_SETTING = "ui.logos_fetch";

// ---- resolution ------------------------------------------------------------

const PATTERNS = Object.entries(MERCHANT_DOMAINS)
  .sort(([a], [b]) => b.replace(/[$^]/g, "").length - a.replace(/[$^]/g, "").length)
  .map(([p, domain]) => {
    const core = p.replace(/^\^|\$$/g, "").replace(/[.*+?()[\]{}|\\]/g, "\\$&");
    return { re: new RegExp(`${p.startsWith("^") ? "^" : "(?:^| )"}${core}${p.endsWith("$") ? "$" : "(?= |$)"}`), domain };
  });

/** The built-in domain for a payee key (or any text normalised with payeeKey). */
export function seedDomain(key: string): string | null {
  return PATTERNS.find((p) => p.re.test(key))?.domain ?? null;
}

/** "acme com" / "maplestreetbakery com springfield il" -> the .com the payee names itself. */
export function domainInKey(key: string): string | null {
  const m = /(?:^| )([a-z][a-z-]{1,62}) com(?= |$)/.exec(key);
  return m && m[1] !== "www" ? `${m[1]}.com` : null;
}

export function glyphFor(text: string): Glyph | null {
  return GLYPH_RULES.find(([re]) => re.test(text))?.[1] ?? null;
}

/** "https://www.Example.com/x" -> "example.com"; null if it isn't a public-looking hostname. */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    try {
      s = new URL(s).hostname;
    } catch {
      return null;
    }
  }
  s = s.split(/[/?#:]/)[0]!.replace(/\.$/, "").replace(/^www\./, "");
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(s)) return null;
  return s;
}

interface OverrideRow {
  payee_key: string;
  domain: string | null;
  glyph: Glyph | null;
  source: "manual" | "agent";
  updated_at: string;
}

function overrides(ctx: ServiceContext): Map<string, OverrideRow> {
  const rows = ctx.db.query("SELECT * FROM payee_logos").all() as OverrideRow[];
  return new Map(rows.map((r) => [r.payee_key, r]));
}

/** Resolve one payee. `note` is the bank's raw description, used when the payee alone says nothing. */
export function resolvePayee(key: string, note: string | null, override?: OverrideRow): Logo {
  if (override) return override.domain ? { domain: override.domain } : override.glyph ? { glyph: override.glyph } : null;
  const noteKey = note ? payeeKey(note) : "";
  const domain = seedDomain(key) ?? domainInKey(key) ?? (noteKey ? seedDomain(noteKey) : null);
  if (domain) return { domain };
  const glyph = glyphFor(key) ?? (noteKey ? glyphFor(noteKey) : null);
  return glyph ? { glyph } : null;
}

const KIND_GLYPH: Partial<Record<AccountRow["kind"], Glyph>> = { vehicle: "car", real_estate: "home", other_asset: "asset" };

export function accountLogo(a: Pick<AccountRow, "name" | "kind" | "logo_domain">): Logo {
  if (a.logo_domain) return { domain: a.logo_domain };
  const domain = seedDomain(payeeKey(a.name));
  if (domain) return { domain };
  const glyph = KIND_GLYPH[a.kind];
  return glyph ? { glyph } : null;
}

// ---- payees ----------------------------------------------------------------

interface PayeeStat {
  key: string;
  payee: string;
  count: number;
  note: string | null;
}

async function payeeStats(ctx: ServiceContext): Promise<PayeeStat[]> {
  const byKey = new Map<string, PayeeStat>();
  for (const t of await ctx.hledger.transactions()) {
    const [payee = "", ...rest] = t.tdescription.split(" | ");
    const key = payeeKey(payee);
    if (!key) continue;
    const note = rest.join(" | ").trim() || null;
    const s = byKey.get(key);
    if (s) {
      s.count++;
      s.note ??= note;
    } else byKey.set(key, { key, payee: payee.trim(), count: 1, note });
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** Every payee in the journal -> its logo, keyed by payeeKey. */
export async function payeeLogos(ctx: ServiceContext): Promise<Record<string, Logo>> {
  const o = overrides(ctx);
  return Object.fromEntries((await payeeStats(ctx)).map((s) => [s.key, resolvePayee(s.key, s.note, o.get(s.key))]));
}

/** Adds cache state to logos, so the browser never asks for an image known not to exist. */
export function logoStatus(ctx: ServiceContext): (logo: Logo) => LogoWithStatus {
  const rows = ctx.db.query("SELECT domain, status, version FROM logo_cache").all() as Array<Pick<CacheRow, "domain" | "status" | "version">>;
  const cache = new Map(rows.map((r) => [r.domain, r]));
  return (logo) => {
    if (!logo || !("domain" in logo)) return logo;
    const r = cache.get(logo.domain);
    if (!r) return { domain: logo.domain };
    if (r.status === "missing") return { domain: logo.domain, missing: true };
    return r.version ? { domain: logo.domain, v: r.version } : { domain: logo.domain };
  };
}

/** The payee map the UI loads: every payee's logo with its cache state. */
export async function payeeLogosWithStatus(ctx: ServiceContext): Promise<Record<string, LogoWithStatus>> {
  const status = logoStatus(ctx);
  return Object.fromEntries(Object.entries(await payeeLogos(ctx)).map(([k, l]) => [k, status(l)]));
}

type Status = "logo" | "glyph" | "pending" | "not_found" | "none";

export interface LogoCoverage {
  transactions: { total: number; covered: number };
  payees: { total: number; covered: number };
  /** Payees still showing initials, most frequent first. */
  missing: Array<{ key: string; payee: string; count: number; domain: string | null; status: Status; note: string | null }>;
  fetchEnabled: boolean;
}

export async function logoCoverage(ctx: ServiceContext, limit = 50): Promise<LogoCoverage> {
  const o = overrides(ctx);
  const cache = new Map((ctx.db.query("SELECT domain, status FROM logo_cache").all() as Array<{ domain: string; status: string }>).map((r) => [r.domain, r.status]));
  const out: LogoCoverage = { transactions: { total: 0, covered: 0 }, payees: { total: 0, covered: 0 }, missing: [], fetchEnabled: fetchEnabled(ctx) };
  for (const s of await payeeStats(ctx)) {
    const logo = resolvePayee(s.key, s.note, o.get(s.key));
    const status: Status = !logo ? "none" : "glyph" in logo ? "glyph" : cache.get(logo.domain) === "ok" ? "logo" : cache.has(logo.domain) ? "not_found" : "pending";
    const covered = status === "logo" || status === "glyph";
    out.transactions.total += s.count;
    out.payees.total++;
    if (covered) {
      out.transactions.covered += s.count;
      out.payees.covered++;
    } else if (out.missing.length < limit) {
      out.missing.push({ key: s.key, payee: s.payee, count: s.count, domain: logo && "domain" in logo ? logo.domain : null, status, note: s.note });
    }
  }
  return out;
}

export async function setPayeeLogo(
  ctx: ServiceContext,
  actor: string,
  payee: string,
  input: { domain?: string | null; glyph?: string | null; reset?: boolean },
  source: "manual" | "agent" = "manual",
): Promise<{ key: string; logo: Logo }> {
  const key = payeeKey(payee);
  if (!key) throw new ServiceError("payee is required");
  const before = ctx.db.query("SELECT * FROM payee_logos WHERE payee_key = ?").get(key) as OverrideRow | null;
  if (input.reset) {
    ctx.db.query("DELETE FROM payee_logos WHERE payee_key = ?").run(key);
  } else {
    if (input.domain && input.glyph) throw new ServiceError("give a domain or a glyph, not both");
    const domain = input.domain ? normalizeDomain(input.domain) : null;
    if (input.domain && !domain) throw new ServiceError(`${JSON.stringify(input.domain)} is not a website domain`);
    if (input.glyph && !GLYPHS.includes(input.glyph as Glyph)) throw new ServiceError(`glyph must be one of ${GLYPHS.join(", ")}`);
    ctx.db
      .query("INSERT OR REPLACE INTO payee_logos (payee_key, domain, glyph, source, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(key, domain, input.glyph ?? null, source, nowIso());
    if (domain) void logoImage(ctx, domain).catch(() => {});
  }
  const after = ctx.db.query("SELECT * FROM payee_logos WHERE payee_key = ?").get(key) as OverrideRow | null;
  await ctx.audit.append({ actor, operation: "logo.payee.set", inputs: { payee, ...input, source }, before, after });
  return { key, logo: after ? resolvePayee(key, null, after) : (await payeeLogos(ctx))[key] ?? resolvePayee(key, null) };
}

// ---- images ----------------------------------------------------------------

export function fetchEnabled(ctx: ServiceContext): boolean {
  const row = ctx.db.query("SELECT value FROM settings WHERE key = ?").get(FETCH_SETTING) as { value: string } | null;
  return row?.value !== "off";
}

interface CacheRow {
  domain: string;
  status: "ok" | "missing";
  content_type: string | null;
  bytes: Uint8Array | null;
  origin: string | null;
  fetched_at: string;
  version: string | null;
}

const inflight = new Map<string, Promise<CacheRow | null>>();

/** At most this many sites are being fetched at once, however many images the browser asks for. */
const MAX_FETCHES = 4;
let activeFetches = 0;
const waiting: Array<() => void> = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (activeFetches >= MAX_FETCHES) await new Promise<void>((resolve) => waiting.push(resolve));
  else activeFetches++;
  try {
    return await fn();
  } finally {
    // Hand the slot straight to the next waiter so nobody can jump the queue in between.
    const next = waiting.shift();
    if (next) next();
    else activeFetches--;
  }
}

const versionOf = (bytes: Uint8Array) => Bun.hash(bytes).toString(36);


const getRow = (ctx: ServiceContext, domain: string) => ctx.db.query("SELECT * FROM logo_cache WHERE domain = ?").get(domain) as CacheRow | null;

async function refresh(ctx: ServiceContext, domain: string, previous: CacheRow | null): Promise<CacheRow | null> {
  let found;
  try {
    found = await limited(() => findLogo(domain, ctx.logoFetcher));
  } catch {
    return previous;
  }
  if (found) {
    ctx.db
      .query("INSERT OR REPLACE INTO logo_cache (domain, status, content_type, bytes, origin, fetched_at, version) VALUES (?, 'ok', ?, ?, ?, ?, ?)")
      .run(domain, found.contentType, found.bytes, found.origin, nowIso(), versionOf(found.bytes));
  } else if (previous?.status === "ok") {
    // A failed refresh keeps serving the logo we already had.
    ctx.db.query("UPDATE logo_cache SET fetched_at = ? WHERE domain = ?").run(nowIso(), domain);
  } else {
    ctx.db.query("INSERT OR REPLACE INTO logo_cache (domain, status, fetched_at) VALUES (?, 'missing', ?)").run(domain, nowIso());
  }
  return getRow(ctx, domain);
}

/** The cached logo for a domain, fetching it the first time it's needed (or on `force`). */
export async function logoImage(ctx: ServiceContext, domainInput: string, opts: { force?: boolean } = {}): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string } | null> {
  const domain = normalizeDomain(domainInput);
  if (!domain) throw new ServiceError("invalid domain");
  const row = getRow(ctx, domain);
  let result = row;
  if ((!row || opts.force) && fetchEnabled(ctx)) {
    let p = inflight.get(domain);
    if (!p) {
      p = refresh(ctx, domain, row).finally(() => inflight.delete(domain));
      inflight.set(domain, p);
    }
    result = await p;
  }
  return result?.status === "ok" && result.bytes ? { bytes: new Uint8Array(result.bytes), contentType: result.content_type ?? "application/octet-stream" } : null;
}

/**
 * Look again for a site that had no logo; called when someone opens one of its transactions.
 * A logo already found is left alone, and the same site is asked at most every 10 minutes.
 */
export async function retryLogo(ctx: ServiceContext, domainInput: string): Promise<{ domain: string; found: boolean; retried: boolean }> {
  const domain = normalizeDomain(domainInput);
  if (!domain) throw new ServiceError("invalid domain");
  const row = getRow(ctx, domain);
  if (row?.status === "ok") return { domain, found: true, retried: false };
  if (!fetchEnabled(ctx) || (row && Date.now() - Date.parse(row.fetched_at) < RETRY_COOLDOWN)) return { domain, found: false, retried: false };
  return { domain, found: (await logoImage(ctx, domain, { force: true })) !== null, retried: true };
}

/** Fetch logos for every payee and account domain that hasn't been looked up yet. */
export async function prefetchLogos(ctx: ServiceContext, opts: { concurrency?: number; force?: boolean } = {}): Promise<{ domains: number; fetched: number; found: number }> {
  if (!fetchEnabled(ctx)) throw new ServiceError("Logo fetching is turned off in Settings", 409);
  const domains = new Set<string>();
  for (const logo of Object.values(await payeeLogos(ctx))) if (logo && "domain" in logo) domains.add(logo.domain);
  for (const a of ctx.db.query("SELECT name, kind, logo_domain FROM accounts").all() as AccountRow[]) {
    const logo = accountLogo(a);
    if (logo && "domain" in logo) domains.add(logo.domain);
  }
  const cached = new Map((ctx.db.query("SELECT domain, status, fetched_at FROM logo_cache").all() as CacheRow[]).map((r) => [r.domain, r]));
  const todo = [...domains].filter((d) => {
    return opts.force || !cached.has(d);
  });
  let found = 0;
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const d = todo[next++]!;
      if (await logoImage(ctx, d, { force: opts.force ?? false }).catch(() => null)) found++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 6, todo.length) }, worker));
  return { domains: domains.size, fetched: todo.length, found };
}
