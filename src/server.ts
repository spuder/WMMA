import { authenticate, type Identity } from "./auth/tailscale";
import { ACCOUNT_KINDS, type AccountKind } from "./db";
import { YnabApiError } from "./importers/ynab/api";
import type { DateFormat } from "./importers/ynab/csv";
import { getAccount, listAccountsWithBalances } from "./services/accounts";
import { ServiceError, type ServiceContext } from "./services/context";
import { importYnabApi, importYnabCsv, listImportRuns, type YnabImportOptions } from "./services/imports";
import {
  importBankCsv,
  importQfx,
  listCsvProfiles,
  listDuplicates,
  putCsvProfile,
  resolveDuplicate,
  previewSimplefinAccounts,
  saveSimplefinAccountMappings,
  simplefinStatus,
  syncSimplefin,
  type BankAccountAssignment,
} from "./services/bank-imports";
import { SimplefinError } from "./importers/simplefin";
import { categorize, createRule, listReview, listRules, resolveReview } from "./services/categorize";
import { addAccount, addEntity, listEntities, updateAccount, updateEntity } from "./services/entities";
import { listBudgets, recordTransfer, recordValuation, setBudgets } from "./services/ledger";
import { budgetReport, pnl } from "./services/reports";
import { importReiHub } from "./services/bank-imports";
import { handleMcp } from "./mcp";
import { checkedMileage, decodeVin, recordMileage, valuationHistory } from "./services/assets";
import { cashflow, categories, netWorth, spending, trend } from "./services/reports";
import { accountHistory, assignRecurring, businesses, overview, recurring, series, statement } from "./services/insights";
import { getSettings, putSettings } from "./services/settings";
import { logoCoverage, logoImage, payeeLogosWithStatus, prefetchLogos, retryLogo, setPayeeLogo } from "./services/logos";
import { buildCommit } from "./build-info";
import { getTransaction, listMappings, patchTransaction, searchTransactions, splitTransaction, updateMapping } from "./services/transactions";
import { ACCOUNT_KINDS as KINDS, ENTITY_TYPES, type EntityType } from "./db";

type Handler = (req: Request, identity: Identity, ctx: ServiceContext, params: Record<string, string>) => Response | Promise<Response>;

export interface ParsedOptions extends YnabImportOptions {
  accountMap?: Record<string, string>;
  properties?: Record<string, string>;
  columns?: Record<string, string>;
  invertAmount?: boolean;
  planId?: string;
  dateFormat?: DateFormat;
  account?: string;
  profile?: string;
  startDate?: string;
  accounts?: Record<string, BankAccountAssignment>;
}

const DATE_FORMATS: readonly DateFormat[] = ["MM/DD/YYYY", "DD/MM/YYYY", "YYYY-MM-DD"];

/** `exclude=a,b` -> ["a", "b"] (entity slugs to leave out of a report). */
/** `entities=a,b` -> only these businesses. */
const entitiesParam = (q: URLSearchParams): string[] | null => {
  const v = q.get("entities");
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : null;
};
const excludeParam = (q: URLSearchParams): string[] | null => {
  const v = q.get("exclude");
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : null;
};

/** `exclude_categories=Expenses:Taxes,Income:Interest` -> categories to leave out (with subcategories). */
const excludeCategoriesParam = (q: URLSearchParams): string[] | null => {
  const v = q.get("exclude_categories");
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : null;
};

function bad(msg: string): never {
  throw new ServiceError(msg, 400);
}

