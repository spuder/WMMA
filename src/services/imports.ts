/**
 * Import orchestration (SPEC §4): keep the raw file, convert, skip
 * duplicates by (source, source_id), write journals, record an import run,
 * audit, and check balances against the source.
 */
import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { AccountKind } from "../db";
import { nowIso } from "../db";
import { formatTransaction } from "../journal/format";
import * as M from "../money";
import { accountType, slugify } from "../naming";
import { ulid } from "../ulid";
import { YnabApi, normaliseApiExport, type YnabApiOptions } from "../importers/ynab/api";
import { convert, type ResolvedAccount } from "../importers/ynab/convert";
import { parseYnabRegisterCsv, type DateFormat } from "../importers/ynab/csv";
import type { YnabAccount, YnabAccountType, YnabDataset } from "../importers/ynab/model";
import {
  balancesFrom,
  createAccount,
  ensureEntity,
  findAccountBySource,
  linkAccountSource,
  type AccountRow,
} from "./accounts";
import { ServiceError, type ServiceContext } from "./context";
import { categorize, type CategorizeSummary } from "./categorize";

export interface AccountAssignment {
  entity?: string;
  kind?: AccountKind;
}

export interface YnabImportOptions {
  /** Entity for accounts seen for the first time with no explicit assignment. Default "personal". */
  defaultEntity?: string;
  /** First-import assignments keyed by YNAB account name. Ignored for accounts already known. */
  accounts?: Record<string, AccountAssignment>;
}

export interface BalanceCheck {
  account: string;
  hledgerAccount: string;
  source: string;
  wmma: string;
  match: boolean;
}

export interface ImportResult {
  runId: string;
  source: string;
  file: string;
  added: number;
  skippedDuplicates: number;
  pairedTransfers: number;
  createdAccounts: Array<{ slug: string; name: string; hledgerAccount: string; kind: AccountKind; entity: string; kindGuessed: boolean }>;
  createdEntities: string[];
  newMappings: number;
  balances: BalanceCheck[];
  categorization: CategorizeSummary | { error: string };
}

export function ynabKind(t: YnabAccountType | null): AccountKind | null {
  switch (t) {
    case "checking":
    case "savings":
    case "cash":
      return "bank";
    case "creditCard":
    case "lineOfCredit":
      return "credit";
    case "otherAsset":
      return "other_asset";
    case "otherLiability":
    case "mortgage":
    case "autoLoan":
    case "studentLoan":
    case "personalLoan":
    case "medicalDebt":
    case "otherDebt":
      return "loan";
    default:
      return null;
  }
}

/** Categorise newly added entries; never fails the import. */
export async function runCategorization(ctx: ServiceContext, actor: string, wmmaIds: string[]): Promise<CategorizeSummary | { error: string }> {
  if (wmmaIds.length === 0) return { considered: 0, byRule: 0, byJev: 0, queued: 0, jevCalls: 0, errors: [] };
  try {
    return await categorize(ctx, actor, { wmmaIds: new Set(wmmaIds) });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Finer account prefixes than the kind default, where YNAB tells us more. */
const YNAB_PREFIX: Record<string, string> = { savings: "Assets:Savings", cash: "Assets:Cash" };

/** One import at a time per process. */
let importQueue: Promise<unknown> = Promise.resolve();
export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = importQueue.then(fn, fn);
  importQueue = run.catch(() => {});
  return run;
}

export async function storeRaw(ctx: ServiceContext, sub: string, name: string, content: string): Promise<string> {
  const dir = join(ctx.store.paths.imports, sub);
  await mkdir(dir, { recursive: true });
  const sha = createHash("sha256").update(content).digest("hex").slice(0, 16);
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80) || "import";
  const path = join(dir, `${sha}-${safe}`);
  try {
    await stat(path); // identical content already stored: raw files are never rewritten
  } catch {
    await writeFile(path, content, { mode: 0o440, flag: "wx" });
  }
  return relative(ctx.store.paths.root, path);
}

async function existingSourceIds(ctx: ServiceContext, source: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const t of await ctx.hledger.transactions()) {
    const tags = new Map(t.ttags);
    if (tags.get("source") === source && tags.get("source_id")) ids.add(tags.get("source_id")!);
  }
  return ids;
}

