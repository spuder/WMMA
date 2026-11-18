import { authenticate, type Identity } from "./auth/tailscale";
import { ACCOUNT_KINDS, type AccountKind } from "./db";
import { YnabApiError } from "./importers/ynab/api";
import type { DateFormat } from "./importers/ynab/csv";
import { listAccountsWithBalances } from "./services/accounts";
import { ServiceError, type ServiceContext } from "./services/context";
import { importYnabApi, importYnabCsv, listImportRuns, type YnabImportOptions } from "./services/imports";

type Handler = (req: Request, identity: Identity, ctx: ServiceContext) => Response | Promise<Response>;

const DATE_FORMATS: readonly DateFormat[] = ["MM/DD/YYYY", "DD/MM/YYYY", "YYYY-MM-DD"];

function bad(msg: string): never {
  throw new ServiceError(msg, 400);
}

/** Validate import options from untrusted JSON. */
export function parseImportOptions(v: unknown): YnabImportOptions & { planId?: string; dateFormat?: DateFormat } {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) bad("options must be an object");
  const o = v as Record<string, unknown>;
  const out: YnabImportOptions & { planId?: string; dateFormat?: DateFormat } = {};
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
    const accounts: NonNullable<YnabImportOptions["accounts"]> = {};
    for (const [name, a] of Object.entries(o.accounts as Record<string, unknown>)) {
      if (typeof a !== "object" || a === null) bad(`accounts[${JSON.stringify(name)}] must be an object`);
      const { entity, kind } = a as Record<string, unknown>;
      if (entity !== undefined && typeof entity !== "string") bad(`accounts[${JSON.stringify(name)}].entity must be a string`);
      if (kind !== undefined && !ACCOUNT_KINDS.includes(kind as AccountKind)) bad(`accounts[${JSON.stringify(name)}].kind must be one of ${ACCOUNT_KINDS.join(", ")}`);
      accounts[name] = { ...(entity ? { entity: entity as string } : {}), ...(kind ? { kind: kind as AccountKind } : {}) };
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
    switch (type) {
      case "ynab-csv":
        return Response.json(await importYnabCsv(ctx, identity.login, { filename, content: await file.text(), ...opts }));
      default:
        bad(`unsupported import type ${JSON.stringify(type)} (supported: ynab-csv)`);
    }
  },
};

export function createFetchHandler(ctx: ServiceContext): (req: Request) => Promise<Response> {
  return async (req) => {
    const url = new URL(req.url);
    // Unauthenticated liveness probe for Docker's healthcheck; reveals nothing.
    if (url.pathname === "/healthz") return new Response("ok\n");

    const auth = authenticate(req, ctx.config.allowedUsers);
    if (!auth.ok) return auth.response;

    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return Response.json({ error: "not found" }, { status: 404 });
    try {
      return await handler(req, auth.identity, ctx);
    } catch (e) {
      if (e instanceof ServiceError) return Response.json({ error: e.message }, { status: e.status });
      if (e instanceof YnabApiError) return Response.json({ error: e.message }, { status: 502 });
      console.error(e);
      return Response.json({ error: "internal error" }, { status: 500 });
    }
  };
}