/** Validate import options from untrusted JSON. */
export function parseImportOptions(v: unknown): ParsedOptions {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) bad("options must be an object");
  const o = v as Record<string, unknown>;
  const out: ParsedOptions = {};
  for (const k of ["account", "profile"] as const) {
    if (o[k] !== undefined) {
      if (typeof o[k] !== "string" || !o[k]) bad(`${k} must be a string`);
      out[k] = o[k] as string;
    }
  }
  for (const k of ["accountMap", "properties", "columns"] as const) {
    if (o[k] === undefined) continue;
    const v = o[k];
    if (typeof v !== "object" || v === null || Array.isArray(v) || !Object.values(v).every((x) => typeof x === "string")) bad(`${k} must be an object of strings`);
    out[k] = v as Record<string, string>;
  }
  for (const k of ["includeBudgets", "invertAmount"] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== "boolean") bad(`${k} must be true or false`);
    out[k] = o[k] as boolean;
  }
  if (o.startDate !== undefined) {
    if (typeof o.startDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.startDate)) bad("startDate must be YYYY-MM-DD");
    out.startDate = o.startDate;
  }
  if (o.defaultEntity !== undefined) {
    if (typeof o.defaultEntity !== "string") bad("defaultEntity must be a string");
    out.defaultEntity = o.defaultEntity;
  }
  if (o.planId !== undefined) {
    if (typeof o.planId !== "string" || !o.planId) bad("planId must be a string");
    out.planId = o.planId;
  }
  if (o.dateFormat !== undefined) {
    if (!DATE_FORMATS.includes(o.dateFormat as DateFormat)) bad(`dateFormat must be one of ${DATE_FORMATS.join(", ")}`);
    out.dateFormat = o.dateFormat as DateFormat;
  }
  if (o.accounts !== undefined) {
    if (typeof o.accounts !== "object" || o.accounts === null || Array.isArray(o.accounts)) bad("accounts must be an object");
    const accounts: Record<string, BankAccountAssignment> = {};
    for (const [name, a] of Object.entries(o.accounts as Record<string, unknown>)) {
      if (typeof a !== "object" || a === null) bad(`accounts[${JSON.stringify(name)}] must be an object`);
      const { entity, kind, slug, name: newName } = a as Record<string, unknown>;
      const skip = (a as Record<string, unknown>).skip;
      for (const [k, val] of Object.entries({ entity, slug, name: newName })) {
        if (val !== undefined && typeof val !== "string") bad(`accounts[${JSON.stringify(name)}].${k} must be a string`);
      }
      if (kind !== undefined && !ACCOUNT_KINDS.includes(kind as AccountKind)) bad(`accounts[${JSON.stringify(name)}].kind must be one of ${ACCOUNT_KINDS.join(", ")}`);
      if (skip !== undefined && typeof skip !== "boolean") bad(`accounts[${JSON.stringify(name)}].skip must be true or false`);
      accounts[name] = {
        ...(entity ? { entity: entity as string } : {}),
        ...(kind ? { kind: kind as AccountKind } : {}),
        ...(slug ? { slug: slug as string } : {}),
        ...(newName ? { name: newName as string } : {}),
        ...(skip !== undefined ? { skip: skip as boolean } : {}),
      };
    }
    out.accounts = accounts;
  }
  return out;
}

async function jsonBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    bad("request body is not valid JSON");
  }
}

