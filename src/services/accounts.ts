import { ACCOUNT_KINDS, ENTITY_TYPES, nowIso, type AccountKind, type EntityType } from "../db";
import type { HledgerTransaction } from "../hledger/web";
import * as M from "../money";
import type { Money } from "../money";
import { accountSegment, KIND_PREFIX, slugify, uniqueSlug } from "../naming";
import { ServiceError, type ServiceContext } from "./context";

export interface AccountRow {
  slug: string;
  name: string;
  hledger_account: string;
  kind: AccountKind;
  default_entity: string;
  simplefin_id: string | null;
  status: "open" | "closed";
  created_at: string;
}

export interface EntityRow {
  slug: string;
  name: string;
  type: EntityType;
  status: "active" | "archived";
  created_at: string;
}

const ENTITY_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function getEntity(ctx: ServiceContext, slug: string): EntityRow | null {
  return ctx.db.query("SELECT * FROM entities WHERE slug = ?").get(slug) as EntityRow | null;
}

/** Return the entity, creating it (type `personal` unless given) if it doesn't exist. */
export function ensureEntity(ctx: ServiceContext, slug: string, type: EntityType = "personal"): { entity: EntityRow; created: boolean } {
  if (!ENTITY_SLUG_RE.test(slug)) throw new ServiceError(`invalid entity slug ${JSON.stringify(slug)}`);
  if (!ENTITY_TYPES.includes(type)) throw new ServiceError(`invalid entity type ${JSON.stringify(type)}`);
  const existing = getEntity(ctx, slug);
  if (existing) return { entity: existing, created: false };
  ctx.db
    .query("INSERT INTO entities (slug, name, type, created_at) VALUES (?, ?, ?, ?)")
    .run(slug, slug, type, nowIso());
  return { entity: getEntity(ctx, slug)!, created: true };
}

export function getAccount(ctx: ServiceContext, slug: string): AccountRow | null {
  return ctx.db.query("SELECT * FROM accounts WHERE slug = ?").get(slug) as AccountRow | null;
}

export function listAccounts(ctx: ServiceContext): AccountRow[] {
  return ctx.db.query("SELECT * FROM accounts ORDER BY hledger_account").all() as AccountRow[];
}

export function findAccountBySource(ctx: ServiceContext, source: string, sourceAccountId: string): AccountRow | null {
  return ctx.db
    .query("SELECT a.* FROM accounts a JOIN account_sources s ON s.account_slug = a.slug WHERE s.source = ? AND s.source_account_id = ?")
    .get(source, sourceAccountId) as AccountRow | null;
}

export function linkAccountSource(ctx: ServiceContext, source: string, sourceAccountId: string, slug: string): void {
  ctx.db
    .query("INSERT OR REPLACE INTO account_sources (source, source_account_id, account_slug) VALUES (?, ?, ?)")
    .run(source, sourceAccountId, slug);
}

export function createAccount(
  ctx: ServiceContext,
  input: { name: string; kind: AccountKind; entity: string; status?: "open" | "closed"; prefix?: string },
): AccountRow {
  if (!ACCOUNT_KINDS.includes(input.kind)) throw new ServiceError(`invalid account kind ${JSON.stringify(input.kind)}`);
  if (!getEntity(ctx, input.entity)) throw new ServiceError(`unknown entity ${JSON.stringify(input.entity)}`, 404);
  const taken = (s: string) => ctx.db.query("SELECT 1 FROM accounts WHERE slug = ?").get(s) !== null;
  const slug = uniqueSlug(slugify(input.name), taken);
  const base = `${input.prefix ?? KIND_PREFIX[input.kind]}:${accountSegment(input.name)}`;
  const hTaken = (h: string) => ctx.db.query("SELECT 1 FROM accounts WHERE hledger_account = ?").get(h) !== null;
  let hledgerAccount = base;
  for (let i = 2; hTaken(hledgerAccount); i++) hledgerAccount = `${base}${i}`;
  ctx.db
    .query("INSERT INTO accounts (slug, name, hledger_account, kind, default_entity, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(slug, input.name, hledgerAccount, input.kind, input.entity, input.status ?? "open", nowIso());
  return getAccount(ctx, slug)!;
}

/** Sum postings per hledger account (exact account names, no subaccount rollup). */
export function balancesFrom(txns: HledgerTransaction[]): Map<string, Money> {
  const out = new Map<string, Money>();
  for (const t of txns) {
    for (const p of t.tpostings) {
      for (const a of p.pamount) {
        if (a.acommodity !== "$") continue;
        out.set(p.paccount, M.add(out.get(p.paccount) ?? M.ZERO, M.fromHledgerQuantity(a.aquantity)));
      }
    }
  }
  return out;
}

export async function listAccountsWithBalances(ctx: ServiceContext) {
  const balances = balancesFrom(await ctx.hledger.transactions());
  return listAccounts(ctx).map((a) => {
    const b = balances.get(a.hledger_account) ?? M.ZERO;
    return { ...a, balance_cents: M.toCents(b), balance: M.format(b) };
  });
}
