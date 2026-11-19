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
  wmma import ynab-api  [--plan ID] [--include-budgets] [options]
  wmma import ynab-csv  <register.csv> [--plan-file plan.csv] [--date-format ...] [options]
  wmma import qfx       <file.qfx> [--account SLUG] [options]
  wmma import csv       <file.csv> --profile NAME --account SLUG
  wmma sync simplefin   [--start-date YYYY-MM-DD] [options]
  wmma csv-profile set  <name> <profile.json>
  wmma csv-profiles
  wmma duplicates
  wmma duplicate <id> import|discard|merge [--wmma-id ID]
  wmma import reihub    <file.csv> [--account SLUG] [--default-entity SLUG]
  wmma entities
  wmma entity add <name> <type>        type: personal schedule_c s_corp_1120s partnership_1065 schedule_e
  wmma entity archive <slug> <YYYY-MM-DD>
  wmma budget set <entity> <Expenses:...> <YYYY-MM> <amount>
  wmma transfer <from-slug> <to-slug> <amount> <YYYY-MM-DD> [memo]
  wmma valuation <account-slug> <YYYY-MM-DD> <value>
  wmma report pnl [--entity SLUG] --from YYYY-MM-DD --to YYYY-MM-DD
  wmma report budget --entity SLUG --month YYYY-MM
  wmma import-runs
  wmma accounts
  wmma logos [fetch]                   logo coverage; fetch downloads missing logos
  wmma logos import <file.json>        set logo websites: {"payees": {"<payee>": "<domain>"}, "accounts": {"<slug>": "<domain>"}}

options:
  --default-entity SLUG          entity for new accounts (default: personal)
  --account "NAME=KIND[:ENTITY]" first-import assignment, repeatable (ynab-*)
  --account SLUG                 existing WMMA account (qfx, csv)
                                 KIND: bank credit investment vehicle real_estate other_asset loan
  --user LOGIN                   act as this Tailscale user (default: first of WMMA_ALLOWED_USERS)
`;

/** Per-install logo websites (local shops, regional banks) go into the database, never into the code. */
async function importLogos(base: string, headers: Record<string, string>, doc: unknown): Promise<number> {
  const { payees = {}, accounts = {} } = (doc ?? {}) as { payees?: Record<string, unknown>; accounts?: Record<string, unknown> };
  const failed: string[] = [];
  let done = 0;
  const send = async (label: string, url: string, method: string, body: unknown) => {
    const r = await fetch(url, { method, headers, body: JSON.stringify(body) });
    if (r.ok) done++;
    else failed.push(`${label}: ${(await r.text()).slice(0, 200)}`);
  };
  for (const [payee, domain] of Object.entries(payees)) {
    if (domain !== null && typeof domain !== "string") failed.push(`payee ${payee}: domain must be a string or null`);
    else await send(`payee ${payee}`, `${base}/logos/payees/${encodeURIComponent(payee)}`, "PUT", { domain });
  }
  for (const [slug, domain] of Object.entries(accounts)) {
    if (domain !== null && typeof domain !== "string") failed.push(`account ${slug}: domain must be a string or null`);
    else await send(`account ${slug}`, `${base}/accounts/${encodeURIComponent(slug)}`, "PATCH", { logoDomain: domain });
  }
  console.log(JSON.stringify({ imported: done, failed }, null, 2));
  return failed.length ? 1 : 0;
}

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
        "include-budgets": { type: "boolean" },
        "plan-file": { type: "string" },
        entity: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        month: { type: "string" },
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
      ...(values["include-budgets"] ? { includeBudgets: true } : {}),
    };
    const single = values.account?.length === 1 && !values.account[0]!.includes("=") ? values.account[0] : undefined;
    const withAccounts = single
      ? { ...options, account: single }
      : { ...options, ...(values.account ? { accounts: accountsOption(values.account) } : {}) };

    let res: Response;
    const sub = cmd === "import" ? positionals.shift() : undefined;
    if (cmd === "import" && sub === "ynab-api") {
      res = await fetch(`${base}/imports/ynab-api`, { method: "POST", headers, body: JSON.stringify(withAccounts) });
    } else if (cmd === "import" && (sub === "ynab-csv" || sub === "qfx" || sub === "csv" || sub === "reihub")) {
      const path = positionals.shift();
      if (!path) throw new Error("missing file path");
      const form = new FormData();
      form.set("type", sub);
      form.set("file", Bun.file(path), path.split("/").pop());
      form.set("options", JSON.stringify(withAccounts));
      if (values["plan-file"]) form.set("plan", Bun.file(values["plan-file"]), values["plan-file"].split("/").pop());
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
    } else if (cmd === "entities") {
      res = await fetch(`${base}/entities?status=all`, { headers });
    } else if (cmd === "entity" && positionals[0] === "add" && positionals[1] && positionals[2]) {
      res = await fetch(`${base}/entities`, { method: "POST", headers, body: JSON.stringify({ name: positionals[1], type: positionals[2] }) });
    } else if (cmd === "entity" && positionals[0] === "archive" && positionals[1] && positionals[2]) {
      res = await fetch(`${base}/entities/${encodeURIComponent(positionals[1])}`, { method: "PATCH", headers, body: JSON.stringify({ archive: { date: positionals[2] } }) });
    } else if (cmd === "budget" && positionals[0] === "set" && positionals.length === 5) {
      const [, entity, account, month, amount] = positionals;
      res = await fetch(`${base}/budgets`, { method: "PUT", headers, body: JSON.stringify([{ entity, account, month, amount }]) });
    } else if (cmd === "transfer" && positionals.length >= 4) {
      const [from, to, amount, date, ...memo] = positionals;
      res = await fetch(`${base}/transfers`, { method: "POST", headers, body: JSON.stringify({ from, to, amount, date, memo: memo.join(" ") }) });
    } else if (cmd === "valuation" && positionals.length === 3) {
      const [account, date, value] = positionals;
      res = await fetch(`${base}/valuations`, { method: "POST", headers, body: JSON.stringify({ account, date, value }) });
    } else if (cmd === "report" && positionals[0] === "pnl") {
      const q = new URLSearchParams({ from: values.from ?? "", to: values.to ?? "", ...(values.entity ? { entity: values.entity } : {}) });
      res = await fetch(`${base}/reports/pnl?${q}`, { headers });
    } else if (cmd === "report" && positionals[0] === "budget") {
      res = await fetch(`${base}/reports/budget?${new URLSearchParams({ entity: values.entity ?? "", month: values.month ?? "" })}`, { headers });
    } else if (cmd === "import-runs") {
      res = await fetch(`${base}/import-runs`, { headers });
    } else if (cmd === "accounts") {
      res = await fetch(`${base}/accounts`, { headers });
    } else if (cmd === "logos" && positionals[0] === "import") {
      const path = positionals[1];
      if (!path) throw new Error("missing file path");
      return await importLogos(base, headers, JSON.parse(await Bun.file(path).text()));
    } else if (cmd === "logos") {
      res = positionals[0] === "fetch" ? await fetch(`${base}/logos/prefetch`, { method: "POST", headers }) : await fetch(`${base}/logos/coverage`, { headers });
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
