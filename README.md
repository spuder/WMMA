<img src="assets/icon.svg" width="64" height="64" alt="">

# WMMA — Where My Money At

Self-hosted personal and multi-business finance: budgets, P&L per business, beautiful reports, and AI access over MCP. Plain-text [hledger](https://hledger.org) journals are the source of truth.

See [SPEC.md](SPEC.md) for the full design and milestones.

## Status

- **M1 skeleton:** Bun/TypeScript service, `Money` module, journal writer, Tailscale identity auth, hledger-web (read-only, localhost), Docker image and Compose file.
- **M2 YNAB import:** API and register-CSV importers. Re-running adds nothing; the result reports per-account balances against YNAB.
- **M7 web UI:** mobile-first app (dashboard, swipe review, activity, reports, accounts, imports, settings) served by the same binary.
- **M6 REST API + MCP:** transaction search/edit/split, mappings with regeneration, cash-flow / spending / net-worth reports, settings (Jev key stored encrypted), and an MCP server with 9 read and 9 write tools.
- **M5 entities, budgets, transfers, assets, REI Hub:** tax-form category templates per entity, archive with history kept, budgets with rollover, inter-entity transfers via due-to/due-from, asset valuations, REI Hub CSV, YNAB past budgets; P&L and budget reports.
- **M4 categorization:** rules → Jev (applied at ≥ 0.90 confidence) → review queue; 3 accepts of a payee create a rule. Runs after every import.
- **M3 bank imports:** QFX/OFX, generic CSV (per-bank column profiles), SimpleFIN (daily + on demand). Overlapping imports from different sources merge instead of duplicating.

## Importing from YNAB

Inside the container (the CLI talks to the running server):

```sh
# API (needs YNAB_TOKEN). Pulls full history of the last-used plan.
docker compose exec wmma wmma import ynab-api \
  --default-entity personal \
  --account "Acme Checking=bank:acme"

# Register CSV export
docker compose exec wmma wmma import ynab-csv /data/register.csv \
  --account "Chase Sapphire=credit"

docker compose exec wmma wmma import-runs
docker compose exec wmma wmma accounts
```

`--account "NAME=KIND[:ENTITY]"` sets the kind and default entity for an account the first time it is seen (CSV exports don't say whether an account is a credit card, so set those). Every import is safe to re-run.

## Bank imports

```sh
# QFX/OFX (bank or credit card). First time: --account SLUG links to an existing account,
# otherwise one is created from the statement.
wmma import qfx /data/chase-march.qfx

# Generic CSV: define a column profile once per bank, then import into an account.
echo '{"columns":{"date":"Date","payee":"Description","amount":"Amount"}}' > /data/chase.json
wmma csv-profile set chase /data/chase.json
wmma import csv /data/chase-march.csv --profile chase --account main-checking

# SimpleFIN (needs SIMPLEFIN_ACCESS_URL). Also runs on SIMPLEFIN_SYNC_CRON.
wmma sync simplefin

# Records that could match more than one existing transaction
wmma duplicates
wmma duplicate <id> merge --wmma-id <ID>   # or: import | discard
```

Profile fields: `columns.{date,payee,memo,amount | debit+credit,id}`, `dateFormat`, `invertAmount`, `delimiter`, `skipRows`.

### Connect SimpleFIN

In WMMA, open **Settings → SimpleFIN bank sync**, follow the link to SimpleFIN
Bridge, connect your bank, and copy the one-time Setup Token. Paste that token
into WMMA and select **Connect SimpleFIN**. WMMA claims it once and stores the
resulting Access URL encrypted; it does not display or log the Access URL.
This requires `WMMA_SECRET_KEY` (at least 16 characters). After connecting,
open **Imports** and select **Sync SimpleFIN now**. New bank accounts are
created automatically on the first sync; review them under **Accounts**.

To configure SimpleFIN outside the UI, exchange a Setup Token for an Access URL
using [SimpleFIN Bridge's instructions](https://beta-bridge.simplefin.org/info/developers),
then set `SIMPLEFIN_ACCESS_URL` in the server environment. This environment
setting takes precedence over the UI connection.

## Web UI

Open `https://wmma.<your-tailnet>.ts.net` on your phone or computer (add it to your home screen for an app-like feel).

- **Home**: net worth with trend, this month's income and spending, spending donut, income vs spending, recent activity
- **Review**: the swipe game. Swipe right to accept Jev's pick, left to choose another category (keyboard: → / ← / S). The 3rd accept of a payee teaches a rule
- **Activity**: search and filter transactions; tap one to change category, entity or memo, or split it
- **Reports**: P&L, cash-flow Sankey, budget vs actual with rollover (tap a category to set its budget), net worth, spending, 12-month trend
- **Accounts**, **Imports** (upload QFX / bank CSV / YNAB CSV / REI Hub, sync SimpleFIN or YNAB, resolve possible duplicates), **Settings** (Jev key, appearance)

Pick an entity (or "All entities") from the pill at the top of each screen.

### Try it locally with Docker

This runs WMMA in Docker and a small identity proxy on your computer. The proxy
stands in for Tailscale Serve during local testing. The container port is
published on host loopback, and the proxy also listens on `127.0.0.1`; this
setup is only for local development, not deployment.
Docker must be installed and running. The example image targets `linux/amd64`
because that is the architecture hledger publishes.

Build the local-testing image and create a persistent data volume:

```sh
docker build --platform linux/amd64 -f Dockerfile.example -t wmma:example .
docker volume create wmma-example-data
```

Start the app in one terminal:

```sh
docker run --rm --name wmma-example \
  -p 127.0.0.1:3000:3000 \
  -e WMMA_ALLOWED_USERS=test@example.com \
  -v wmma-example-data:/data \
  wmma:example
```

In a second terminal, start the local identity proxy:

```sh
WMMA_DEV_USER=test@example.com bun run dev:proxy
```

Open <http://127.0.0.1:8080>. To populate the app with synthetic data, run in
a third terminal:

```sh
WMMA_DEV_USER=test@example.com bun run demo:seed
```

Stop the app with Ctrl-C. The named Docker volume keeps its data between runs;
remove it with `docker volume rm wmma-example-data` to start fresh.

## Entities, budgets, transfers, assets

```sh
wmma entity add "Acme LLC" schedule_c          # personal | schedule_c | s_corp_1120s | partnership_1065 | schedule_e
wmma entity archive acme-llc 2026-12-31          # closes its accounts; history stays in reports
wmma budget set household Expenses:Food:Groceries 2026-03 400.00
wmma report budget --entity household --month 2026-03
wmma report pnl --entity acme-llc --from 2026-01-01 --to 2026-12-31
wmma transfer acme-checking personal-checking 1000.00 2026-03-15 owner draw
wmma valuation house 2026-06-30 410000.00
wmma import reihub /data/reihub.csv --account rental-checking
wmma import ynab-api --include-budgets           # or: import ynab-csv register.csv --plan-file plan.csv
```

REST: `GET|POST /entities`, `PATCH /entities/:slug`, `POST /accounts`, `PATCH /accounts/:slug`, `GET|PUT /budgets`, `POST /transfers`, `POST /valuations`, `GET /reports/pnl`, `GET /reports/budget`; REI Hub via `POST /imports` with `type=reihub` (options: `account`, `accountMap`, `properties`, `defaultEntity`, `columns`, `invertAmount`).

## AI access (MCP)

WMMA serves MCP (Streamable HTTP) at `/mcp`, behind the same Tailscale auth. From a machine on your tailnet:

```sh
claude mcp add --transport http wmma https://wmma.<your-tailnet>.ts.net/mcp
```

Read tools: `list_entities`, `list_accounts`, `search_transactions`, `get_pnl`, `get_cashflow`, `get_budget_vs_actual`, `get_net_worth`, `get_spending_by_category`, `get_review_queue`.
Write tools: `categorize_transaction`, `set_entity`, `split_transaction`, `create_rule`, `update_mapping`, `set_budget`, `record_valuation`, `record_transfer`, `run_simplefin_sync`. Every call is recorded in `audit.log`.

## REST API (`/api/v1`)

| | |
| --- | --- |
| Entities & accounts | `GET/POST /entities`, `PATCH /entities/:slug`, `GET/POST /accounts`, `PATCH /accounts/:slug` |
| Transactions | `GET /transactions?from&to&account&entity&category&text&limit&offset`, `PATCH /transactions/:id` (`category`, `entity`, `memo`), `POST /transactions/:id/split`, `POST /transfers`, `POST /valuations` |
| Categorization | `GET /review`, `POST /review/:id`, `GET/POST /rules`, `GET/PUT /mappings` (`apply: true` regenerates), `POST /categorize` |
| Imports | `POST /imports` (multipart: `ynab-csv`, `qfx`, `csv`, `reihub`), `POST /imports/ynab-api`, `POST /sync/simplefin`, `GET /import-runs`, `GET/PUT /csv-profiles[/:name]`, `GET /duplicates`, `POST /duplicates/:id` |
| Budgets | `GET/PUT /budgets` |
| Reports | `GET /reports/pnl`, `/reports/cashflow`, `/reports/budget`, `/reports/networth`, `/reports/spending` |
| Settings | `GET/PUT /settings` (`settings: {"ui.*": ...}`, `jevApiKey` — needs `WMMA_SECRET_KEY`) |

## Categorization

Every import runs new uncategorised transactions through: rules → Jev (`JEV_API_KEY`; applied when confidence ≥ 0.90) → review queue. Without a Jev key, unknown transactions go straight to the queue.

```sh
curl -H "Tailscale-User-Login: $ME" localhost:3000/api/v1/review                 # pending items with Jev's top 3
curl -H "Tailscale-User-Login: $ME" -X POST localhost:3000/api/v1/review/<wmma_id> \
     -d '{"account":"Expenses:Food:Groceries"}'                                    # accept / change (a "swipe")
curl -H "Tailscale-User-Login: $ME" -X POST localhost:3000/api/v1/rules \
     -d '{"match":{"payeeContains":"costco"},"target":"Expenses:Food:Groceries"}'
curl -H "Tailscale-User-Login: $ME" -X POST localhost:3000/api/v1/categorize      # re-run on the backlog
```

The 3rd time a payee is accepted into the same category, WMMA creates a rule for it. Rule `match` fields: `payeeKey`, `payeeContains`, `amountMin`/`amountMax` (signed cents), `account`.

REST: `POST /api/v1/imports/ynab-api` (JSON options), `POST /api/v1/imports` (multipart: `type=ynab-csv`, `file`, `options`), `GET /api/v1/import-runs`, `GET /api/v1/accounts`, `POST /api/v1/sync/simplefin`, `GET|PUT /api/v1/csv-profiles[/:name]`, `GET /api/v1/duplicates`, `POST /api/v1/duplicates/:id`.

## Run with Docker Compose

WMMA is only reachable through [Tailscale Serve](https://tailscale.com/kb/1312/serve). The `wmma` container shares the Tailscale sidecar's network and listens on `127.0.0.1`; no ports are published.

```sh
cp .env.example .env        # fill in, or use op:// references
op run --env-file=.env -- docker compose up -d --build
```

Then open `https://wmma.<your-tailnet>.ts.net`. Only Tailscale users in `WMMA_ALLOWED_USERS` get in. Data lives in `./data` (back it up yourself).

| Variable | Purpose |
| --- | --- |
| `TS_AUTHKEY` | Tailscale auth key for the sidecar |
| `WMMA_ALLOWED_USERS` | comma-separated Tailscale login names (required) |
| `WMMA_TZ` | timezone, default `UTC` |
| `WMMA_DATA_DIR` | default `/data` |
| `YNAB_TOKEN` | YNAB personal access token (for `import ynab-api`) |
| `SIMPLEFIN_ACCESS_URL`, `SIMPLEFIN_SYNC_CRON` | SimpleFIN access URL; sync schedule (default `0 6 * * *`) |
| `JEV_API_KEY` | Jev (TypeSafe) API key; optional `JEV_BASE_URL`, `JEV_MODEL` |
| `WMMA_SECRET_KEY` | ≥16 chars; encrypts secrets set in the UI (`/data/secrets.enc`), including Jev keys and SimpleFIN credentials |

## Development

Requires [Bun](https://bun.sh) 1.4.4 (`mise install`) and, for the integration tests, `hledger` and `hledger-web` on `PATH` (or `HLEDGER_BIN` / `HLEDGER_WEB_BIN`). Tests needing them are skipped otherwise.

```sh
bun install
bun test
bun run typecheck
WMMA_DATA_DIR=./data WMMA_ALLOWED_USERS=you@example.com bun run dev
curl -H 'Tailscale-User-Login: you@example.com' localhost:3000/api/v1/status
```

## License

MIT
