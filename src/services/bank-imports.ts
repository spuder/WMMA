/**
 * Single-account bank imports (QFX/OFX, generic CSV, SimpleFIN) with
 * same-source and cross-source de-duplication (see dedup.ts).
 */
import { nowIso, type AccountKind } from "../db";
import { cleanText, formatTransaction, type Transaction } from "../journal/format";
import type { HledgerTransaction } from "../hledger/web";
import * as M from "../money";
import type { Money } from "../money";
import { accountType, UNCATEGORIZED_EXPENSE, UNCATEGORIZED_INCOME } from "../naming";
import { ulid } from "../ulid";
import { safeId, type BankAccountData, type BankRecord } from "../importers/bank";
import { parseBankCsv, validateProfile, CsvProfileError, type CsvProfile } from "../importers/bankcsv";
import { OfxError, parseOfx } from "../importers/ofx";
import { defaultReiHubAccount, parseReiHubCsv, type ReiHubColumns, type ReiHubRecord } from "../importers/reihub/csv";
import type { DateFormat } from "../importers/ynab/csv";
import { addEntity } from "./entities";
import { fetchAccounts, normaliseSimplefin, simplefinErrors } from "../importers/simplefin";
import {
  balancesFrom,
  createAccount,
  ensureEntity,
  findAccountBySource,
  getAccount,
  getEntity,
  linkAccountSource,
  type AccountRow,
} from "./accounts";
import { ServiceError, type ServiceContext } from "./context";
import { allRefs, applyMatch, parseAltIds, planMatches, refKey, type ExistingEntry, type IncomingRecord } from "./dedup";
import { runCategorization, serial, storeRaw } from "./imports";
import type { CategorizeSummary } from "./categorize";

export type BankSource = "qfx" | "csv" | "simplefin" | "reihub";

export interface BankAccountAssignment {
  /** Link to this existing WMMA account instead of creating one. */
  slug?: string;
  kind?: AccountKind;
  entity?: string;
  name?: string;
}

export interface BankImportOptions {
  defaultEntity?: string;
  /** Assignments keyed by upstream account key or name. */
  accounts?: Record<string, BankAccountAssignment>;
}

export interface BankImportResult {
  runId: string;
  source: BankSource;
  file: string | null;
  added: number;
  merged: number;
  skippedDuplicates: number;
  needsReview: number;
  createdAccounts: Array<{ slug: string; name: string; hledgerAccount: string; kind: AccountKind; entity: string; kindGuessed: boolean }>;
  balances: Array<{ account: string; asOf: string; source: string; wmma: string; match: boolean }>;
  errors: string[];
  categorization: CategorizeSummary | { error: string };
}

interface ResolvedBank {
  data: BankAccountData;
  account: AccountRow;
}

/** Existing journal entries, as dedup sees them. */
export function existingEntries(txns: HledgerTransaction[]): ExistingEntry[] {
  return txns.flatMap((t) => {
    const tags = new Map(t.ttags);
    const wmmaId = tags.get("wmma_id");
    if (!wmmaId) return [];
    const source = tags.get("source");
    const sourceId = tags.get("source_id");
    return [
      {
        wmmaId,
        date: t.tdate,
        file: t.tsourcepos[0]?.sourceName ?? "",
        primary: source && sourceId ? { source, sourceId } : null,
        alts: parseAltIds(tags.get("alt_ids")),
        postings: t.tpostings.flatMap((p) =>
          p.pamount.filter((a) => a.acommodity === "$").map((a) => ({ account: p.paccount, amount: M.fromHledgerQuantity(a.aquantity) })),
        ),
      },
    ];
  });
}

