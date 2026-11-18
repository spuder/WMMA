# WMMA (Where My Money At) — Build Spec

Self-hosted, open-source (MIT) personal and multi-business finance app. Replaces YNAB and Monarch. Priorities: beautiful reports, budgets, multiple businesses with P&L statements, and AI access over MCP.

Build one milestone at a time (see the end). Each milestone ends with passing tests and a working Docker image. Ask before deviating from a decision marked **Decided**.

---

## 1. Decided Stack

| Area | Decision |
| --- | --- |
| Language | TypeScript on Bun, compiled to a single executable |
| Accounting engine | hledger. Plain-text journals are the source of truth for money |
| hledger access | `hledger-web` runs as a background service bound to `127.0.0.1`. WMMA reads its JSON API; WMMA writes journal files directly; hledger-web reloads on change |
| App state / cache | SQLite (`bun:sqlite`), rebuildable from the journals |
| Deploy | One Docker image (Bun executable + hledger + hledger-web), one `/data` volume, Docker Compose |
| Interfaces | REST API + MCP server on one shared service layer; mobile-first web UI last |
| Categorization | Mapping → rules → Jev (TypeSafe's hosted decision model) → review queue |
| Money | Integer cents behind a branded `Money` type; all math in one tested module; USD only in V1 |
| Auth | Tailscale identity headers (via Tailscale Serve); no login screen; allowlist of Tailscale users from env |
| Secrets | Environment variables from Docker Compose (sourced from 1Password at startup). Jev key may also be set in the UI |
| Backups | User's responsibility; WMMA does not manage git for data |
| License | MIT |

Rejected: Go, Rust (runner-up), Bend 2, Beancount, n8n for core logic, Supabase.

## 2. Hard Rules

- **No user data in the code repo.** Ship a `.gitignore` that excludes `data/`, `*.journal` outside fixtures, `*.db`, `.env`.
- **Journals are written only by WMMA.** No hand-editing is supported.
- **Raw imports are never modified.** Every import can be re-run; re-running adds zero duplicates.
- **Never use floats for money.** Parse to integer cents at the boundary.
- **hledger-web and the app must not be reachable except through Tailscale Serve.** Bind to localhost or a private Docker network; header-based auth is only safe that way.
- Every write (UI, REST, MCP) is appended to `audit.log` with actor, operation, inputs, before/after.

## 3. Data Model

### Data folder

```
/data
  imports/                 raw files, never modified (ynab/, qfx/, csv/, simplefin/, reihub/)
  journals/
    main.journal           includes everything below
    accounts.journal       account open/close directives
    prices.journal         asset valuations (V2: crypto prices)
    budgets.journal        periodic transactions for budgets
    accounts/<slug>.journal  one per bank, credit, investment, or asset account
  wmma.db                  SQLite: app state + cache
  audit.log
```

### Account naming

- Accounts do **not** encode the business. Example: `Expenses:Shipping`, `Assets:Checking:ChaseBiz`.
- The business lives in the `entity` tag on each transaction.
- Asset accounts: `Assets:Vehicles:<name>`, `Assets:RealEstate:<name>`, `Assets:Investments:<name>`.
- Unrealized value changes post to `Equity:Unrealized`.
- Uncategorized income lands in `Income:Uncategorized`.

### Transaction tags (hledger)

| Tag | Meaning |
| --- | --- |
| `wmma_id` | stable WMMA ID (ULID) |
| `source` | ynab, qfx, csv, simplefin, reihub, manual |
| `source_id` | upstream ID or content hash; used for de-duplication |
| `entity` | entity slug; defaults from the account's default entity, overridable per transaction |
| `orig_category` | category from the source system, verbatim |
| `cat_by` | mapping, rule, jev, swipe, manual |
| `jev_conf` | Jev confidence 0–1 when Jev chose the category |

### SQLite tables

| Table | Key columns |
| --- | --- |
| `entities` | slug, name, type (`personal`, `schedule_c`, `s_corp_1120s`, `partnership_1065`, `schedule_e`), status (`active`, `archived`) |
| `accounts` | slug, name, hledger_account, kind (`bank`, `credit`, `investment`, `vehicle`, `real_estate`, `other_asset`, `loan`), default_entity, simplefin_id, status |
| `mappings` | source, source_category, target_account |
| `rules` | id, match (payee pattern, amount range, account), target_account, entity_override, created_from (`swipe`, `manual`), hit_count |
| `swipe_counts` | payee_key, target_account, accepted_count |
| `review_queue` | wmma_id, jev_choices (top 3 with probabilities), status (`pending`, `accepted`, `changed`) |
| `import_runs` | id, source, file, started, finished, added, skipped_duplicates, errors |
| `settings` | key, value (non-secret only) |
| `cache_*` | rebuilt from hledger-web JSON for fast reports |

### Entity types → category templates

Each entity type ships a default Income/Expenses tree whose leaves match its tax form lines:
- `schedule_c` — Schedule C lines (sole prop / single-member LLC)
- `s_corp_1120s` — Form 1120-S lines
- `partnership_1065` — Form 1065 lines (partnerships issuing K-1s)
- `schedule_e` — Schedule E rental lines
- `personal` — a simple personal tree

Templates only organize categories so reports line up with forms. WMMA does not file taxes.

### Entities lifecycle

- Add: create entity + its template accounts (`open` directives).
- Archive: set status `archived`, `close` its exclusively-owned accounts as of a date. History stays and still shows in past reports. UI hides archived entities by default.

## 4. Importers

All importers: store the raw file under `imports/`, produce journal entries with `source_id`, skip duplicates, record an `import_runs` row, then run categorization.

| Importer | Notes |
| --- | --- |
| YNAB API | Personal access token from env. Stable IDs, linked transfers, splits. Asks whether to also import past monthly budget amounts |
| YNAB CSV | Register export (+ optional plan export for budgets). For users who left YNAB but kept exports. Same output as the API importer |
| QFX/OFX | Parse in TypeScript (write a small parser if no solid library). Use `FITID` as `source_id` |
| Generic CSV | Column-mapping config per bank; content hash as `source_id` |
| SimpleFIN | Access URL from env. Daily scheduled pull + manual refresh endpoint. Investment balances where available |
| REI Hub | Import exports for rental properties; keep its categories via `mappings` |

YNAB specifics:
- YNAB accounts → `Assets` or `Liabilities` accounts; user assigns each a default entity on first import (screen, saved to `accounts`).
- Categories import one to one as `Expenses:<Group>:<Category>`; original kept in `orig_category`; users reshape via `mappings` and regenerate.
- Transfers (`Transfer : <account>` payees) → one entry between two accounts, de-duplicated by ID.
- Splits → one transaction, multiple postings.
- `Inflow: Ready to Assign` → `Income:Uncategorized`, tagged with the account's entity; rules/Jev move it later.
- Cross-account and cross-entity duplicates must not double-count.

## 5. Categorization Pipeline

1. **Mapping** — source category → account, if the source supplied one.
2. **Rules** — deterministic match on payee / amount / account.
3. **Jev** — send transaction + allowed category list (the entity's accounts). Confidence ≥ 0.90 → apply (`cat_by: jev`). Below → review queue with Jev's top 3.
4. **Review queue** — resolved by the user (swipe UI, REST, or MCP).

Learning: when the same payee is accepted into the same category **3 times**, create a rule (`created_from: swipe`).

Jev failures or a missing key → transaction goes to the review queue; the pipeline never blocks an import.

## 6. Budgets, Transfers, Assets

- **Budgets:** monthly amount per category per entity, stored as hledger periodic transactions. Unspent money **rolls over** month to month. Report = budget vs. actual with rollover.
- **Transfers:** between accounts, including between entities (due-to / due-from accounts) so they never appear as income or expense on a P&L.
- **Assets:** manual accounts for vehicles, primary residence, rental properties. A valuation = value as of a date → balance entry, difference to `Equity:Unrealized`. Valuation changes never affect P&L.
- **Net worth:** assets minus liabilities over time, per entity and combined.

## 7. REST API (`/api/v1`)

REST and MCP call the same service layer. All writes: journal write → `audit.log` → cache rebuild.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/entities` | list (filter by status) |
| POST | `/entities` | add (name, type) |
| PATCH | `/entities/:slug` | rename, change type, archive |
| GET | `/accounts` | list with balances |
| POST | `/accounts` | add (bank, asset, loan) |
| PATCH | `/accounts/:slug` | set default entity, close |
| GET | `/transactions` | query by date, account, entity, category, text |
| PATCH | `/transactions/:id` | recategorize, retag entity, edit memo |
| POST | `/transactions/:id/split` | split into postings |
| POST | `/transfers` | record a transfer (incl. between entities) |
| GET | `/review` | review queue with Jev's top choices |
| POST | `/review/:id` | accept or change (counts as a swipe) |
| GET/POST | `/rules` | list / create |
| GET/PUT | `/mappings` | view / edit |
| POST | `/imports` | upload a file (ynab-csv, qfx, csv, reihub) |
| POST | `/imports/ynab-api` | pull history (option: include budget amounts) |
| POST | `/sync/simplefin` | manual refresh |
| GET | `/import-runs` | history and results |
| GET/PUT | `/budgets` | monthly amounts per category and entity |
| POST | `/valuations` | asset value as of a date |
| GET | `/reports/pnl` | P&L by entity and date range |
| GET | `/reports/cashflow` | income → expense flows (Sankey-ready nodes/links) |
| GET | `/reports/budget` | budget vs. actual with rollover |
| GET | `/reports/networth` | over time, per entity and combined |
| GET | `/reports/spending` | by category |
| GET/PUT | `/settings` | non-secret settings; Jev key if not in env |

## 8. MCP Server (read + write)

- **Read:** `list_entities`, `list_accounts`, `search_transactions`, `get_pnl`, `get_cashflow`, `get_budget_vs_actual`, `get_net_worth`, `get_spending_by_category`, `get_review_queue`
- **Write:** `categorize_transaction`, `set_entity`, `split_transaction`, `create_rule`, `update_mapping`, `set_budget`, `record_valuation`, `record_transfer`, `run_simplefin_sync`
- Use the official MCP TypeScript SDK. Same Tailscale auth as REST. Every write audited with before/after.

## 9. Web UI (last)

- Mobile-first web app served by the same Bun process.
- Screens: dashboard, reports (P&L, cash-flow Sankey, budget vs. actual, net worth, spending donut, income vs. expense trend), transactions, entities/accounts, imports, settings (Jev key field).
- Visual goal: clean and beautiful — Monarch-style charts plus YNAB-style graphs. Charting library is your choice.
- **Swipe game mode** for the review queue: one card per transaction showing Jev's top pick. Swipe right = accept. Swipe left = show the next likely categories to tap. Accepts feed the 3-swipe rule learning.

## 10. Environment Variables

| Variable | Purpose |
| --- | --- |
| `WMMA_DATA_DIR` | default `/data` |
| `WMMA_ALLOWED_USERS` | comma-separated Tailscale login names |
| `WMMA_TZ` | timezone for scheduling |
| `JEV_API_KEY` | Jev API key (optional; can be set in UI) |
| `SIMPLEFIN_ACCESS_URL` | SimpleFIN access URL |
| `YNAB_TOKEN` | YNAB personal access token (optional) |
| `SIMPLEFIN_SYNC_CRON` | default daily |

## 11. Milestones

1. **Skeleton**
   - Bun + TS project, Dockerfile (Bun executable + hledger-web on localhost), Compose file, `/data` volume, `.gitignore`
   - Tailscale identity middleware with allowlist
   - `Money` module with unit tests; journal writer with tests
   - Done when: container starts, hledger-web serves an empty journal, a request without an allowed Tailscale identity gets 401/403
2. **YNAB import** (API + CSV)
   - Done when: re-running the same import adds zero transactions, and account balances match YNAB's
3. **QFX, CSV, SimpleFIN**
   - Done when: overlapping imports from different sources create no duplicates
4. **Categorization**
   - Done when: a re-import categorizes known payees with zero Jev calls; low-confidence items land in the queue; 3 accepts create a rule
5. **Entities, budgets, transfers, assets, REI Hub**
   - Done when: an archived entity's history still appears in past reports; inter-entity transfers don't affect either P&L; valuations don't affect P&L
6. **REST API + MCP**
   - Done when: an AI client produces a P&L for one entity and recategorizes a transaction over MCP, and both appear in `audit.log`
7. **Web UI + swipe mode**
   - Done when: the review queue can be cleared entirely on a phone

Use small synthetic fixtures for tests (never real financial data).

## 12. Non-Goals for V1

- Native desktop or mobile apps
- Currencies other than USD; crypto (V2: hledger commodities with price history)
- Hand-editing journals
- Multi-user households beyond the Tailscale allowlist
- n8n integration (later, via REST)
- Tax filing

## 13. Open Questions

Raised during spec review. Resolve before the milestone noted.

1. **Posting-level `entity` tags (before M1 journal writer / M5).** A transaction-level `entity` tag can't represent inter-entity transfers (due-to / due-from) or a split across businesses. Proposal: allow `entity` on individual postings; a posting inherits the transaction's `entity` when it has none.
2. **Cross-source de-duplication (M3) — resolved.** Same source: by `source_id`. Different source: same account + amount + date within ±3 days; a unique closest match is merged, ties across different dates go to a review list (`GET /api/v1/duplicates`). Precedence for the merged entry's primary id and date: SimpleFIN > QFX > CSV > YNAB; the other ids are kept in an `alt_ids` tag. Bank `source_id`s are `<account-slug>/<upstream id>`, so each side of a transfer can be matched by its own account's feed.
3. **Budget rollover (before M5).** hledger's budget report does not roll unspent amounts forward. Rollover must be computed by WMMA from periodic transactions + actuals.
4. **Jev key storage (before M6).** `settings` is non-secret only, yet the Jev key may be set in the UI. Decide where it lives (e.g. a separate `secrets` table encrypted with a key from env, or a `0600` file under `/data`).
5. **hledger-web write capability (M1) — resolved.** hledger-web has its own add-transaction form. WMMA runs it with `--allow=view` (the flag in hledger 1.52; older docs call it `--capabilities`) to enforce "journals are written only by WMMA".
6. **Jev API reference (before M4).** Link Jev's API docs and confirm the request/response shape and whether 0.90 is a sensible confidence threshold for its scores.

### Implementation notes (decisions taken while building; revisit if wrong)

- **M2 — YNAB "Starting Balance"** transactions post to `Equity:OpeningBalances` instead of `Income:Uncategorized`, so opening balances never show up as income on a P&L.
- **M2 — uncategorised lines in tracking asset accounts** (e.g. a house's "Market Value Adjustment") post to `Equity:Unrealized`, per §6.
- **M2 — split-to-split transfers** (a split line in one account transferring to a split line in another) post both sides through `Equity:Transfers`, which nets to zero; this is the only way to emit each split once without double-counting.
- **M2 — past budget amounts** from YNAB are deferred to M5, where budgets (and rollover, §13.3) are built. The importers will gain an `includeBudgets` option then.
- **M2 — YNAB API** now lives under `/plans/{id}` (formerly budgets), and `GET .../transactions` returns only the last year unless `since_date` is passed; WMMA passes `since_date=1900-01-01`.
- **M2 — CLI.** `wmma import ...` inside the container calls the local REST API, so the server stays the only journal writer.
- **M3 — bank imports don't fuzzy-match YNAB imports against bank data in reverse.** YNAB history is expected to be imported first; QFX/CSV/SimpleFIN records then merge into matching YNAB entries. A YNAB import run after bank data only de-duplicates by YNAB id.
- **M3 — transfers seen only through bank feeds** (e.g. a card payment appearing in both the checking and the card feed) land as two uncategorised entries; turning them into one transfer is categorisation work (M4).
- **M3 — SimpleFIN** syncs from 14 days before the last sync (first sync: 90 days back), excludes pending transactions, and records reported balances in `balance_snapshots`. Schedule: `SIMPLEFIN_SYNC_CRON` (default `0 6 * * *`, in `WMMA_TZ`).