const routes: Record<string, Handler> = {
  "GET /api/v1/status": async (_req, identity, { config, hledger }) => {
    let hledgerVersion: string | null = null;
    try {
      hledgerVersion = await hledger.version();
    } catch {
      // reported as null
    }
    return Response.json({ user: identity.login, name: identity.name, hledgerWeb: hledgerVersion, timezone: config.tz, commit: buildCommit });
  },

  "GET /api/v1/accounts": async (_req, _id, ctx) => Response.json({ accounts: await listAccountsWithBalances(ctx) }),

  "GET /api/v1/import-runs": (_req, _id, ctx) => Response.json({ runs: listImportRuns(ctx) }),

  "POST /api/v1/imports/ynab-api": async (req, identity, ctx) => {
    const opts = parseImportOptions(await jsonBody(req));
    return Response.json(await importYnabApi(ctx, identity.login, opts));
  },

  /** multipart/form-data: type=ynab-csv, file=<register.csv>, options=<JSON> */
  "POST /api/v1/imports": async (req, identity, ctx) => {
    let form: Awaited<ReturnType<Request["formData"]>>;
    try {
      form = await req.formData();
    } catch {
      bad("expected multipart/form-data");
    }
    const type = form.get("type");
    const file = form.get("file");
    if (!(file instanceof Blob)) bad("missing file");
    const rawOpts = form.get("options");
    let parsed: unknown;
    try {
      parsed = typeof rawOpts === "string" && rawOpts ? JSON.parse(rawOpts) : undefined;
    } catch {
      bad("options is not valid JSON");
    }
    const opts = parseImportOptions(parsed);
    const filename = file instanceof File && file.name ? file.name : "upload.csv";
    const content = await file.text();
    switch (type) {
      case "ynab-csv": {
        const plan = form.get("plan");
        const planPart = plan instanceof Blob ? { plan: { filename: plan instanceof File && plan.name ? plan.name : "plan.csv", content: await plan.text() } } : {};
        return Response.json(await importYnabCsv(ctx, identity.login, { filename, content, ...opts, ...planPart }));
      }
      case "reihub":
        return Response.json(
          await importReiHub(ctx, identity.login, {
            filename,
            content,
            ...(opts.account ? { account: opts.account } : {}),
            ...(opts.accountMap ? { accountMap: opts.accountMap } : {}),
            ...(opts.properties ? { properties: opts.properties } : {}),
            ...(opts.defaultEntity ? { defaultEntity: opts.defaultEntity } : {}),
            ...(opts.columns ? { columns: opts.columns } : {}),
            ...(opts.dateFormat ? { dateFormat: opts.dateFormat } : {}),
            ...(opts.invertAmount ? { invertAmount: true } : {}),
          }),
        );
      case "qfx":
        return Response.json(await importQfx(ctx, identity.login, { filename, content, ...opts }));
      case "csv":
        if (!opts.profile || !opts.account) bad("csv imports need options.profile and options.account");
        return Response.json(await importBankCsv(ctx, identity.login, { filename, content, profile: opts.profile, account: opts.account }));
      default:
        bad(`unsupported import type ${JSON.stringify(type)} (supported: ynab-csv, qfx, csv, reihub)`);
    }
  },

  "POST /api/v1/sync/simplefin": async (req, identity, ctx) => {
    const opts = parseImportOptions(await jsonBody(req));
    return Response.json(await syncSimplefin(ctx, identity.login, opts));
  },

  "GET /api/v1/simplefin/status": async (_req, _identity, ctx) => Response.json(await simplefinStatus(ctx)),
  "GET /api/v1/simplefin/accounts": async (_req, _identity, ctx) => {
    const saved = ctx.db.query("SELECT value FROM settings WHERE key = ?").get("simplefin.account_mappings") as { value: string } | null;
    return Response.json({ accounts: await previewSimplefinAccounts(ctx), mappings: saved ? JSON.parse(saved.value) : {} });
  },
  "POST /api/v1/simplefin/accounts": async (req, identity, ctx) => {
    const opts = parseImportOptions(await jsonBody(req));
    if (!opts.accounts) bad("accounts are required");
    await saveSimplefinAccountMappings(ctx, identity.login, opts.accounts);
    return Response.json({ configured: true });
  },

  "GET /api/v1/csv-profiles": (_req, _id, ctx) => Response.json({ profiles: listCsvProfiles(ctx) }),

  "PUT /api/v1/csv-profiles/:name": async (req, identity, ctx, params) =>
    Response.json({ name: params["name"], config: await putCsvProfile(ctx, identity.login, params["name"]!, await jsonBody(req)) }),

  "GET /api/v1/duplicates": (req, _id, ctx) => {
    const status = new URL(req.url, "http://localhost").searchParams.get("status") ?? "pending";
    if (!["pending", "imported", "merged", "discarded"].includes(status)) bad("invalid status");
    return Response.json({ duplicates: listDuplicates(ctx, status) });
  },

  "POST /api/v1/duplicates/:id": async (req, identity, ctx, params) => {
    const body = (await jsonBody(req)) as { action?: unknown; wmmaId?: unknown } | undefined;
    const action = body?.action;
    if (action === "merge") {
      if (typeof body?.wmmaId !== "string") bad("merge needs wmmaId");
      return Response.json(await resolveDuplicate(ctx, identity.login, params["id"]!, { action: "merge", wmmaId: body.wmmaId }));
    }
    if (action === "import" || action === "discard") return Response.json(await resolveDuplicate(ctx, identity.login, params["id"]!, { action }));
    bad('action must be "import", "merge" or "discard"');
  },
};