function resolveAccounts(
  ctx: ServiceContext,
  sourceKey: string,
  accounts: YnabAccount[],
  opts: YnabImportOptions,
  created: ImportResult["createdAccounts"],
  createdEntities: string[],
): Map<string, ResolvedAccount> {
  const out = new Map<string, ResolvedAccount>();
  const defaultEntity = opts.defaultEntity ?? "personal";
  const resolve = ctx.db.transaction(() => {
    for (const a of accounts) {
      let row: AccountRow | null = findAccountBySource(ctx, sourceKey, a.key);
      if (!row) {
        // Same name already known (e.g. imported from the other YNAB importer): reuse it.
        row = ctx.db.query("SELECT * FROM accounts WHERE name = ?").get(a.name) as AccountRow | null;
      }
      if (!row) {
        const assign = opts.accounts?.[a.name] ?? {};
        const entity = assign.entity ?? defaultEntity;
        if (ensureEntity(ctx, entity).created) createdEntities.push(entity);
        const inferred = ynabKind(a.type);
        const kind = assign.kind ?? inferred ?? "bank";
        const prefix = !assign.kind ? YNAB_PREFIX[a.type ?? ""] : undefined;
        row = createAccount(ctx, { name: a.name, kind, entity, status: a.closed ? "closed" : "open", ...(prefix ? { prefix } : {}) });
        created.push({
          slug: row.slug,
          name: row.name,
          hledgerAccount: row.hledger_account,
          kind,
          entity,
          kindGuessed: !assign.kind && !inferred,
        });
      }
      linkAccountSource(ctx, sourceKey, a.key, row.slug);
      out.set(a.key, { slug: row.slug, hledgerAccount: row.hledger_account, entity: row.default_entity, kind: row.kind });
    }
  });
  resolve();
  return out;
}

async function importDataset(
  ctx: ServiceContext,
  actor: string,
  params: { runSource: string; accountSource: string; file: string; dataset: YnabDataset; options: YnabImportOptions; inputs: unknown },
): Promise<ImportResult> {
  const runId = ulid();
  const started = nowIso();
  ctx.db
    .query("INSERT INTO import_runs (id, source, file, actor, started) VALUES (?, ?, ?, ?, ?)")
    .run(runId, params.runSource, params.file, actor, started);

  try {
    const createdAccounts: ImportResult["createdAccounts"] = [];
    const createdEntities: string[] = [];
    const accounts = resolveAccounts(ctx, params.accountSource, params.dataset.accounts, params.options, createdAccounts, createdEntities);

    const mappingQuery = ctx.db.query("SELECT target_account FROM mappings WHERE source = 'ynab' AND source_category = ?");
    const conv = convert(params.dataset, {
      source: "ynab",
      accounts,
      lookupMapping: (label) => (mappingQuery.get(label) as { target_account: string } | null)?.target_account,
      newId: ulid,
    });

    const known = await existingSourceIds(ctx, "ynab");
    const fresh = conv.txns.filter((c) => {
      if (known.has(c.sourceId)) return false;
      known.add(c.sourceId);
      return true;
    });
    const skippedDuplicates = conv.txns.length - fresh.length;

    // Validate everything before the first write.
    for (const c of fresh) formatTransaction(c.txn);

    const used = new Set<string>(accounts.size ? [...accounts.values()].map((a) => a.hledgerAccount) : []);
    for (const c of fresh) for (const p of c.txn.postings) used.add(p.account);
    await ctx.store.declareAccounts([...used].sort().map((name) => ({ name, type: accountType(name) })));

    const bySlug = new Map<string, typeof fresh>();
    for (const c of fresh) bySlug.set(c.slug, [...(bySlug.get(c.slug) ?? []), c]);
    for (const [slug, list] of bySlug) await ctx.store.appendTransactions(slug, list.map((c) => c.txn));

    const insertMapping = ctx.db.query("INSERT OR IGNORE INTO mappings (source, source_category, target_account) VALUES ('ynab', ?, ?)");
    ctx.db.transaction(() => {
      for (const [label, target] of conv.newMappings) insertMapping.run(label, target);
    })();

    // Balance check against the source, read back through hledger.
    const wmmaBalances = balancesFrom(await ctx.hledger.transactions());
    const balances: BalanceCheck[] = [];
    for (const a of params.dataset.accounts) {
      if (a.balance === null) continue;
      const r = accounts.get(a.key)!;
      const w = wmmaBalances.get(r.hledgerAccount) ?? M.ZERO;
      balances.push({ account: a.name, hledgerAccount: r.hledgerAccount, source: M.format(a.balance), wmma: M.format(w), match: M.equals(a.balance, w) });
    }

    ctx.db
      .query("UPDATE import_runs SET finished = ?, added = ?, skipped_duplicates = ? WHERE id = ?")
      .run(nowIso(), fresh.length, skippedDuplicates, runId);

    const result: ImportResult = {
      runId,
      source: params.runSource,
      file: params.file,
      added: fresh.length,
      skippedDuplicates,
      pairedTransfers: conv.pairedSkips,
      createdAccounts,
      createdEntities,
      newMappings: conv.newMappings.size,
      balances,
      categorization: await runCategorization(ctx, actor, fresh.map((c) => String(c.txn.tags["wmma_id"]))),
    };
    await ctx.audit.append({
      actor,
      operation: `import.${params.runSource}`,
      inputs: params.inputs,
      before: null,
      after: {
        runId,
        added: fresh.map((c) => ({ wmma_id: c.txn.tags["wmma_id"], source_id: c.sourceId, account: c.slug })),
        skippedDuplicates,
        createdAccounts,
        createdEntities,
        newMappings: Object.fromEntries(conv.newMappings),
      },
    });
    return result;
  } catch (e) {
    ctx.db
      .query("UPDATE import_runs SET finished = ?, errors = ? WHERE id = ?")
      .run(nowIso(), JSON.stringify([String(e instanceof Error ? e.message : e)]), runId);
    await ctx.audit.append({ actor, operation: `import.${params.runSource}`, inputs: params.inputs, before: null, after: { runId, error: String(e) } });
    throw e;
  }
}