function resolveBankAccounts(
  ctx: ServiceContext,
  source: BankSource,
  datas: BankAccountData[],
  opts: BankImportOptions,
  created: BankImportResult["createdAccounts"],
): ResolvedBank[] {
  const sourceKey = source === "qfx" ? "ofx" : source;
  return ctx.db.transaction(() =>
    datas.map((data) => {
      let account =
        findAccountBySource(ctx, sourceKey, data.externalKey) ??
        (source === "simplefin" ? (ctx.db.query("SELECT * FROM accounts WHERE simplefin_id = ?").get(data.externalKey) as AccountRow | null) : null);
      const assign = opts.accounts?.[data.externalKey] ?? opts.accounts?.[data.name] ?? {};
      if (!account && assign.slug) {
        account = getAccount(ctx, assign.slug);
        if (!account) throw new ServiceError(`unknown account ${JSON.stringify(assign.slug)}`, 404);
      }
      if (!account) {
        const entity = assign.entity ?? opts.defaultEntity ?? "personal";
        ensureEntity(ctx, entity);
        const kind = assign.kind ?? data.kindHint ?? "bank";
        account = createAccount(ctx, { name: assign.name ?? data.name, kind, entity });
        created.push({ slug: account.slug, name: account.name, hledgerAccount: account.hledger_account, kind, entity, kindGuessed: !assign.kind && !data.kindHint });
      }
      linkAccountSource(ctx, sourceKey, data.externalKey, account.slug);
      if (source === "simplefin" && !account.simplefin_id) {
        ctx.db.query("UPDATE accounts SET simplefin_id = ? WHERE slug = ?").run(data.externalKey, account.slug);
      }
      return { data, account };
    }),
  )();
}

function toTransaction(rec: BankRecord, account: AccountRow, source: BankSource, sourceId: string): Transaction {
  const payee = cleanText(rec.payee) || "(no payee)";
  const note = cleanText(rec.memo ?? "");
  return {
    date: rec.date,
    payee,
    ...(note && note !== payee ? { note } : {}),
    status: "*",
    tags: {
      wmma_id: ulid(),
      source,
      source_id: sourceId,
      entity: rec.entity ?? account.default_entity,
      ...(rec.origCategory ? { orig_category: cleanText(rec.origCategory) } : {}),
      ...(rec.category ? { cat_by: "mapping" } : {}),
      ...(rec.tags ?? {}),
    },
    postings: [
      { account: account.hledger_account, amount: rec.amount },
      { account: rec.category ?? (M.isNegative(rec.amount) ? UNCATEGORIZED_EXPENSE : UNCATEGORIZED_INCOME), amount: M.neg(rec.amount) },
    ],
  };
}

