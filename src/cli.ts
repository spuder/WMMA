/**
 * Thin CLI over the local REST API, so the running server stays the only
 * journal writer. Run inside the container:
 *   docker compose exec wmma wmma import ynab-api --default-entity personal
 */
import { parseArgs } from "node:util";
import { parseAllowedUsers } from "./config";

const USAGE = `usage:
  wmma serve
  wmma healthcheck
  wmma import ynab-api  [--plan ID] [options]
  wmma import ynab-csv  <register.csv> [--date-format MM/DD/YYYY|DD/MM/YYYY|YYYY-MM-DD] [options]
  wmma import qfx       <file.qfx> [--account SLUG] [options]
  wmma import csv       <file.csv> --profile NAME --account SLUG
  wmma sync simplefin   [--start-date YYYY-MM-DD] [options]
  wmma csv-profile set  <name> <profile.json>
  wmma csv-profiles
  wmma duplicates
  wmma duplicate <id> import|discard|merge [--wmma-id ID]
  wmma import-runs
  wmma accounts

options:
  --default-entity SLUG          entity for new accounts (default: personal)
  --account "NAME=KIND[:ENTITY]" first-import assignment, repeatable (ynab-*)
  --account SLUG                 existing WMMA account (qfx, csv)
                                 KIND: bank credit investment vehicle real_estate other_asset loan
  --user LOGIN                   act as this Tailscale user (default: first of WMMA_ALLOWED_USERS)
`;

function accountsOption(values: string[] | undefined): Record<string, { kind?: string; entity?: string }> | undefined {
  if (!values?.length) return undefined;
  const out: Record<string, { kind?: string; entity?: string }> = {};
  for (const v of values) {
    const eq = v.lastIndexOf("=");
    if (eq < 1) throw new Error(`--account expects NAME=KIND[:ENTITY], got ${JSON.stringify(v)}`);
    const [kind, entity] = v.slice(eq + 1).split(":");
    out[v.slice(0, eq)] = { ...(kind ? { kind } : {}), ...(entity ? { entity } : {}) };
  }
  return out;
}

export async function runCli(cmd: string, argv: string[]): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        plan: { type: "string" },
        "date-format": { type: "string" },
        "default-entity": { type: "string" },
        account: { type: "string", multiple: true },
        user: { type: "string" },
        profile: { type: "string" },
        "start-date": { type: "string" },
        "wmma-id": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) {
      console.log(USAGE);
      return 0;
    }
    const user = values.user ?? [...parseAllowedUsers(process.env.WMMA_ALLOWED_USERS)][0];
    if (!user) throw new Error("no user: pass --user or set WMMA_ALLOWED_USERS");
    const base = `http://127.0.0.1:${process.env.WMMA_PORT || "3000"}/api/v1`;
    const headers = { "Tailscale-User-Login": user };
    const options = {
      ...(values["default-entity"] ? { defaultEntity: values["default-entity"] } : {}),
      ...(values.plan ? { planId: values.plan } : {}),
      ...(values["date-format"] ? { dateFormat: values["date-format"] } : {}),
      ...(values.profile ? { profile: values.profile } : {}),
      ...(values["start-date"] ? { startDate: values["start-date"] } : {}),
    };
    const single = values.account?.length === 1 && !values.account[0]!.includes("=") ? values.account[0] : undefined;
    const withAccounts = single
      ? { ...options, account: single }
      : { ...options, ...(values.account ? { accounts: accountsOption(values.account) } : {}) };

    let res: Response;
    const sub = cmd === "import" ? positionals.shift() : undefined;
    if (cmd === "import" && sub === "ynab-api") {
      res = await fetch(`${base}/imports/ynab-api`, { method: "POST", headers, body: JSON.stringify(withAccounts) });
    } else if (cmd === "import" && (sub === "ynab-csv" || sub === "qfx" || sub === "csv")) {
      const path = positionals.shift();
      if (!path) throw new Error("missing file path");
      const form = new FormData();
      form.set("type", sub);
      form.set("file", Bun.file(path), path.split("/").pop());
      form.set("options", JSON.stringify(withAccounts));
      res = await fetch(`${base}/imports`, { method: "POST", headers, body: form });
    } else if (cmd === "sync" && positionals[0] === "simplefin") {
      res = await fetch(`${base}/sync/simplefin`, { method: "POST", headers, body: JSON.stringify(withAccounts) });
    } else if (cmd === "csv-profile" && positionals[0] === "set" && positionals[1] && positionals[2]) {
      res = await fetch(`${base}/csv-profiles/${encodeURIComponent(positionals[1])}`, { method: "PUT", headers, body: await Bun.file(positionals[2]).text() });
    } else if (cmd === "csv-profiles") {
      res = await fetch(`${base}/csv-profiles`, { headers });
    } else if (cmd === "duplicates") {
      res = await fetch(`${base}/duplicates`, { headers });
    } else if (cmd === "duplicate" && positionals[0] && positionals[1]) {
      const body = { action: positionals[1], ...(values["wmma-id"] ? { wmmaId: values["wmma-id"] } : {}) };
      res = await fetch(`${base}/duplicates/${encodeURIComponent(positionals[0])}`, { method: "POST", headers, body: JSON.stringify(body) });
    } else if (cmd === "import-runs") {
      res = await fetch(`${base}/import-runs`, { headers });
    } else if (cmd === "accounts") {
      res = await fetch(`${base}/accounts`, { headers });
    } else {
      console.error(USAGE);
      return 2;
    }
    const body = await res.text();
    console.log(body.startsWith("{") ? JSON.stringify(JSON.parse(body), null, 2) : body);
    return res.ok ? 0 : 1;
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