Object.assign(routes, {
  "GET /api/v1/review": (req, _id, ctx) => {
    const q = new URL(req.url, "http://localhost").searchParams;
    const status = q.get("status") ?? "pending";
    if (!["pending", "accepted", "changed"].includes(status)) bad("invalid status");
    const order = q.get("order") === "newest" ? "newest" : "oldest";
    const limit = Math.min(intParam(q, "limit") ?? 200, 2000);
    return Response.json({ items: listReview(ctx, status, limit, order) });
  },
  "POST /api/v1/review/:id": async (req, identity, ctx, params) => {
    const body = (await jsonBody(req)) as { account?: unknown } | undefined;
    if (typeof body?.account !== "string") bad("account is required");
    return Response.json(await resolveReview(ctx, identity.login, params["id"]!, body.account));
  },
  "PATCH /api/v1/review/:id": async (req, identity, ctx, params) => {
    const body = (await jsonBody(req)) as { entity?: unknown } | undefined;
    if (typeof body?.entity !== "string") bad("entity is required");
    await patchTransaction(ctx, identity.login, params["id"]!, { entity: body.entity });
    ctx.db.query("UPDATE review_queue SET entity = ? WHERE wmma_id = ? AND status = 'pending'").run(body.entity, params["id"]!);
    return Response.json({ entity: body.entity });
  },
  "GET /api/v1/rules": (_req, _id, ctx) => Response.json({ rules: listRules(ctx) }),
  "POST /api/v1/rules": async (req, identity, ctx) => {
    const body = (await jsonBody(req)) as { match?: unknown; target?: unknown; entityOverride?: unknown } | undefined;
    if (typeof body?.target !== "string") bad("target is required");
    if (body.entityOverride !== undefined && body.entityOverride !== null && typeof body.entityOverride !== "string") bad("entityOverride must be a string");
    return Response.json(
      await createRule(ctx, identity.login, { match: body.match, target: body.target, entityOverride: (body.entityOverride as string | null | undefined) ?? null }),
      { status: 201 },
    );
  },
  /** body: {retry?: true, includeLowConfidence?: true, limit?: n}. retry re-asks Jev about pending review items. */
  "POST /api/v1/categorize": async (req, identity, ctx) => {
    const b = ((await jsonBody(req)) ?? {}) as Record<string, unknown>;
    const limit = typeof b.limit === "number" && b.limit > 0 ? Math.min(Math.floor(b.limit), 1000) : undefined;
    return Response.json(await categorize(ctx, identity.login, { ...(b.retry ? { retry: { includeLowConfidence: Boolean(b.includeLowConfidence) } } : {}), ...(limit ? { limit } : {}) }));
  },
} satisfies Record<string, Handler>);

const str = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v) bad(`${what} is required`);
  return v;
};

