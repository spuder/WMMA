/**
 * SimpleFIN Bridge client (protocol v2, accepts v1 responses).
 * https://www.simplefin.org/protocol.html
 */
import * as M from "../money";
import type { BankAccountData } from "./bank";

export interface SimplefinAccountSet {
  errlist?: Array<{ code: string; msg: string; account_id?: string }>;
  errors?: string[];
  connections?: Array<{ conn_id: string; name: string }>;
  accounts: Array<{
    id: string;
    name: string;
    conn_id?: string;
    org?: { name?: string; domain?: string };
    currency: string;
    balance: string;
    "balance-date": number;
    transactions?: Array<{ id: string; posted: number; amount: string; description: string; payee?: string; memo?: string; pending?: boolean }>;
  }>;
}

export class SimplefinError extends Error {
  override name = "SimplefinError";
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

/** Split an access URL into a credential-free base and a Basic auth header. */
export function parseAccessUrl(accessUrl: string): { base: string; authorization: string } {
  let u: URL;
  try {
    u = new URL(accessUrl);
  } catch {
    throw new SimplefinError("SIMPLEFIN_ACCESS_URL is not a valid URL");
  }
  if (u.protocol !== "https:" && u.hostname !== "127.0.0.1" && u.hostname !== "localhost") {
    throw new SimplefinError("SIMPLEFIN_ACCESS_URL must use https");
  }
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);
  u.username = "";
  u.password = "";
  return { base: u.toString().replace(/\/$/, ""), authorization: `Basic ${btoa(`${user}:${pass}`)}` };
}

export async function fetchAccounts(
  accessUrl: string,
  opts: { startDate: Date; fetch?: typeof fetch },
): Promise<SimplefinAccountSet> {
  const { base, authorization } = parseAccessUrl(accessUrl);
  const qs = new URLSearchParams({ version: "2", "start-date": String(Math.floor(opts.startDate.getTime() / 1000)) });
  const res = await (opts.fetch ?? fetch)(`${base}/accounts?${qs}`, {
    headers: { Authorization: authorization, Accept: "application/json" },
    signal: AbortSignal.timeout(120_000),
  });
  if (res.status === 403) throw new SimplefinError("SimpleFIN rejected the credentials (access revoked or wrong URL)", 403);
  if (res.status === 402) throw new SimplefinError("SimpleFIN subscription payment required", 402);
  if (!res.ok) throw new SimplefinError(`SimpleFIN /accounts: HTTP ${res.status}`, res.status);
  return (await res.json()) as SimplefinAccountSet;
}

/** Epoch seconds -> YYYY-MM-DD in the given IANA timezone. */
export function epochToDate(epoch: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(epoch * 1000));
}

export function simplefinErrors(set: SimplefinAccountSet): string[] {
  return [...(set.errlist ?? []).map((e) => `${e.code}: ${e.msg}`), ...(set.errors ?? [])];
}

export function normaliseSimplefin(set: SimplefinAccountSet, tz: string): BankAccountData[] {
  const connName = new Map((set.connections ?? []).map((c) => [c.conn_id, c.name]));
  return set.accounts
    .filter((a) => a.currency.toUpperCase() === "USD")
    .map((a) => {
      const org = (a.conn_id && connName.get(a.conn_id)) || a.org?.name;
      return {
        externalKey: a.id,
        name: org && !a.name.toLowerCase().includes(org.toLowerCase()) ? `${org} ${a.name}` : a.name,
        kindHint: /credit|card|visa|mastercard|amex/i.test(a.name) ? "credit" : /brokerage|ira|401k|invest|roth/i.test(a.name) ? "investment" : null,
        balance: { amount: M.parse(a.balance), asOf: epochToDate(a["balance-date"], tz) },
        records: (a.transactions ?? [])
          .filter((t) => !t.pending && t.posted > 0)
          .map((t) => ({
            externalId: t.id,
            date: epochToDate(t.posted, tz),
            amount: M.parse(t.amount),
            payee: (t.payee || t.description || "Unknown").trim(),
            memo: t.payee && t.description && t.payee !== t.description ? t.description : (t.memo ?? null),
          })),
      };
    });
}
