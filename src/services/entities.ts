/** Entities lifecycle (SPEC §3) and account management. */
import { ACCOUNT_KINDS, ENTITY_TYPES, nowIso, type AccountKind, type EntityType } from "../db";
import { validateDate } from "../journal/format";
import { accountType, slugify, uniqueSlug } from "../naming";
import { FORM_TAG, TEMPLATES } from "../templates";
import { createAccount, getAccount, getEntity, listAccounts, type AccountRow, type EntityRow } from "./accounts";
import { ServiceError, type ServiceContext } from "./context";
import { checkedAssetDetails, checkedLinkedLoan, isPhysicalAsset, type AssetDetails } from "./assets";
import { recordValuation } from "./ledger";
import { normalizeDomain } from "./logos";

export function listEntities(ctx: ServiceContext, status: "active" | "archived" | "all" = "active"): EntityRow[] {
  return status === "all"
    ? (ctx.db.query("SELECT * FROM entities ORDER BY name").all() as EntityRow[])
    : (ctx.db.query("SELECT * FROM entities WHERE status = ? ORDER BY name").all(status) as EntityRow[]);
}

/** Declare an entity type's template accounts, tagged with their form lines. */
export async function applyTemplate(ctx: ServiceContext, type: EntityType): Promise<string[]> {
  const tag = FORM_TAG[type];
  const lines = TEMPLATES[type];
  await ctx.store.declareAccounts(
    lines.map((l) => ({ name: l.account, type: accountType(l.account), ...(tag && l.line ? { tags: { [tag]: l.line } } : {}) })),
  );
  return lines.map((l) => l.account);
}

/**
 * Declare the template categories of every entity type in use, so categories
 * added to a template later (e.g. new income categories) reach existing
 * profiles. Idempotent; runs at startup.
 */
export async function syncTemplates(ctx: ServiceContext): Promise<void> {
  for (const type of new Set(listEntities(ctx, "all").map((e) => e.type))) await applyTemplate(ctx, type);
}

export async function addEntity(ctx: ServiceContext, actor: string, input: { name: string; type: EntityType; slug?: string; color?: string }): Promise<EntityRow> {
  const name = input.name?.trim();
  if (!name) throw new ServiceError("name is required");
  if (!ENTITY_TYPES.includes(input.type)) throw new ServiceError(`type must be one of ${ENTITY_TYPES.join(", ")}`);
  const taken = (s: string) => getEntity(ctx, s) !== null;
  let slug: string;
  if (input.slug) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.slug)) throw new ServiceError("slug must be lower-case letters, digits and dashes");
    if (taken(input.slug)) throw new ServiceError(`entity ${JSON.stringify(input.slug)} already exists`, 409);
    slug = input.slug;
  } else {
    slug = uniqueSlug(slugify(name, "entity"), taken);
  }
  const color = checkedColor(input.color);
  ctx.db.query("INSERT INTO entities (slug, name, type, created_at, color) VALUES (?, ?, ?, ?, ?)").run(slug, name, input.type, nowIso(), color);
  const accounts = await applyTemplate(ctx, input.type);
  const entity = getEntity(ctx, slug)!;
  await ctx.audit.append({ actor, operation: "entity.add", inputs: input, before: null, after: { entity, templateAccounts: accounts.length } });
  return entity;
}

/** Close an account as of a date: status in SQLite, `closed:` tag on its directive. */
async function closeAccount(ctx: ServiceContext, a: AccountRow, date: string): Promise<void> {
  ctx.db.query("UPDATE accounts SET status = 'closed' WHERE slug = ?").run(a.slug);
  await ctx.store.declareAccounts([{ name: a.hledger_account, type: accountType(a.hledger_account), tags: { closed: date } }]);
}

export async function updateEntity(
  ctx: ServiceContext,
  actor: string,
  slug: string,
  patch: { name?: string; type?: EntityType; color?: string | null; archive?: { date: string } },
): Promise<{ entity: EntityRow; closedAccounts: string[] }> {
  const before = getEntity(ctx, slug);
  if (!before) throw new ServiceError(`unknown entity ${JSON.stringify(slug)}`, 404);
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw new ServiceError("name must not be empty");
    ctx.db.query("UPDATE entities SET name = ? WHERE slug = ?").run(patch.name.trim(), slug);
  }
  if (patch.type !== undefined) {
    if (!ENTITY_TYPES.includes(patch.type)) throw new ServiceError(`type must be one of ${ENTITY_TYPES.join(", ")}`);
    ctx.db.query("UPDATE entities SET type = ? WHERE slug = ?").run(patch.type, slug);
    await applyTemplate(ctx, patch.type);
  }
  if (patch.color !== undefined) {
    ctx.db.query("UPDATE entities SET color = ? WHERE slug = ?").run(checkedColor(patch.color), slug);
  }
  const closedAccounts: string[] = [];
  if (patch.archive) {
    try {
      validateDate(patch.archive.date);
    } catch {
      throw new ServiceError("archive.date must be YYYY-MM-DD");
    }
    if (before.status === "archived") throw new ServiceError("entity is already archived", 409);
    ctx.db.query("UPDATE entities SET status = 'archived' WHERE slug = ?").run(slug);
    // Accounts the entity owns exclusively (it is their default entity).
    for (const a of listAccounts(ctx).filter((x) => x.default_entity === slug && x.status === "open")) {
      await closeAccount(ctx, a, patch.archive.date);
      closedAccounts.push(a.slug);
    }
  }
  const entity = getEntity(ctx, slug)!;
  await ctx.audit.append({ actor, operation: "entity.update", inputs: { slug, ...patch }, before, after: { entity, closedAccounts } });
  return { entity, closedAccounts };
}