Object.assign(routes, {
  "GET /api/v1/entities": (req, _id, ctx) => {
    const status = new URL(req.url, "http://localhost").searchParams.get("status") ?? "active";
    if (!["active", "archived", "all"].includes(status)) bad("status must be active, archived or all");
    return Response.json({ entities: listEntities(ctx, status as "active" | "archived" | "all") });
  },
  "POST /api/v1/entities": async (req, identity, ctx) => {
    const b = ((await jsonBody(req)) ?? {}) as Record<string, unknown>;
    if (!ENTITY_TYPES.includes(b.type as EntityType)) bad(`type must be one of ${ENTITY_TYPES.join(", ")}`);
    const entity = await addEntity(ctx, identity.login, { name: str(b.name, "name"), type: b.type as EntityType, ...(typeof b.slug === "string" ? { slug: b.slug } : {}), ...(typeof b.color === "string" ? { color: b.color } : {}) });
    return Response.json(entity, { status: 201 });
  },
  "PATCH /api/v1/entities/:slug": async (req, identity, ctx, params) => {
    const b = ((await jsonBody(req)) ?? {}) as Record<string, unknown>;
    const patch: Parameters<typeof updateEntity>[3] = {};
    if (b.name !== undefined) patch.name = str(b.name, "name");
    if (b.type !== undefined) {
      if (!ENTITY_TYPES.includes(b.type as EntityType)) bad(`type must be one of ${ENTITY_TYPES.join(", ")}`);
      patch.type = b.type as EntityType;
    }
    if (b.color !== undefined) {
      if (b.color !== null && typeof b.color !== "string") bad("color must be a hex string or null");
      patch.color = b.color as string | null;
    }
    if (b.archive !== undefined) patch.archive = { date: str((b.archive as Record<string, unknown> | null)?.date, "archive.date") };
    return Response.json(await updateEntity(ctx, identity.login, params["slug"]!, patch));
  },
  "POST /api/v1/accounts": async (req, identity, ctx) => {
    const b = ((await jsonBody(req)) ?? {}) as Record<string, unknown>;
    if (!KINDS.includes(b.kind as AccountKind)) bad(`kind must be one of ${KINDS.join(", ")}`);
    if (b.websiteUrl !== undefined && b.websiteUrl !== null && typeof b.websiteUrl !== "string") bad("websiteUrl must be a string or null");
    if (b.linkedLoan !== undefined && b.linkedLoan !== null && typeof b.linkedLoan !== "string") bad("linkedLoan must be a string or null");
    if (b.value !== undefined && (typeof b.value !== "object" || b.value === null)) bad("value must be { value, date? }");
    const value = b.value as { value?: unknown; date?: unknown } | undefined;
    return Response.json(
      await addAccount(ctx, identity.login, {
        name: str(b.name, "name"),
        kind: b.kind as AccountKind,
        entity: str(b.entity, "entity"),
        ...(b.websiteUrl !== undefined ? { websiteUrl: b.websiteUrl as string | null } : {}),
        ...(b.details !== undefined ? { details: b.details } : {}),
        ...(b.linkedLoan !== undefined ? { linkedLoan: b.linkedLoan as string | null } : {}),
        ...(value ? { value: { value: value.value, ...(value.date !== undefined ? { date: value.date } : {}) } } : {}),
      }),
      { status: 201 },
    );
  },
  "PATCH /api/v1/accounts/:slug": async (req, identity, ctx, params) => {
    const b = ((await jsonBody(req)) ?? {}) as Record<string, unknown>;
    return Response.json(
      await updateAccount(ctx, identity.login, params["slug"]!, {
        ...(b.defaultEntity !== undefined ? { defaultEntity: str(b.defaultEntity, "defaultEntity") } : {}),
        ...(b.websiteUrl !== undefined ? { websiteUrl: b.websiteUrl === null ? null : str(b.websiteUrl, "websiteUrl") } : {}),
        ...(b.logoDomain !== undefined ? { logoDomain: b.logoDomain === null ? null : str(b.logoDomain, "logoDomain") } : {}),
        ...(b.close !== undefined ? { close: { date: str((b.close as Record<string, unknown> | null)?.date, "close.date") } } : {}),
        ...(b.details !== undefined ? { details: b.details } : {}),
        ...(b.linkedLoan !== undefined ? { linkedLoan: b.linkedLoan === null ? null : str(b.linkedLoan, "linkedLoan") } : {}),
      }),
    );
  },
  "GET /api/v1/accounts/:slug/valuations": (_req, _id, ctx, params) => Response.json({ valuations: valuationHistory(ctx, params["slug"]!) }),
  "GET /api/v1/vin/:vin": async (_req, _id, _ctx, params) => Response.json(await decodeVin(params["vin"]!)),
  "GET /api/v1/budgets": async (req, _id, ctx) => {
    const entity = new URL(req.url, "http://localhost").searchParams.get("entity") ?? undefined;
    return Response.json({ budgets: await listBudgets(ctx, entity) });
  },
  "PUT /api/v1/budgets": async (req, identity, ctx) => {
    const b = await jsonBody(req);
    const items = Array.isArray(b) ? b : [b];
    return Response.json({ updated: await setBudgets(ctx, identity.login, items as Parameters<typeof setBudgets>[2]) });
  },
  "POST /api/v1/transfers": async (req, identity, ctx) => {
    const b = ((await jsonBody(req)) ?? {}) as Record<string, unknown>;
    return Response.json(
      await recordTransfer(ctx, identity.login, { from: str(b.from, "from"), to: str(b.to, "to"), amount: b.amount, date: b.date, ...(typeof b.memo === "string" ? { memo: b.memo } : {}) }),
      { status: 201 },
    );
  },
  "POST /api/v1/valuations": async (req, identity, ctx) => {
    const b = ((await jsonBody(req)) ?? {}) as Record<string, unknown>;
    const account = getAccount(ctx, str(b.account, "account"));
    // Vehicles: an optional odometer reading taken with the valuation, validated first.
    const miles = account ? checkedMileage(account, b.mileage) : undefined;
    const result = await recordValuation(ctx, identity.login, { account: str(b.account, "account"), date: b.date, value: b.value });
    if (account && miles !== undefined) recordMileage(ctx, account, miles, b.date as string);
    return Response.json(result, { status: 201 });
  },
  "GET /api/v1/reports/pnl": async (req, _id, ctx) => {
    const q = new URL(req.url, "http://localhost").searchParams;
    return Response.json(await pnl(ctx, { entity: q.get("entity"), entities: entitiesParam(q), exclude: excludeParam(q), excludeCategories: excludeCategoriesParam(q), from: str(q.get("from"), "from"), to: str(q.get("to"), "to") }));
  },
  "GET /api/v1/reports/budget": async (req, _id, ctx) => {
    const q = new URL(req.url, "http://localhost").searchParams;
    return Response.json(await budgetReport(ctx, { entity: str(q.get("entity"), "entity"), month: str(q.get("month"), "month") }));
  },
} satisfies Record<string, Handler>);

const intParam = (q: URLSearchParams, k: string): number | undefined => {
  const v = q.get(k);
  if (v === null) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) bad(`${k} must be a non-negative integer`);
  return n;
};

