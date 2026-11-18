/**
 * Physical assets (vehicles, real estate, other): descriptive details, the loan
 * owed against them, value history, and VIN decoding for vehicles.
 */
import type { AccountKind } from "../db";
import { validateDate } from "../journal/format";
import * as M from "../money";
import { getAccount, type AccountRow } from "./accounts";
import { ServiceError, type ServiceContext } from "./context";

export const ASSET_KINDS: readonly AccountKind[] = ["vehicle", "real_estate", "other_asset"];
export const isPhysicalAsset = (kind: AccountKind) => ASSET_KINDS.includes(kind);

export interface AssetDetails {
  year?: number;
  make?: string;
  model?: string;
  trim?: string;
  vin?: string;
  mileage?: number;
  mileageAsOf?: string;
  purchaseDate?: string;
  /** Decimal dollars, e.g. "32500.00". */
  purchasePrice?: string;
  address?: string;
  description?: string;
}

const FIELDS: Record<AccountKind, ReadonlyArray<keyof AssetDetails>> = {
  vehicle: ["year", "make", "model", "trim", "vin", "mileage", "mileageAsOf", "purchaseDate", "purchasePrice", "description"],
  real_estate: ["address", "purchaseDate", "purchasePrice", "description"],
  other_asset: ["description", "purchaseDate", "purchasePrice"],
  bank: [],
  credit: [],
  investment: [],
  loan: [],
};

/** 17 characters, no I, O or Q (ISO 3779). */
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

function text(v: unknown, field: string, max: number): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new ServiceError(`${field} must be a string`);
  const t = v.replace(/\s+/g, " ").trim();
  if (t.length > max) throw new ServiceError(`${field} must be at most ${max} characters`);
  return t || undefined;
}

function day(v: unknown, field: string): string | undefined {
  const t = text(v, field, 10);
  if (t === undefined) return undefined;
  try {
    validateDate(t);
  } catch {
    throw new ServiceError(`${field} must be YYYY-MM-DD`);
  }
  return t;
}

function int(v: unknown, field: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "string" ? Number(v.replace(/,/g, "")) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw new ServiceError(`${field} must be a whole number from ${min} to ${max}`);
  return n;
}

/** Validate details for an asset kind; unknown or wrong-kind fields are rejected. Returns null when empty. */
export function checkedAssetDetails(kind: AccountKind, raw: unknown): AssetDetails | null {
  if (raw === undefined || raw === null) return null;
  if (!isPhysicalAsset(kind)) throw new ServiceError("details are only for vehicle, real estate and other asset accounts");
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ServiceError("details must be an object");
  const allowed = new Set<string>(FIELDS[kind]);
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new ServiceError(`details.${k} is not used for ${kind.replace("_", " ")} accounts`);
  const r = raw as Record<string, unknown>;
  const vin = text(r.vin, "details.vin", 17)?.toUpperCase();
  if (vin !== undefined && !VIN_RE.test(vin)) throw new ServiceError("details.vin must be 17 letters and digits (no I, O or Q)");
  let purchasePrice: string | undefined;
  if (r.purchasePrice !== undefined && r.purchasePrice !== null && r.purchasePrice !== "") {
    try {
      const m = M.parse(String(r.purchasePrice).replace(/[$,]/g, ""));
      if (M.isNegative(m)) throw new Error("negative");
      purchasePrice = (M.toCents(m) / 100).toFixed(2);
    } catch {
      throw new ServiceError("details.purchasePrice must be a non-negative amount");
    }
  }
  const out: Record<string, unknown> = {
    year: int(r.year, "details.year", 1886, new Date().getUTCFullYear() + 2),
    make: text(r.make, "details.make", 60),
    model: text(r.model, "details.model", 60),
    trim: text(r.trim, "details.trim", 60),
    vin,
    mileage: int(r.mileage, "details.mileage", 0, 2_000_000),
    mileageAsOf: day(r.mileageAsOf, "details.mileageAsOf"),
    purchaseDate: day(r.purchaseDate, "details.purchaseDate"),
    purchasePrice,
    address: text(r.address, "details.address", 200),
    description: text(r.description, "details.description", 500),
  };
  const clean = Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as AssetDetails;
  return Object.keys(clean).length ? clean : null;
}

export function parseDetails(row: Pick<AccountRow, "details">): AssetDetails | null {
  if (!row.details) return null;
  try {
    return JSON.parse(row.details) as AssetDetails;
  } catch {
    return null;
  }
}

