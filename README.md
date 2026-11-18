<img src="assets/icon.svg" width="64" height="64" alt="">

# WMMA — Where My Money At

Self-hosted personal and multi-business finance: budgets, P&L per business, beautiful reports, and AI access over MCP. Plain-text [hledger](https://hledger.org) journals are the source of truth.

See [SPEC.md](SPEC.md) for the full design and milestones.

## Status

- **M1 skeleton:** Bun/TypeScript service, `Money` module, journal writer, Tailscale identity auth, hledger-web (read-only, localhost), Docker image and Compose file.
- **M2 YNAB import:** API and register-CSV importers. Re-running adds nothing; the result reports per-account balances against YNAB.
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
| `JEV_API_KEY` | used from M4 |

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