Object.assign(routes, {
  "GET /api/v1/transactions": async (req, _id, ctx) => {
    const q = new URL(req.url, "http://localhost").searchParams;
    const opt = (k: string) => q.get(k) ?? undefined;
    return Response.json(
      await searchTransactions(ctx, {
        ...Object.fromEntries((["from", "to", "account", "entity", "category", "text"] as const).filter((k) => opt(k)).map((k) => [k, opt(k)])),
        ...(intParam(q, "limit") !== undefined ? { limit: intParam(q, "limit")! } : {}),
        ...(intParam(q, "offset") !== undefined ? { offset: intParam(q, "offset")! } : {}),
      }),
    );
  },
  "GET /api/v1/transactions/:id": async (_req, _id, ctx, params) => {
    const { file: _f, ...t } = await getTransaction(ctx, params["id"]!);
    return Response.json(t);
  },
  "PATCH /api/v1/transactions/:id": async (req, identity, ctx, params) => {
    const b = ((await jsonBody(req)) ?? {}) as Record<string, unknown>;
    const patch: Parameters<typeof patchTransaction>[3] = {};
    if (b.category !== undefined) {
      const c = b.category as Record<string, unknown> | string;
      patch.category = typeof c === "string" ? { to: c } : { to: str(c?.to, "category.to"), ...(typeof c?.from === "string" ? { from: c.from } : {}) };
    }
    if (b.entity !== undefined) patch.entity = str(b.entity, "entity");
    if (b.memo !== undefined) {
      if (b.memo !== null && typeof b.memo !== "string") bad("memo must be a string or null");
      patch.memo = b.memo as string | null;
    }
    return Response.json(await patchTransaction(ctx, identity.login, params["id"]!, patch));
  },
  "POST /api/v1/transactions/:id/split": async (req, identity, ctx, params) => {
    const b = ((await jsonBody(req)) ?? {}) as Record<string, unknown>;
    return Response.json(
      await splitTransaction(ctx, identity.login, params["id"]!, { ...(typeof b.from === "string" ? { from: b.from } : {}), postings: b.postings as Array<{ account: string; amount: unknown }> }),
    );
  },
  "GET /api/v1/mappings": (req, _id, ctx) => Response.json({ mappings: listMappings(ctx, new URL(req.url, "http://localhost").searchParams.get("source") ?? undefined) }),
  "PUT /api/v1/mappings": async (req, identity, ctx) => {
    const b = ((await jsonBody(req)) ?? {}) as Record<string, unknown>;
    if (b.apply !== undefined && typeof b.apply !== "boolean") bad("apply must be true or false");
    return Response.json(
      await updateMapping(ctx, identity.login, { source: str(b.source, "source"), sourceCategory: str(b.sourceCategory, "sourceCategory"), target: str(b.target, "target"), apply: (b.apply as boolean) ?? false }),
    );
  },
  "GET /api/v1/reports/cashflow": async (req, _id, ctx) => {
    const q = new URL(req.url, "http://localhost").searchParams;
    const depth = intParam(q, "depth");
    return Response.json(await cashflow(ctx, { entity: q.get("entity"), entities: entitiesParam(q), exclude: excludeParam(q), excludeCategories: excludeCategoriesParam(q), from: str(q.get("from"), "from"), to: str(q.get("to"), "to"), ...(depth ? { depth } : {}) }));
  },
  "GET /api/v1/reports/spending": async (req, _id, ctx) => {
    const q = new URL(req.url, "http://localhost").searchParams;
    const depth = intParam(q, "depth");
    return Response.json(await spending(ctx, { entity: q.get("entity"), entities: entitiesParam(q), exclude: excludeParam(q), excludeCategories: excludeCategoriesParam(q), from: str(q.get("from"), "from"), to: str(q.get("to"), "to"), ...(depth ? { depth } : {}) }));
  },
  "GET /api/v1/reports/networth": async (req, _id, ctx) => {
    const q = new URL(req.url, "http://localhost").searchParams;
    return Response.json(await netWorth(ctx, { from: str(q.get("from"), "from"), to: str(q.get("to"), "to") }));
  },
  "GET /api/v1/reports/trend": async (req, _id, ctx) => {
    const q = new URL(req.url, "http://localhost").searchParams;
    return Response.json(await trend(ctx, { entity: q.get("entity"), from: str(q.get("from"), "from"), to: str(q.get("to"), "to") }));
  },
  "GET /api/v1/reports/overview": async (req, _id, ctx) => {
    const q = new URL(req.url, "http://localhost").searchParams;
    return Response.json(await overview(ctx, { entity: q.get("entity"), entities: entitiesParam(q), exclude: excludeParam(q), excludeCategories: excludeCategoriesParam(q), from: q.get("from"), to: q.get("to") }));
  },
  "GET /api/v1/reports/series": async (req, _id, ctx) => {
    const q = new URL(req.url, "http://localhost").searchParams;
    const stack = q.get("stack");
    if (stack !== null && stack !== "income" && stack !== "expense") bad("stack must be income or expense");
    const top = intParam(q, "top");
    return Response.json(
      await series(ctx, { entity: q.get("entity"), entities: entitiesParam(q), exclude: excludeParam(q), excludeCategories: excludeCategoriesParam(q), from: q.get("from"), to: q.get("to"), interval: q.get("interval"), stack: stack as "income" | "expense" | null, ...(top !== undefined ? { top } : {}) }),
    );
  },
  "GET /api/v1/reports/balances": async (req, _id, ctx) => {
    const q = new URL(req.url, "http://localhost").searchParams;
    return Response.json(await accountHistory(ctx, { entity: q.get("entity"), entities: entitiesParam(q), exclude: excludeParam(q), from: str(q.get("from"), "from"), to: q.get("to"), interval: q.get("interval") }));
  },
  "GET /api/v1/reports/recurring": async (req, _id, ctx) => {
    const q = new URL(req.url, "http://localhost").searchParams;
    return Response.json(await recurring(ctx, { entity: q.get("entity"), entities: entitiesParam(q), exclude: excludeParam(q), excludeCategories: excludeCategoriesParam(q) }));
  },
  "POST /api/v1/recurring/assign": async (req, identity, ctx) => {
    const b = ((await jsonBody(req)) ?? {}) as Record<string, unknown>;
    if (b.future !== undefined && typeof b.future !== "boolean") bad("future must be true or false");
    return Response.json(await assignRecurring(ctx, identity.login, { key: str(b.key, "key"), entity: str(b.entity, "entity"), ...(b.future !== undefined ? { future: b.future as boolean } : {}) }));
  },
  "GET /api/v1/reports/businesses": async (req, _id, ctx) => {
    const q = new URL(req.url, "http://localhost").searchParams;
    return Response.json(await businesses(ctx, { from: q.get("from"), to: q.get("to"), interval: q.get("interval"), entities: entitiesParam(q), exclude: excludeParam(q), excludeCategories: excludeCategoriesParam(q) }));
  },
  "GET /api/v1/reports/statement": async (req, _id, ctx) => {
    const q = new URL(req.url, "http://localhost").searchParams;
    return Response.json(await statement(ctx, { entity: str(q.get("entity"), "entity"), from: q.get("from"), to: q.get("to"), interval: q.get("interval"), excludeCategories: excludeCategoriesParam(q) }));
  },
  "GET /api/v1/categories": async (_req, _id, ctx) => Response.json({ categories: await categories(ctx) }),
  "GET /api/v1/settings": async (_req, _id, ctx) => Response.json(await getSettings(ctx)),
  "PUT /api/v1/settings": async (req, identity, ctx) => {
    const b = ((await jsonBody(req)) ?? {}) as Record<string, unknown>;
    if (b.jevApiKey !== undefined && b.jevApiKey !== null && typeof b.jevApiKey !== "string") bad("jevApiKey must be a string or null");
    if (b.simplefinSetupToken !== undefined && typeof b.simplefinSetupToken !== "string") bad("simplefinSetupToken must be a string");
    if (b.simplefinDisconnect !== undefined && typeof b.simplefinDisconnect !== "boolean") bad("simplefinDisconnect must be a boolean");
    return Response.json(
      await putSettings(ctx, identity.login, {
        ...(b.settings !== undefined ? { settings: b.settings as Record<string, unknown> } : {}),
        ...(b.jevApiKey !== undefined ? { jevApiKey: b.jevApiKey as string | null } : {}),
        ...(b.simplefinSetupToken !== undefined ? { simplefinSetupToken: b.simplefinSetupToken as string } : {}),
        ...(b.simplefinDisconnect !== undefined ? { simplefinDisconnect: b.simplefinDisconnect as boolean } : {}),
      }),
    );
  },
} satisfies Record<string, Handler>);

