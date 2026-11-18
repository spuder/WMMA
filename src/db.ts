/**
 * SQLite app state (SPEC §3). Schema changes are append-only migrations keyed
 * by PRAGMA user_version.
 */
import { Database } from "bun:sqlite";

export const ENTITY_TYPES = ["personal", "schedule_c", "s_corp_1120s", "partnership_1065", "schedule_e"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const ACCOUNT_KINDS = ["bank", "credit", "investment", "vehicle", "real_estate", "other_asset", "loan"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(", ");

const MIGRATIONS: string[] = [
  `
  CREATE TABLE entities (
    slug        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL CHECK (type IN (${list(ENTITY_TYPES)})),
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_at  TEXT NOT NULL
  );
  CREATE TABLE accounts (
    slug            TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    hledger_account TEXT NOT NULL UNIQUE,
    kind            TEXT NOT NULL CHECK (kind IN (${list(ACCOUNT_KINDS)})),
    default_entity  TEXT NOT NULL REFERENCES entities(slug),
    simplefin_id    TEXT UNIQUE,
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    created_at      TEXT NOT NULL
  );
  -- Upstream account identities (YNAB account id, CSV account name, ...) -> WMMA account.
  CREATE TABLE account_sources (
    source            TEXT NOT NULL,
    source_account_id TEXT NOT NULL,
    account_slug      TEXT NOT NULL REFERENCES accounts(slug),
    PRIMARY KEY (source, source_account_id)
  );
  CREATE TABLE mappings (
    source          TEXT NOT NULL,
    source_category TEXT NOT NULL,
    target_account  TEXT NOT NULL,
    PRIMARY KEY (source, source_category)
  );
  CREATE TABLE import_runs (
    id                 TEXT PRIMARY KEY,
    source             TEXT NOT NULL,
    file               TEXT,
    actor              TEXT NOT NULL,
    started            TEXT NOT NULL,
    finished           TEXT,
    added              INTEGER NOT NULL DEFAULT 0,
    skipped_duplicates INTEGER NOT NULL DEFAULT 0,
    errors             TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  -- Incoming records that matched more than one existing entry (SPEC §13.2).
  CREATE TABLE duplicate_candidates (
    id           TEXT PRIMARY KEY,
    run_id       TEXT NOT NULL,
    source       TEXT NOT NULL,
    source_id    TEXT NOT NULL,
    account_slug TEXT NOT NULL REFERENCES accounts(slug),
    record       TEXT NOT NULL,
    candidates   TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'imported', 'merged', 'discarded')),
    created_at   TEXT NOT NULL,
    resolved_at  TEXT,
    UNIQUE (source, source_id)
  );
  -- Column mappings for generic bank CSVs.
  CREATE TABLE csv_profiles (
    name    TEXT PRIMARY KEY,
    config  TEXT NOT NULL,
    updated TEXT NOT NULL
  );
  -- Balances reported by a source (SimpleFIN, OFX LEDGERBAL), for checks and net worth.
  CREATE TABLE balance_snapshots (
    account_slug  TEXT NOT NULL REFERENCES accounts(slug),
    as_of         TEXT NOT NULL,
    source        TEXT NOT NULL,
    balance_cents INTEGER NOT NULL,
    PRIMARY KEY (account_slug, as_of, source)
  );
  `,
];

export function openDb(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

export function migrate(db: Database): void {
  const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}

export const nowIso = (): string => new Date().toISOString();