/** A linked loan must be an open loan account and not already linked to another asset. */
export function checkedLinkedLoan(ctx: ServiceContext, assetSlug: string | null, kind: AccountKind, loanSlug: string | null | undefined): string | null {
  if (loanSlug === undefined || loanSlug === null || loanSlug === "") return null;
  if (!isPhysicalAsset(kind)) throw new ServiceError("only vehicle, real estate and other asset accounts can have a linked loan");
  const loan = getAccount(ctx, loanSlug);
  if (!loan || loan.kind !== "loan") throw new ServiceError(`${JSON.stringify(loanSlug)} is not a loan account`, 404);
  if (loan.status !== "open") throw new ServiceError(`${loan.name} is closed`, 409);
  const other = ctx.db.query("SELECT name FROM accounts WHERE linked_loan = ? AND slug IS NOT ?").get(loanSlug, assetSlug) as { name: string } | null;
  if (other) throw new ServiceError(`${loan.name} is already linked to ${other.name}`, 409);
  return loanSlug;
}

/** Validate an odometer reading for a vehicle account (before anything is written). */
export function checkedMileage(account: AccountRow, mileage: unknown): number | undefined {
  if (mileage === undefined || mileage === null || mileage === "") return undefined;
  if (account.kind !== "vehicle") throw new ServiceError("mileage is only for vehicle accounts");
  return int(mileage, "mileage", 0, 2_000_000);
}

/** Record a newer odometer reading (older readings never overwrite a newer one). */
export function recordMileage(ctx: ServiceContext, account: AccountRow, miles: number, asOf: string): void {
  const details = parseDetails(account) ?? {};
  if (details.mileageAsOf && details.mileageAsOf > asOf) return;
  ctx.db.query("UPDATE accounts SET details = ? WHERE slug = ?").run(JSON.stringify({ ...details, mileage: miles, mileageAsOf: asOf }), account.slug);
}

export function valuationHistory(ctx: ServiceContext, slug: string): Array<{ date: string; value: string; value_cents: number }> {
  if (!getAccount(ctx, slug)) throw new ServiceError(`unknown account ${JSON.stringify(slug)}`, 404);
  const rows = ctx.db
    .query("SELECT as_of, balance_cents FROM balance_snapshots WHERE account_slug = ? AND source = 'valuation' ORDER BY as_of")
    .all(slug) as Array<{ as_of: string; balance_cents: number }>;
  return rows.map((r) => ({ date: r.as_of, value: M.format(M.cents(r.balance_cents)), value_cents: r.balance_cents }));
}

export interface DecodedVin {
  vin: string;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  bodyClass: string | null;
}

const titleCase = (s: string) => (/[a-z]/.test(s) ? s : s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()));

/** Decode a VIN with NHTSA vPIC (free, no key). Only the VIN is sent. */
export async function decodeVin(raw: string, fetchImpl: typeof fetch = fetch): Promise<DecodedVin> {
  const vin = raw.trim().toUpperCase();
  if (!VIN_RE.test(vin)) throw new ServiceError("A VIN is 17 letters and digits (no I, O or Q)");
  let res: Response;
  try {
    res = await fetchImpl(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${vin}?format=json`, {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ServiceError("Could not reach the NHTSA VIN decoder", 502);
  }
  if (!res.ok) throw new ServiceError(`NHTSA VIN decoder returned HTTP ${res.status}`, 502);
  const body = (await res.json().catch(() => null)) as { Results?: Array<Record<string, string>> } | null;
  const r = body?.Results?.[0];
  if (!r) throw new ServiceError("NHTSA VIN decoder returned no result", 502);
  const val = (k: string) => (r[k] && r[k]!.trim() && r[k] !== "Not Applicable" ? r[k]!.trim().slice(0, 60) : null);
  const year = Number(val("ModelYear"));
  const decoded: DecodedVin = {
    vin,
    year: Number.isInteger(year) && year > 1885 ? year : null,
    make: val("Make") && titleCase(val("Make")!),
    model: val("Model"),
    trim: val("Trim") ?? val("Series"),
    bodyClass: val("BodyClass"),
  };
  if (!decoded.make && !decoded.model) throw new ServiceError("NHTSA could not decode that VIN; check it, or enter the details yourself", 422);
  return decoded;
}