/** How long an image request waits for a first-time fetch before answering 404 (no-store). */
const LOGO_WAIT_MS = 8000;

Object.assign(routes, {
  "GET /api/v1/logos": async (_req, _id, ctx) => Response.json({ payees: await payeeLogosWithStatus(ctx) }),
  "GET /api/v1/logos/coverage": async (req, _id, ctx) => {
    const limit = Number(new URL(req.url, "http://localhost").searchParams.get("limit") ?? 50);
    return Response.json(await logoCoverage(ctx, Number.isFinite(limit) ? Math.max(0, Math.min(Math.floor(limit), 5000)) : 50));
  },
  "POST /api/v1/logos/prefetch": async (req, _id, ctx) => {
    const b = ((await jsonBody(req)) ?? {}) as Record<string, unknown>;
    if (b.force !== undefined && typeof b.force !== "boolean") bad("force must be true or false");
    return Response.json({ ...(await prefetchLogos(ctx, { force: (b.force as boolean) ?? false })), coverage: await logoCoverage(ctx) });
  },
  "GET /api/v1/logos/img/:domain": async (_req, _id, ctx, params) => {
    // A slow site shouldn't hold the browser's connection: answer "not yet" and let the fetch finish in the background.
    const fetching = logoImage(ctx, params["domain"]!);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const img = await Promise.race([fetching, new Promise<"slow">((resolve) => (timer = setTimeout(() => resolve("slow"), LOGO_WAIT_MS)))]).finally(() => clearTimeout(timer));
    if (img === "slow") {
      fetching.catch(() => {});
      return new Response("still fetching", { status: 404, headers: { "cache-control": "no-store" } });
    }
    if (!img) return new Response("no logo", { status: 404, headers: { "cache-control": "private, max-age=3600" } });
    return new Response(img.bytes, {
      headers: {
        "content-type": img.contentType,
        "cache-control": "private, max-age=86400",
        "x-content-type-options": "nosniff",
        // SVGs are fetched from third-party sites: never let one run script if opened directly.
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
  },
  "POST /api/v1/logos/img/:domain/retry": async (_req, _id, ctx, params) => Response.json(await retryLogo(ctx, params["domain"]!)),
  "PUT /api/v1/logos/payees/:payee": async (req, identity, ctx, params) => {
    const b = ((await jsonBody(req)) ?? {}) as Record<string, unknown>;
    for (const k of ["domain", "glyph"] as const) if (b[k] !== undefined && b[k] !== null && typeof b[k] !== "string") bad(`${k} must be a string or null`);
    return Response.json(await setPayeeLogo(ctx, identity.login, params["payee"]!, { domain: (b.domain as string | null) ?? null, glyph: (b.glyph as string | null) ?? null }));
  },
  "DELETE /api/v1/logos/payees/:payee": async (_req, identity, ctx, params) => Response.json(await setPayeeLogo(ctx, identity.login, params["payee"]!, { reset: true })),
} satisfies Record<string, Handler>);

const compiled = Object.entries(routes).map(([key, handler]) => {
  const [method, path] = key.split(" ") as [string, string];
  const names: string[] = [];
  const re = new RegExp(
    "^" +
      path.replace(/:([a-zA-Z]+)/g, (_, n: string) => {
        names.push(n);
        return "([^/]+)";
      }) +
      "$",
  );
  return { method, re, names, handler };
});

function route(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
  for (const r of compiled) {
    if (r.method !== method) continue;
    const m = r.re.exec(pathname);
    if (!m) continue;
    return { handler: r.handler, params: Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1]!)])) };
  }
  return null;
}

