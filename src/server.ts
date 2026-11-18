import { authenticate, type Identity } from "./auth/tailscale";
import { ACCOUNT_KINDS, type AccountKind } from "./db";
import { YnabApiError } from "./importers/ynab/api";
import type { DateFormat } from "./importers/ynab/csv";
import { listAccountsWithBalances } from "./services/accounts";
import { ServiceError, type ServiceContext } from "./services/context";
import { importYnabApi, importYnabCsv, listImportRuns, type YnabImportOptions } from "./services/imports";
import {
  importBankCsv,
  importQfx,
  listCsvProfiles,
  listDuplicates,
  putCsvProfile,
  resolveDuplicate,
  syncSimplefin,
  type BankAccountAssignment,
} from "./services/bank-imports";
import { SimplefinError } from "./importers/simplefin";

type Handler = (req: Request, identity: Identity, ctx: ServiceContext, params: Record<string, string>) => Response | Promise<Response>;

export interface ParsedOptions extends YnabImportOptions {
  planId?: string;
  dateFormat?: DateFormat;
  account?: string;
  profile?: string;
  startDate?: string;
  accounts?: Record<string, BankAccountAssignment>;
}

const DATE_FORMATS: readonly DateFormat[] = ["MM/DD/YYYY", "DD/MM/YYYY", "YYYY-MM-DD"];

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
      for (const [k, val] of Object.entries({ entity, slug, name: newName })) {
        if (val !== undefined && typeof val !== "string") bad(`accounts[${JSON.stringify(name)}].${k} must be a string`);
      }
      if (kind !== undefined && !ACCOUNT_KINDS.includes(kind as AccountKind)) bad(`accounts[${JSON.stringify(name)}].kind must be one of ${ACCOUNT_KINDS.join(", ")}`);
      accounts[name] = {
        ...(entity ? { entity: entity as string } : {}),
        ...(kind ? { kind: kind as AccountKind } : {}),
        ...(slug ? { slug: slug as string } : {}),
        ...(newName ? { name: newName as string } : {}),
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
    return Response.json({ user: identity.login, hledgerWeb: hledgerVersion, timezone: config.tz });
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
      case "ynab-csv":
        return Response.json(await importYnabCsv(ctx, identity.login, { filename, content, ...opts }));
      case "qfx":
        return Response.json(await importQfx(ctx, identity.login, { filename, content, ...opts }));
      case "csv":
        if (!opts.profile || !opts.account) bad("csv imports need options.profile and options.account");
        return Response.json(await importBankCsv(ctx, identity.login, { filename, content, profile: opts.profile, account: opts.account }));
      default:
        bad(`unsupported import type ${JSON.stringify(type)} (supported: ynab-csv, qfx, csv)`);
    }
  },

  "POST /api/v1/sync/simplefin": async (req, identity, ctx) => {
    const opts = parseImportOptions(await jsonBody(req));
    return Response.json(await syncSimplefin(ctx, identity.login, opts));
  },

  "GET /api/v1/csv-profiles": (_req, _id, ctx) => Response.json({ profiles: listCsvProfiles(ctx) }),

  "PUT /api/v1/csv-profiles/:name": async (req, identity, ctx, params) =>
    Response.json({ name: params["name"], config: await putCsvProfile(ctx, identity.login, params["name"]!, await jsonBody(req)) }),

  "GET /api/v1/duplicates": (req, _id, ctx) => {
    const status = new URL(req.url).searchParams.get("status") ?? "pending";
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
    const url = new URL(req.url);
    // Unauthenticated liveness probe for Docker's healthcheck; reveals nothing.
    if (url.pathname === "/healthz") return new Response("ok\n");

    const auth = authenticate(req, ctx.config.allowedUsers);
    if (!auth.ok) return auth.response;

    const r = route(req.method, url.pathname);
    if (!r) return Response.json({ error: "not found" }, { status: 404 });
    try {
      return await r.handler(req, auth.identity, ctx, r.params);
    } catch (e) {
      if (e instanceof ServiceError) return Response.json({ error: e.message }, { status: e.status });
      if (e instanceof YnabApiError || e instanceof SimplefinError) return Response.json({ error: e.message }, { status: 502 });
      console.error(e);
      return Response.json({ error: "internal error" }, { status: 500 });
    }
  };
}
