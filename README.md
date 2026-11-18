<img src="assets/icon.svg" width="64" height="64" alt="">

# WMMA — Where My Money At

Self-hosted personal and multi-business finance: budgets, P&L per business, beautiful reports, and AI access over MCP. Plain-text [hledger](https://hledger.org) journals are the source of truth.

See [SPEC.md](SPEC.md) for the full design and milestones.

## Status

Milestone 1 (skeleton): Bun/TypeScript service, `Money` module, journal writer, Tailscale identity auth, hledger-web (read-only, localhost), Docker image and Compose file.

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
| `JEV_API_KEY`, `SIMPLEFIN_ACCESS_URL`, `SIMPLEFIN_SYNC_CRON`, `YNAB_TOKEN` | used by later milestones |

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