export async function ingest(
  ctx: ServiceContext,
  actor: string,
  p: { source: BankSource; file: string | null; datas: BankAccountData[]; options: BankImportOptions; inputs: unknown; upstreamErrors?: string[] },
): Promise<BankImportResult> {
  const runId = ulid();
  ctx.db.query("INSERT INTO import_runs (id, source, file, actor, started) VALUES (?, ?, ?, ?, ?)").run(runId, p.source, p.file, actor, nowIso());
  const errors = [...(p.upstreamErrors ?? [])];
  try {
    const createdAccounts: BankImportResult["createdAccounts"] = [];
    const resolved = resolveBankAccounts(ctx, p.source, p.datas, p.options, createdAccounts);

    const entries = existingEntries(await ctx.hledger.transactions());
    const known = allRefs(entries);
    for (const r of ctx.db.query("SELECT source, source_id FROM duplicate_candidates").all() as Array<{ source: string; source_id: string }>) {
      known.add(refKey({ source: r.source, sourceId: r.source_id }));
    }

    const incoming: IncomingRecord[] = [];
    const meta: Array<{ rec: BankRecord; account: AccountRow }> = [];
    for (const { data, account } of resolved) {
      for (const rec of data.records) {
        incoming.push({
          source: p.source,
          sourceId: `${account.slug}/${safeId(rec.externalId)}`,
          account: account.hledger_account,
          date: rec.date,
          amount: rec.amount,
        });
        meta.push({ rec, account });
      }
    }
    const decisions = planMatches(incoming, entries, known);

    const fresh: Array<{ slug: string; txn: Transaction; sourceId: string }> = [];
    const merges: Array<{ entry: ExistingEntry; update: { date?: string; setTags: Record<string, string>; replaceAccount?: { from: string; to: string } }; sourceId: string }> = [];
    const review: Array<{ sourceId: string; account: AccountRow; rec: BankRecord; candidates: string[] }> = [];
    let skippedDuplicates = 0;
    decisions.forEach((d, n) => {
      const inc = { ...incoming[n]!, ...meta[n]! };
      const account = inc.account;
      if (d.kind === "duplicate") skippedDuplicates++;
      else if (d.kind === "new") fresh.push({ slug: account.slug, txn: toTransaction(inc.rec, account, p.source, inc.sourceId), sourceId: inc.sourceId });
      else if (d.kind === "match") {
        // A categorised record (REI Hub) also categorises an uncategorised match.
        const uncat = inc.rec.category ? d.entry.postings.find((x) => x.account === UNCATEGORIZED_EXPENSE || x.account === UNCATEGORIZED_INCOME) : undefined;
        const update = uncat
          ? {
              ...d.update,
              setTags: {
                ...d.update.setTags,
                cat_by: "mapping",
                ...(inc.rec.origCategory ? { orig_category: cleanText(inc.rec.origCategory) } : {}),
                ...(inc.rec.entity ? { entity: inc.rec.entity } : {}),
                ...(inc.rec.tags ?? {}),
              },
              replaceAccount: { from: uncat.account, to: inc.rec.category! },
            }
          : d.update;
        if (uncat) uncat.account = inc.rec.category!;
        merges.push({ entry: d.entry, update, sourceId: inc.sourceId });
      }
      else review.push({ sourceId: inc.sourceId, account, rec: inc.rec, candidates: d.candidates.map((c) => c.wmmaId) });
    });

    for (const f of fresh) formatTransaction(f.txn); // validate before writing anything

    const used = new Set<string>(resolved.map((r) => r.account.hledger_account));
    for (const f of fresh) for (const pst of f.txn.postings) used.add(pst.account);
    for (const m of merges) if (m.update.replaceAccount) used.add(m.update.replaceAccount.to);
    await ctx.store.declareAccounts([...used].sort().map((name) => ({ name, type: accountType(name) })));

    const bySlug = new Map<string, Transaction[]>();
    for (const f of fresh) bySlug.set(f.slug, [...(bySlug.get(f.slug) ?? []), f.txn]);
    for (const [slug, list] of bySlug) await ctx.store.appendTransactions(slug, list);
    for (const m of merges) await ctx.store.updateTransaction(m.entry.file, m.entry.wmmaId, m.update);

    const insertReview = ctx.db.query(
      "INSERT OR IGNORE INTO duplicate_candidates (id, run_id, source, source_id, account_slug, record, candidates, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const upsertSnapshot = ctx.db.query("INSERT OR REPLACE INTO balance_snapshots (account_slug, as_of, source, balance_cents) VALUES (?, ?, ?, ?)");
    ctx.db.transaction(() => {
      for (const r of review) {
        insertReview.run(ulid(), runId, p.source, r.sourceId, r.account.slug, JSON.stringify({ ...r.rec, amount: M.toCents(r.rec.amount) }), JSON.stringify(r.candidates), nowIso());
      }
      for (const { data, account } of resolved) {
        if (data.balance) upsertSnapshot.run(account.slug, data.balance.asOf, p.source, M.toCents(data.balance.amount));
      }
    })();

    // Balance check (informational: a partial history won't match).
    const wmma = balancesFrom(await ctx.hledger.transactions());
    const balances = resolved
      .filter((r) => r.data.balance)
      .map(({ data, account }) => {
        const w: Money = wmma.get(account.hledger_account) ?? M.ZERO;
        return { account: account.name, asOf: data.balance!.asOf, source: M.format(data.balance!.amount), wmma: M.format(w), match: M.equals(w, data.balance!.amount) };
      });

    ctx.db
      .query("UPDATE import_runs SET finished = ?, added = ?, skipped_duplicates = ?, errors = ? WHERE id = ?")
      .run(nowIso(), fresh.length, skippedDuplicates + merges.length, JSON.stringify(errors), runId);

    await ctx.audit.append({
      actor,
      operation: `import.${p.source}`,
      inputs: p.inputs,
      before: merges.length ? { merged: merges.map((m) => ({ wmma_id: m.entry.wmmaId })) } : null,
      after: {
        runId,
        added: fresh.map((f) => ({ wmma_id: f.txn.tags["wmma_id"], source_id: f.sourceId, account: f.slug })),
        merged: merges.map((m) => ({ wmma_id: m.entry.wmmaId, source_id: m.sourceId, update: m.update })),
        needsReview: review.map((r) => ({ source_id: r.sourceId, candidates: r.candidates })),
        skippedDuplicates,
        createdAccounts,
      },
    });

    return {
      runId,
      source: p.source,
      file: p.file,
      added: fresh.length,
      merged: merges.length,
      skippedDuplicates,
      needsReview: review.length,
      createdAccounts,
      balances,
      errors,
      categorization: await runCategorization(ctx, actor, fresh.map((f) => String(f.txn.tags["wmma_id"]))),
    };
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
    ctx.db.query("UPDATE import_runs SET finished = ?, errors = ? WHERE id = ?").run(nowIso(), JSON.stringify(errors), runId);
    await ctx.audit.append({ actor, operation: `import.${p.source}`, inputs: p.inputs, before: null, after: { runId, error: String(e) } });
    throw e;
  }
}

export function importQfx(ctx: ServiceContext, actor: string, input: { filename: string; content: string } & BankImportOptions & { account?: string }): Promise<BankImportResult> {
  return serial(async () => {
    let datas: BankAccountData[];
    try {
      datas = parseOfx(input.content);
    } catch (e) {
      throw new ServiceError(`could not parse QFX/OFX: ${e instanceof Error ? e.message : String(e)}`, 422);
    }
    // --account SLUG applies to a single-statement file.
    const accounts = { ...(input.accounts ?? {}) };
    if (input.account) {
      if (datas.length !== 1) throw new ServiceError("account applies only to files with one statement; use accounts{} instead");
      accounts[datas[0]!.externalKey] = { ...accounts[datas[0]!.externalKey], slug: input.account };
    }
    const file = await storeRaw(ctx, "qfx", input.filename, input.content);
    return ingest(ctx, actor, {
      source: "qfx",
      file,
      datas,
      options: { ...input, accounts },
      inputs: { filename: input.filename, account: input.account, accounts: input.accounts, defaultEntity: input.defaultEntity, file },
    });
  });
}

export function importBankCsv(
  ctx: ServiceContext,
  actor: string,
  input: { filename: string; content: string; profile: string; account: string },
): Promise<BankImportResult> {
  return serial(async () => {
    const profile = getCsvProfile(ctx, input.profile);
    if (!profile) throw new ServiceError(`unknown CSV profile ${JSON.stringify(input.profile)}`, 404);
    const account = getAccount(ctx, input.account);
    if (!account) throw new ServiceError(`unknown account ${JSON.stringify(input.account)}`, 404);
    let records: BankRecord[];
    try {
      records = parseBankCsv(input.content, profile);
    } catch (e) {
      throw new ServiceError(`could not parse CSV: ${e instanceof Error ? e.message : String(e)}`, 422);
    }
    const file = await storeRaw(ctx, "csv", input.filename, input.content);
    const data: BankAccountData = { externalKey: `account:${account.slug}`, name: account.name, kindHint: null, balance: null, records };
    return ingest(ctx, actor, {
      source: "csv",
      file,
      datas: [data],
      options: { accounts: { [data.externalKey]: { slug: account.slug } } },
      inputs: { filename: input.filename, profile: input.profile, account: input.account, file },
    });
  });
}

const SIMPLEFIN_LAST_SYNC = "simplefin.last_sync";

export function syncSimplefin(
  ctx: ServiceContext,
  actor: string,
  opts: BankImportOptions & { startDate?: string; fetch?: typeof fetch } = {},
): Promise<BankImportResult> {
  return serial(async () => {
    const url = (await ctx.secrets?.get("simplefin_access_url")) ?? null;
    if (!url) throw new ServiceError("Connect SimpleFIN in Settings before syncing", 422);
    const last = (ctx.db.query("SELECT value FROM settings WHERE key = ?").get(SIMPLEFIN_LAST_SYNC) as { value: string } | null)?.value;
    // Overlap the previous sync by 14 days to catch late-posting transactions; first sync: 90 days.
    const start = opts.startDate
      ? new Date(`${opts.startDate}T00:00:00Z`)
      : new Date((last ? Date.parse(last) : Date.now() - 76 * 86_400_000) - 14 * 86_400_000);
    if (Number.isNaN(start.getTime())) throw new ServiceError("startDate must be YYYY-MM-DD");
    const syncedAt = nowIso();
    const set = await fetchAccounts(url, { startDate: start, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
    const file = await storeRaw(ctx, "simplefin", `accounts-${syncedAt.replace(/[:.]/g, "")}.json`, JSON.stringify(set, null, 1));
    const result = await ingest(ctx, actor, {
      source: "simplefin",
      file,
      datas: normaliseSimplefin(set, ctx.config.tz),
      options: opts,
      inputs: { startDate: start.toISOString().slice(0, 10), defaultEntity: opts.defaultEntity, accounts: opts.accounts, file },
      upstreamErrors: simplefinErrors(set),
    });
    ctx.db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(SIMPLEFIN_LAST_SYNC, syncedAt);
    return result;
  });
}

// ---- CSV profiles -------------------------------------------------------

export function getCsvProfile(ctx: ServiceContext, name: string): CsvProfile | null {
  const row = ctx.db.query("SELECT config FROM csv_profiles WHERE name = ?").get(name) as { config: string } | null;
  return row ? (JSON.parse(row.config) as CsvProfile) : null;
}

export function listCsvProfiles(ctx: ServiceContext): Array<{ name: string; config: CsvProfile; updated: string }> {
  return (ctx.db.query("SELECT * FROM csv_profiles ORDER BY name").all() as Array<{ name: string; config: string; updated: string }>).map((r) => ({
    ...r,
    config: JSON.parse(r.config) as CsvProfile,
  }));
}

export async function putCsvProfile(ctx: ServiceContext, actor: string, name: string, config: unknown): Promise<CsvProfile> {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new ServiceError("profile name must be a lowercase slug");
  let profile: CsvProfile;
  try {
    profile = validateProfile(config);
  } catch (e) {
    if (e instanceof CsvProfileError) throw new ServiceError(e.message);
    throw e;
  }
  const before = getCsvProfile(ctx, name);
  ctx.db.query("INSERT OR REPLACE INTO csv_profiles (name, config, updated) VALUES (?, ?, ?)").run(name, JSON.stringify(profile), nowIso());
  await ctx.audit.append({ actor, operation: "csv_profile.put", inputs: { name }, before, after: profile });
  return profile;
}

// ---- Duplicate review ---------------------------------------------------

export interface DuplicateCandidate {
  id: string;
  run_id: string;
  source: string;
  source_id: string;
  account_slug: string;
  record: { externalId: string; date: string; amount: number; payee: string; memo: string | null };
  candidates: string[];
  status: "pending" | "imported" | "merged" | "discarded";
  created_at: string;
  resolved_at: string | null;
}

export function listDuplicates(ctx: ServiceContext, status = "pending"): DuplicateCandidate[] {
  const rows = ctx.db.query("SELECT * FROM duplicate_candidates WHERE status = ? ORDER BY created_at").all(status) as Array<Record<string, string>>;
  return rows.map((r) => ({ ...r, record: JSON.parse(r["record"]!), candidates: JSON.parse(r["candidates"]!) }) as unknown as DuplicateCandidate);
}

export async function resolveDuplicate(
  ctx: ServiceContext,
  actor: string,
  id: string,
  action: { action: "import" } | { action: "discard" } | { action: "merge"; wmmaId: string },
): Promise<DuplicateCandidate> {
  return serial(async () => {
    const row = ctx.db.query("SELECT * FROM duplicate_candidates WHERE id = ?").get(id) as Record<string, string> | null;
    if (!row) throw new ServiceError("not found", 404);
    const dup = { ...row, record: JSON.parse(row["record"]!), candidates: JSON.parse(row["candidates"]!) } as unknown as DuplicateCandidate;
    if (dup.status !== "pending") throw new ServiceError(`already ${dup.status}`, 409);
    const account = getAccount(ctx, dup.account_slug)!;
    const rec: BankRecord = { ...dup.record, amount: M.cents(dup.record.amount) };
    const source = dup.source as BankSource;
    let after: unknown = null;
    if (action.action === "import") {
      const txn = toTransaction(rec, account, source, dup.source_id);
      await ctx.store.appendTransactions(account.slug, [txn]);
      after = { wmma_id: txn.tags["wmma_id"] };
    } else if (action.action === "merge") {
      if (!dup.candidates.includes(action.wmmaId)) throw new ServiceError("wmmaId is not one of the candidates");
      const entry = existingEntries(await ctx.hledger.transactions()).find((e) => e.wmmaId === action.wmmaId);
      if (!entry) throw new ServiceError("candidate transaction no longer exists", 409);
      const update = applyMatch(entry, { source, sourceId: dup.source_id, account: account.hledger_account, date: rec.date, amount: rec.amount });
      await ctx.store.updateTransactionHeader(entry.file, entry.wmmaId, update);
      after = { wmma_id: entry.wmmaId, update };
    }
    const status = action.action === "import" ? "imported" : action.action === "merge" ? "merged" : "discarded";
    ctx.db.query("UPDATE duplicate_candidates SET status = ?, resolved_at = ? WHERE id = ?").run(status, nowIso(), id);
    await ctx.audit.append({ actor, operation: `duplicate.${action.action}`, inputs: { id, ...action }, before: dup, after });
    return { ...dup, status, resolved_at: nowIso() };
  });
}

export { OfxError };

// ---- REI Hub ------------------------------------------------------------

export interface ReiHubImportInput {
  filename: string;
  content: string;
  /** WMMA account for rows with no (or an unknown) account column. */
  account?: string;
  /** REI Hub account name -> WMMA account slug. */
  accountMap?: Record<string, string>;
  /** Property name -> entity slug; others use defaultEntity. */
  properties?: Record<string, string>;
  /** Entity for rental activity (created as schedule_e if missing). Default "rentals". */
  defaultEntity?: string;
  columns?: Partial<ReiHubColumns>;
  dateFormat?: DateFormat;
  invertAmount?: boolean;
}

export function importReiHub(ctx: ServiceContext, actor: string, input: ReiHubImportInput): Promise<BankImportResult> {
  return serial(async () => {
    let rows: ReiHubRecord[];
    try {
      rows = parseReiHubCsv(input.content, {
        ...(input.columns ? { columns: input.columns } : {}),
        ...(input.dateFormat ? { dateFormat: input.dateFormat } : {}),
        ...(input.invertAmount ? { invertAmount: true } : {}),
      });
    } catch (e) {
      throw new ServiceError(`could not parse REI Hub CSV: ${e instanceof Error ? e.message : String(e)}`, 422);
    }
    const defaultEntity = input.defaultEntity ?? "rentals";
    const entities = new Set([defaultEntity, ...Object.values(input.properties ?? {})]);
    for (const e of entities) if (!getEntity(ctx, e)) await addEntity(ctx, actor, { name: e, type: "schedule_e", slug: e });

    // Resolve each row's WMMA account.
    const resolveAccount = (name: string | null): AccountRow => {
      const slug =
        (name && input.accountMap?.[name]) ??
        (name ? (findAccountBySource(ctx, "reihub", name)?.slug ?? (ctx.db.query("SELECT slug FROM accounts WHERE name = ?").get(name) as { slug: string } | null)?.slug) : undefined) ??
        input.account;
      if (!slug) throw new ServiceError(`no WMMA account for REI Hub account ${JSON.stringify(name ?? "(none)")}; pass account or accountMap`, 422);
      const a = getAccount(ctx, slug);
      if (!a) throw new ServiceError(`unknown account ${JSON.stringify(slug)}`, 404);
      if (name) linkAccountSource(ctx, "reihub", name, a.slug);
      return a;
    };

    const mappingQuery = ctx.db.query("SELECT target_account FROM mappings WHERE source = 'reihub' AND source_category = ?");
    const insertMapping = ctx.db.query("INSERT OR IGNORE INTO mappings (source, source_category, target_account) VALUES ('reihub', ?, ?)");
    const byAccount = new Map<string, { account: AccountRow; records: BankRecord[] }>();
    for (const r of rows) {
      const account = resolveAccount(r.account);
      const label = cleanText(r.category);
      let target = (mappingQuery.get(label) as { target_account: string } | null)?.target_account;
      if (!target) {
        target = defaultReiHubAccount(r.category, !M.isNegative(r.amount));
        insertMapping.run(label, target);
      }
      const entity = (r.property && input.properties?.[r.property]) || defaultEntity;
      const rec: BankRecord = {
        externalId: r.externalId,
        date: r.date,
        amount: r.amount,
        payee: r.payee,
        memo: r.memo,
        category: target,
        origCategory: r.category,
        entity,
        ...(r.property ? { tags: { property: cleanText(r.property).replace(/:/g, " ") } } : {}),
      };
      const bucket = byAccount.get(account.slug) ?? { account, records: [] };
      bucket.records.push(rec);
      byAccount.set(account.slug, bucket);
    }
    const file = await storeRaw(ctx, "reihub", input.filename, input.content);
    const datas: BankAccountData[] = [...byAccount.values()].map(({ account, records }) => ({
      externalKey: `account:${account.slug}`,
      name: account.name,
      kindHint: null,
      balance: null,
      records,
    }));
    return ingest(ctx, actor, {
      source: "reihub",
      file,
      datas,
      options: { accounts: Object.fromEntries(datas.map((d) => [d.externalKey, { slug: d.externalKey.slice("account:".length) }])) },
      inputs: { filename: input.filename, account: input.account, accountMap: input.accountMap, properties: input.properties, defaultEntity, file },
    });
  });
}