function checkedColor(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (!/^#[0-9a-fA-F]{6}$/.test(raw)) throw new ServiceError("color must be a six-digit hex color");
  return raw.toLowerCase();
}

export async function addAccount(
  ctx: ServiceContext,
  actor: string,
  input: {
    name: string;
    kind: AccountKind;
    entity: string;
    websiteUrl?: string | null;
    details?: unknown;
    linkedLoan?: string | null;
    /** Opening value for an asset, recorded as a valuation. */
    value?: { value: unknown; date?: unknown };
  },
): Promise<AccountRow> {
  if (!input.name?.trim()) throw new ServiceError("name is required");
  if (!ACCOUNT_KINDS.includes(input.kind)) throw new ServiceError(`kind must be one of ${ACCOUNT_KINDS.join(", ")}`);
  const details: AssetDetails | null = checkedAssetDetails(input.kind, input.details);
  const linkedLoan = checkedLinkedLoan(ctx, null, input.kind, input.linkedLoan);
  if (input.value !== undefined && !isPhysicalAsset(input.kind) && input.kind !== "investment") {
    throw new ServiceError("an opening value is only for investment, vehicle, real estate and other asset accounts");
  }
  const entity = getEntity(ctx, input.entity);
  if (!entity) throw new ServiceError(`unknown entity ${JSON.stringify(input.entity)}`, 404);
  if (entity.status === "archived") throw new ServiceError("entity is archived", 409);
  const websiteUrl = checkedWebsiteUrl(input.websiteUrl);
  let account = createAccount(ctx, { name: input.name.trim(), kind: input.kind, entity: input.entity, websiteUrl });
  if (details || linkedLoan) {
    ctx.db.query("UPDATE accounts SET details = ?, linked_loan = ? WHERE slug = ?").run(details ? JSON.stringify(details) : null, linkedLoan, account.slug);
    account = getAccount(ctx, account.slug)!;
  }
  await ctx.store.declareAccounts([{ name: account.hledger_account, type: accountType(account.hledger_account) }]);
  await ctx.audit.append({ actor, operation: "account.add", inputs: input, before: null, after: account });
  if (input.value !== undefined) {
    await recordValuation(ctx, actor, { account: account.slug, date: input.value.date ?? new Date().toISOString().slice(0, 10), value: input.value.value });
  }
  return account;
}

export async function updateAccount(
  ctx: ServiceContext,
  actor: string,
  slug: string,
  patch: { defaultEntity?: string; websiteUrl?: string | null; logoDomain?: string | null; close?: { date: string }; details?: unknown; linkedLoan?: string | null },
): Promise<AccountRow> {
  const before = getAccount(ctx, slug);
  if (!before) throw new ServiceError(`unknown account ${JSON.stringify(slug)}`, 404);
  const websiteUrl = patch.websiteUrl === undefined ? undefined : checkedWebsiteUrl(patch.websiteUrl);
  const clearLogo = patch.logoDomain === null || patch.logoDomain?.trim() === "";
  const logoDomain = patch.logoDomain === undefined ? undefined : clearLogo ? null : normalizeDomain(patch.logoDomain!);
  if (logoDomain === null && !clearLogo) throw new ServiceError(`${JSON.stringify(patch.logoDomain)} is not a website domain`);
  // Validate everything before writing anything.
  if (patch.defaultEntity !== undefined && !getEntity(ctx, patch.defaultEntity)) throw new ServiceError(`unknown entity ${JSON.stringify(patch.defaultEntity)}`, 404);
  const details = patch.details === undefined ? undefined : checkedAssetDetails(before.kind, patch.details);
  const linkedLoan = patch.linkedLoan === undefined ? undefined : checkedLinkedLoan(ctx, slug, before.kind, patch.linkedLoan);
  if (details !== undefined) ctx.db.query("UPDATE accounts SET details = ? WHERE slug = ?").run(details ? JSON.stringify(details) : null, slug);
  if (linkedLoan !== undefined) ctx.db.query("UPDATE accounts SET linked_loan = ? WHERE slug = ?").run(linkedLoan, slug);
  if (patch.defaultEntity !== undefined) {
    ctx.db.query("UPDATE accounts SET default_entity = ? WHERE slug = ?").run(patch.defaultEntity, slug);
  }
  if (websiteUrl !== undefined) {
    ctx.db.query("UPDATE accounts SET website_url = ? WHERE slug = ?").run(websiteUrl, slug);
  }
  if (logoDomain !== undefined) ctx.db.query("UPDATE accounts SET logo_domain = ? WHERE slug = ?").run(logoDomain, slug);
  if (patch.close) {
    try {
      validateDate(patch.close.date);
    } catch {
      throw new ServiceError("close.date must be YYYY-MM-DD");
    }
    await closeAccount(ctx, before, patch.close.date);
  }
  const after = getAccount(ctx, slug)!;
  await ctx.audit.append({ actor, operation: "account.update", inputs: { slug, ...patch }, before, after });
  return after;
}

function checkedWebsiteUrl(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) throw new Error("invalid URL");
    return url.toString();
  } catch {
    throw new ServiceError("websiteUrl must be a valid HTTPS URL");
  }
}