export function createFetchHandler(ctx: ServiceContext): (req: Request) => Promise<Response> {
  return async (req) => {
    // Bun leaves req.url relative when the client sends no Host header
    // (e.g. a bare HTTP/1.0 request), so parse against a placeholder base.
    const url = new URL(req.url, "http://localhost");
    // Unauthenticated liveness probe for Docker's healthcheck; reveals nothing.
    if (url.pathname === "/healthz") return new Response("ok\n");

    const auth = authenticate(req, ctx.config.allowedUsers);
    if (!auth.ok) return auth.response;

    if (url.pathname === "/mcp") {
      try {
        return await handleMcp(ctx, auth.identity.login, req);
      } catch (e) {
        console.error(e);
        return Response.json({ error: "internal error" }, { status: 500 });
      }
    }

    const r = route(req.method, url.pathname);
    if (!r) return Response.json({ error: "not found" }, { status: 404 });
    try {
      return await r.handler(req, auth.identity, ctx, r.params);
    } catch (e) {
      if (e instanceof ServiceError) return Response.json({ error: e.message }, { status: e.status });
      if (e instanceof YnabApiError) return Response.json({ error: e.message }, { status: 502 });
      // Only statuses WMMA chose (bad user input) pass through; SimpleFIN's own 401/403/429
      // must not masquerade as WMMA's auth errors, so everything else is a gateway error.
      if (e instanceof SimplefinError) return Response.json({ error: e.message }, { status: e.status === 422 ? 422 : 502 });
      console.error(e);
      return Response.json({ error: "internal error" }, { status: 500 });
    }
  };
}