export function importYnabApi(
  ctx: ServiceContext,
  actor: string,
  opts: YnabImportOptions & { planId?: string; token?: string; api?: YnabApiOptions } = {},
): Promise<ImportResult> {
  return serial(async () => {
    const token = opts.token ?? process.env.YNAB_TOKEN ?? "";
    if (!token) throw new ServiceError("YNAB_TOKEN is not set", 422);
    const raw = await new YnabApi(token, opts.api).fetchPlan(opts.planId ?? "last-used");
    const json = JSON.stringify(raw, null, 1);
    const file = await storeRaw(ctx, "ynab", `api-${raw.planId}-${raw.fetchedAt.slice(0, 10)}.json`, json);
    const dataset = normaliseApiExport(raw);
    return importDataset(ctx, actor, {
      runSource: "ynab-api",
      accountSource: "ynab",
      file,
      dataset,
      options: opts,
      inputs: { planId: opts.planId ?? "last-used", defaultEntity: opts.defaultEntity, accounts: opts.accounts, file },
    });
  });
}

export function importYnabCsv(
  ctx: ServiceContext,
  actor: string,
  input: { filename: string; content: string; dateFormat?: DateFormat } & YnabImportOptions,
): Promise<ImportResult> {
  return serial(async () => {
    let dataset: YnabDataset;
    try {
      dataset = parseYnabRegisterCsv(input.content, input.dateFormat ? { dateFormat: input.dateFormat } : {});
    } catch (e) {
      throw new ServiceError(`could not parse YNAB CSV: ${e instanceof Error ? e.message : String(e)}`, 422);
    }
    const file = await storeRaw(ctx, "ynab", slugify(input.filename.replace(/\.csv$/i, ""), "register") + ".csv", input.content);
    return importDataset(ctx, actor, {
      runSource: "ynab-csv",
      accountSource: "ynab-csv",
      file,
      dataset,
      options: input,
      inputs: { filename: input.filename, dateFormat: input.dateFormat, defaultEntity: input.defaultEntity, accounts: input.accounts, file },
    });
  });
}

export interface ImportRun {
  id: string;
  source: string;
  file: string | null;
  actor: string;
  started: string;
  finished: string | null;
  added: number;
  skipped_duplicates: number;
  errors: string[];
}

export function listImportRuns(ctx: ServiceContext, limit = 50): ImportRun[] {
  const rows = ctx.db.query("SELECT * FROM import_runs ORDER BY started DESC, id DESC LIMIT ?").all(limit) as Array<Omit<ImportRun, "errors"> & { errors: string }>;
  return rows.map((r) => ({ ...r, errors: JSON.parse(r.errors) as string[] }));
}
