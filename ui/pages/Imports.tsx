import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { api, money, useApi } from "../api";
import { businessStyle, useApp, type Entity } from "../app";
import { refreshSimplefinAccounts, SimplefinLinkSheet, type SimplefinMapping } from "../components/simplefin";
import { Avatar, ErrorBox, Icon, Loading, toast } from "../components/ui";

type Kind = "qfx" | "csv" | "ynab-csv" | "reihub";
const KINDS: Array<[Kind, string, string, string]> = [
  ["qfx", "QFX / OFX", "Bank or card statement download", "📄"],
  ["csv", "Bank CSV", "Uses a saved column profile", "📊"],
  ["ynab-csv", "YNAB CSV", "Register export (+ optional plan)", "🗂️"],
  ["reihub", "REI Hub CSV", "Rental transactions", "🏘️"],
];

const SOURCE_LABEL: Record<string, string> = { simplefin: "SimpleFIN", qfx: "QFX / OFX", csv: "Bank CSV", ynab: "YNAB", "ynab-csv": "YNAB CSV", reihub: "REI Hub" };
const KIND_LABEL: Record<string, string> = { bank: "Checking & savings", credit: "Credit card", investment: "Investment", loan: "Loan", asset: "Asset", real_estate: "Real estate" };

type SfAccount = { id: string; name: string; domain: string | null; kindHint: string | null; balance_cents: number | null; asOf: string | null; linkedAccountSlug: string | null };
type SfStatus = {
  configured: boolean;
  lastSync: string | null;
  schedule: { cron: string; tz: string };
  snapshotAt: string | null;
  accounts: SfAccount[];
  mappings: Record<string, SimplefinMapping>;
};

/** "3 hours ago", "yesterday", "Nov 2". */
function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  if (s < 172800) return "yesterday";
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** A readable form of the common cron shapes ("0 6 * * *" → "Daily at 6:00 AM"). */
function scheduleText({ cron, tz }: SfStatus["schedule"]): string {
  const m = /^(\d{1,2}) (\d{1,2}|\*\/\d+) \* \* \*$/.exec(cron.trim());
  if (m && /^\d+$/.test(m[2]!)) {
    const d = new Date(2000, 0, 1, Number(m[2]), Number(m[1]));
    return `Daily at ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}${tz !== "UTC" ? "" : " UTC"}`;
  }
  if (m) return `Every ${m[2]!.slice(2)} hours`;
  return `Schedule ${cron}`;
}

export function Imports() {
  const { refreshReview } = useApp();
  const runs = useApi<{ runs: any[] }>("/import-runs");
  const dups = useApi<{ duplicates: any[] }>("/duplicates");
  const accts = useApi<{ accounts: any[] }>("/accounts");
  const profiles = useApi<{ profiles: any[] }>("/csv-profiles");
  const sf = useApi<SfStatus>("/simplefin/status");
  const [kind, setKind] = useState<Kind>("qfx");
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<File | null>(null);
  const [account, setAccount] = useState("");
  const [profile, setProfile] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [last, setLast] = useState<any>(null);

  const after = (r: any, label: string) => {
    setLast({ ...r, label });
    const c = r.categorization && !r.categorization.error ? ` · ${r.categorization.byRule + r.categorization.byJev} auto-categorized, ${r.categorization.queued} to review` : "";
    toast(`${label}: ${r.added} added${r.merged ? `, ${r.merged} merged` : ""}${r.skippedDuplicates ? `, ${r.skippedDuplicates} already had` : ""}${c}`);
    runs.reload();
    dups.reload();
    accts.reload();
    sf.reload();
    refreshReview();
  };

  const upload = async () => {
    if (!file) return;
    setBusy("upload");
    try {
      const form = new FormData();
      form.set("type", kind);
      form.set("file", file, file.name);
      const options: Record<string, unknown> = {};
      if (account) options["account"] = account;
      if (kind === "csv") options["profile"] = profile;
      form.set("options", JSON.stringify(options));
      if (kind === "ynab-csv" && plan) form.set("plan", plan, plan.name);
      after(await api("/imports", { form }), file.name);
      setFile(null);
      setPlan(null);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const action = async (key: string, path: string, body: unknown, label: string) => {
    setBusy(key);
    try {
      after(await api(path, { body }), label);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const resolveDup = async (id: string, body: unknown) => {
    try {
      await api(`/duplicates/${id}`, { body });
      dups.reload();
      toast("Done");
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const needsAccount = kind === "csv" || kind === "reihub";
  const kindInfo = KINDS.find((k) => k[0] === kind)!;
  return (
    <div class="stack">
      <div class="topbar">
        <h1>Imports</h1>
      </div>
      <div class="grid">
        <BankSync
          status={sf}
          accounts={accts.data?.accounts ?? []}
          busy={busy}
          onSync={() => action("sf", "/sync/simplefin", {}, "SimpleFIN")}
        />

        {last && (
          <div class="card span-12 import-result">
            <div class="card-hd">
              <h2>Last import · {last.label}</h2>
              <button class="btn ghost sm" onClick={() => setLast(null)} aria-label="Dismiss">
                <span class="tiny-ico"><Icon.x /></span>
              </button>
            </div>
            <div class="result-stats">
              <Stat label="Added" value={last.added} tone="in" />
              <Stat label="Merged" value={last.merged ?? 0} />
              <Stat label="Already had" value={last.skippedDuplicates ?? 0} />
              <Stat label="To check" value={last.needsReview ?? 0} tone={last.needsReview ? "warn" : undefined} />
            </div>
            {(last.balances ?? []).length > 0 && (
              <div class="balance-list" style={{ marginTop: 14 }}>
                {(last.balances ?? []).map((b: any) => (
                  <div class="balance-row" key={b.account}>
                    <span class="name">{b.account}</span>
                    {b.match ? (
                      <span class="pill ok" title="Bank and WMMA balances match">✓ {b.wmma}</span>
                    ) : (
                      <dl class="balance-diff" title="Balances differ">
                        <dt>Bank</dt>
                        <dd>{b.source}</dd>
                        <dt>WMMA</dt>
                        <dd>{b.wmma}</dd>
                      </dl>
                    )}
                  </div>
                ))}
              </div>
            )}
            {(last.errors ?? []).map((e: string) => (
              <div class="error small" style={{ marginTop: 10 }}>{e}</div>
            ))}
          </div>
        )}

        <div class="card span-7">
          <div class="card-hd">
            <h2>Upload a file</h2>
            <span class="muted small">Statements and exports</span>
          </div>
          <div class="stack" style={{ gap: 14 }}>
            <div class="kind-grid" role="radiogroup" aria-label="File type">
              {KINDS.map(([k, label, desc, emoji]) => (
                <button class={`kind-opt${kind === k ? " on" : ""}`} role="radio" aria-checked={kind === k} onClick={() => setKind(k)}>
                  <span class="kind-emoji" aria-hidden="true">{emoji}</span>
                  <span>
                    <strong>{label}</strong>
                    <span class="muted tiny">{desc}</span>
                  </span>
                </button>
              ))}
            </div>
            <label
              class={`dropzone${drag ? " over" : ""}${file ? " has-file" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                const f = e.dataTransfer?.files?.[0];
                if (f) setFile(f);
              }}
            >
              <span class="dropzone-icon"><Icon.upload /></span>
              {file ? (
                <span><strong>{file.name}</strong> <span class="muted small">· {(file.size / 1024).toFixed(0)} KB · click to change</span></span>
              ) : (
                <span><strong>Drop a {kindInfo[1]} file here</strong> <span class="muted small">or click to browse</span></span>
              )}
              <input type="file" accept={kind === "qfx" ? ".qfx,.ofx,.qbo" : ".csv,text/csv"} style={{ display: "none" }} onChange={(e) => setFile((e.target as HTMLInputElement).files?.[0] ?? null)} />
            </label>
            {kind === "ynab-csv" && (
              <label class="row small" style={{ cursor: "pointer" }}>
                <span class="muted">Plan export (budgets, optional):</span>
                <strong>{plan ? plan.name : "choose…"}</strong>
                <input type="file" accept=".csv" style={{ display: "none" }} onChange={(e) => setPlan((e.target as HTMLInputElement).files?.[0] ?? null)} />
              </label>
            )}
            {(needsAccount || kind === "qfx") && (
              <div class="field">
                <label>{kind === "qfx" ? "Into account (optional — created from the statement otherwise)" : "Into account"}</label>
                <select class="input" value={account} onChange={(e) => setAccount((e.target as HTMLSelectElement).value)}>
                  <option value="">{kind === "qfx" ? "Automatic" : "Choose…"}</option>
                  {(accts.data?.accounts ?? [])
                    .filter((a: any) => a.status === "open")
                    .map((a: any) => (
                      <option value={a.slug}>{a.name}</option>
                    ))}
                </select>
              </div>
            )}
            {kind === "csv" && (
              <div class="field">
                <label>Column profile</label>
                <select class="input" value={profile} onChange={(e) => setProfile((e.target as HTMLSelectElement).value)}>
                  <option value="">Choose…</option>
                  {(profiles.data?.profiles ?? []).map((p: any) => (
                    <option value={p.name}>{p.name}</option>
                  ))}
                </select>
                {(profiles.data?.profiles ?? []).length === 0 && <div class="muted tiny">Create one with the CLI: wmma csv-profile set &lt;name&gt; profile.json</div>}
              </div>
            )}
            <button class="btn primary block" disabled={!file || busy !== null || (kind === "csv" && (!profile || !account)) || (kind === "reihub" && !account)} onClick={upload}>
              {busy === "upload" ? "Importing…" : "Import"}
            </button>
          </div>
        </div>

        <div class="span-5 stack">
          <div class="card">
            <div class="card-hd">
              <h2>Other sources</h2>
            </div>
            <div class="source-row">
              <span class="source-logo ynab" aria-hidden="true">Y</span>
              <span class="source-text">
                <strong>YNAB</strong>
                <span class="muted small">Pull transactions and budgets with your YNAB token</span>
              </span>
              <button class="btn sm" disabled={busy !== null} onClick={() => action("ynab", "/imports/ynab-api", { includeBudgets: true }, "YNAB")}>
                {busy === "ynab" ? "Pulling…" : "Pull"}
              </button>
            </div>
          </div>

          {(dups.data?.duplicates ?? []).length > 0 && (
            <div class="card">
              <div class="card-hd">
                <h2>Possible duplicates</h2>
                <span class="pill warn">{dups.data!.duplicates.length}</span>
              </div>
              <div class="sub" style={{ marginBottom: 6 }}>These matched more than one existing transaction. Pick what to do.</div>
              <div class="list">
                {dups.data!.duplicates.map((d: any) => (
                  <div class="item" style={{ flexWrap: "wrap" }}>
                    <div class="body">
                      <div class="title">
                        {d.record.payee} · {money(d.record.amount)}
                      </div>
                      <div class="meta">
                        {d.record.date} · {SOURCE_LABEL[d.source] ?? d.source} · {d.candidates.length} candidates
                      </div>
                    </div>
                    <div class="row" style={{ gap: 6 }}>
                      <button class="btn sm" onClick={() => resolveDup(d.id, { action: "merge", wmmaId: d.candidates[0] })}>
                        Merge
                      </button>
                      <button class="btn sm" onClick={() => resolveDup(d.id, { action: "import" })}>
                        Keep both
                      </button>
                      <button class="btn sm ghost" onClick={() => resolveDup(d.id, { action: "discard" })}>
                        Discard
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div class="card flush span-12">
          <div class="card-hd">
            <h2>History</h2>
            <span class="muted small">Last 30 imports</span>
          </div>
          {runs.error && <div style={{ padding: 18 }}><ErrorBox error={runs.error} /></div>}
          {runs.loading ? (
            <div style={{ padding: 18 }}><Loading h={120} /></div>
          ) : (runs.data?.runs ?? []).length === 0 ? (
            <div class="empty">No imports yet</div>
          ) : (
            <table class="table history">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>When</th>
                  <th class="r">Added</th>
                  <th class="r hide-sm">Already had</th>
                  <th class="r">Status</th>
                </tr>
              </thead>
              <tbody>
                {runs.data!.runs.slice(0, 30).map((r: any) => (
                  <tr>
                    <td>
                      <span class="run-source">
                        <span class={`source-dot s-${r.source}`} />
                        {SOURCE_LABEL[r.source] ?? r.source}
                      </span>
                    </td>
                    <td class="muted">{new Date(r.started).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                    <td class="r num">{r.added > 0 ? <strong class="in">+{r.added}</strong> : <span class="muted">0</span>}</td>
                    <td class="r num muted hide-sm">{r.skipped_duplicates}</td>
                    <td class="r">
                      {r.errors.length > 0 ? (
                        <span class="pill over" title={r.errors.join("\n")}>{r.errors.length === 1 ? "1 error" : `${r.errors.length} errors`}</span>
                      ) : (
                        <span class="pill ok">Done</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "in" | "warn" | undefined }) {
  return (
    <div class="result-stat">
      <div class={`result-value num${tone ? ` ${tone}` : ""}`}>{value}</div>
      <div class="muted small">{label}</div>
    </div>
  );
}

/** SimpleFIN: connection state, schedule, and every bank account with whether it syncs. */
function BankSync({
  status,
  accounts,
  busy,
  onSync,
}: {
  status: { data: SfStatus | null; error: string | null; loading: boolean; reload: () => void };
  accounts: any[];
  busy: string | null;
  onSync: () => void;
}) {
  const { entities } = useApp();
  const [saving, setSaving] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [linking, setLinking] = useState<{ account: SfAccount; editing: boolean } | null>(null);
  const s = status.data;
  const syncing = (a: SfAccount) => Boolean(s?.mappings[a.id]) && !s?.mappings[a.id]?.skip;
  const rows = s ? [...s.accounts].sort((a, b) => Number(syncing(b)) - Number(syncing(a)) || a.name.localeCompare(b.name)) : [];
  const on = rows.filter(syncing);
  const total = on.reduce((sum, a) => sum + (a.balance_cents ?? 0), 0);

  const saveMapping = async (a: SfAccount, mapping: SimplefinMapping) => {
    if (!s) return;
    await api("/simplefin/accounts", { method: "POST", body: { accounts: { ...s.mappings, [a.id]: mapping } } });
    status.reload();
  };
  const turnOff = async (a: SfAccount) => {
    setSaving(a.id);
    try {
      await saveMapping(a, { ...s?.mappings[a.id], skip: true });
      toast(`${a.name} won't sync`);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSaving(null);
    }
  };
  const refresh = async () => {
    setRefreshing(true);
    try {
      const n = await refreshSimplefinAccounts();
      toast(`SimpleFIN returned ${n} account${n === 1 ? "" : "s"}`);
      status.reload();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };
  // WMMA accounts already fed by some other SimpleFIN account can't be picked again.
  const takenSlugs = (except: string) =>
    new Set(
      (s?.accounts ?? []).flatMap((o) => (o.id === except ? [] : [o.linkedAccountSlug, s?.mappings[o.id]?.skip ? null : s?.mappings[o.id]?.slug])).filter((x): x is string => Boolean(x)),
    );

  let body: ComponentChildren;
  if (status.loading && !s) body = <div style={{ padding: 18 }}><Loading h={140} /></div>;
  else if (status.error) body = <div style={{ padding: 18 }}><ErrorBox error={status.error} /></div>;
  else if (!s?.configured)
    body = (
      <div class="sf-empty">
        <div class="sf-empty-art" aria-hidden="true">
          <span>🏦</span>
          <span class="sf-link-line" />
          <span class="sf-wmma"><Icon.logo /></span>
        </div>
        <h3>Sync your banks automatically</h3>
        <p class="muted">SimpleFIN Bridge connects to thousands of US banks and card issuers. WMMA pulls new transactions and balances every day.</p>
        <ol class="sf-steps">
          <li><span>1</span>Add your banks in <a href="https://beta-bridge.simplefin.org/my-account" target="_blank" rel="noreferrer">SimpleFIN Bridge ↗</a></li>
          <li><span>2</span>Create a Setup Token there and paste it in Settings</li>
          <li><span>3</span>Choose which accounts to sync</li>
        </ol>
        <a class="btn primary" href="#/settings">Connect SimpleFIN</a>
      </div>
    );
  else if (rows.length === 0)
    body = (
      <div class="sf-empty">
        <h3>Load your bank accounts</h3>
        <p class="muted">SimpleFIN is connected. Load the account list, then switch on the ones to sync.</p>
        <button class="btn primary" disabled={refreshing} onClick={refresh}>
          {refreshing ? "Loading accounts…" : "Load accounts from SimpleFIN"}
        </button>
      </div>
    );
  else
    body = (
      <>
        <div class="sf-summary">
          <div>
            <div class="muted small">Syncing</div>
            <strong class="num">{on.length} of {rows.length} accounts</strong>
          </div>
          <div>
            <div class="muted small">Total balance</div>
            <strong class="num">{s.snapshotAt ? money(total) : "—"}</strong>
          </div>
          <div>
            <div class="muted small">Last synced</div>
            <strong>{ago(s.lastSync)}</strong>
          </div>
          <div>
            <div class="muted small">Next sync</div>
            <strong>{scheduleText(s.schedule)}</strong>
          </div>
        </div>
        <div class="sf-list">
          {rows.map((a) => {
            const linked = accounts.find((x) => x.slug === a.linkedAccountSlug);
            const isOn = syncing(a);
            const entitySlug = s.mappings[a.id]?.entity ?? linked?.default_entity;
            const ent = entities.find((e) => e.slug === entitySlug);
            const kind = s.mappings[a.id]?.kind ?? linked?.kind ?? a.kindHint ?? "bank";
            return (
              <div class={`sf-row${isOn ? "" : " off"}`} key={a.id}>
                <Avatar name={a.name} logo={linked?.logo ?? (a.domain ? { domain: a.domain } : null)} />
                <div
                  class={`sf-name${isOn ? " editable" : ""}`}
                  {...(isOn ? { role: "button", tabIndex: 0, title: "Change profile or linked account", onClick: () => setLinking({ account: a, editing: true }), onKeyDown: (e: KeyboardEvent) => e.key === "Enter" && setLinking({ account: a, editing: true }) } : {})}
                >
                  <strong>{a.name}</strong>
                  <span class="sf-meta">
                    <span>{KIND_LABEL[kind] ?? kind}</span>
                    {isOn && ent && <BizTag entity={ent} />}
                    {isOn && !linked && <span class="sf-new">New account on next sync</span>}
                    {linked && linked.name !== a.name && <span class="muted">→ {linked.name}</span>}
                  </span>
                </div>
                <div class="sf-bal">
                  <span class={`num${(a.balance_cents ?? 0) < 0 ? " neg" : ""}`}>{a.balance_cents === null ? (linked ? linked.balance : "—") : money(a.balance_cents)}</span>
                  {a.asOf && <span class="muted tiny">as of {new Date(`${a.asOf}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>}
                </div>
                <label class="sf-switch" title={isOn ? "Syncing — click to stop" : "Not syncing — click to sync"}>
                  <input type="checkbox" checked={isOn} disabled={saving !== null} onChange={(e) => {
                      const el = e.target as HTMLInputElement;
                      if (el.checked) {
                        el.checked = false; // stays off until the dialog is confirmed
                        setLinking({ account: a, editing: false });
                      } else turnOff(a);
                    }} aria-label={`Sync ${a.name}`} />
                </label>
              </div>
            );
          })}
        </div>
        <div class="sf-foot muted small">
          {s.snapshotAt ? `Account list from SimpleFIN, ${ago(s.snapshotAt)}.` : "Showing linked WMMA accounts; sync once to load balances from SimpleFIN."} New accounts at your bank appear after <button class="linkbtn small" disabled={refreshing} onClick={refresh}>{refreshing ? "checking…" : "checking SimpleFIN"}</button>.
        </div>
        {linking && (
          <SimplefinLinkSheet
            account={linking.account}
            mapping={s.mappings[linking.account.id]}
            existingAccounts={accounts.filter((x) => x.status === "open")}
            takenSlugs={takenSlugs(linking.account.id)}
            editing={linking.editing}
            onClose={() => setLinking(null)}
            onSave={async (mapping) => {
              try {
                await saveMapping(linking.account, mapping);
                toast(linking.editing ? "Saved" : `${linking.account.name} will sync — use Sync now to import it`);
                setLinking(null);
              } catch (e) {
                toast((e as Error).message);
              }
            }}
          />
        )}
      </>
    );

  return (
    <div class="card flush span-12 sf-card">
      <div class="card-hd sf-head">
        <div class="row" style={{ gap: 12, minWidth: 0 }}>
          <span class="sf-icon" aria-hidden="true"><Icon.bank /></span>
          <div style={{ minWidth: 0 }}>
            <h2>Bank sync</h2>
            <div class="muted small">via SimpleFIN Bridge</div>
          </div>
          {s && (
            <span class={`status-chip${s.configured ? (on.length ? " ok" : " warn") : ""}`}>
              <span class="dot" />
              {s.configured ? (on.length ? "Connected" : "No accounts on") : "Not connected"}
            </span>
          )}
        </div>
        {s?.configured && rows.length > 0 && (
          <div class="row" style={{ gap: 8 }}>
            <button class="btn primary sm" disabled={busy !== null || on.length === 0} onClick={onSync}>
              <span class={`tiny-ico${busy === "sf" ? " spin" : ""}`}><Icon.refresh /></span>
              {busy === "sf" ? "Syncing…" : "Sync now"}
            </button>
          </div>
        )}
      </div>
      {body}
    </div>
  );
}

function BizTag({ entity }: { entity: Entity }) {
  return (
    <span class="business-tag" style={businessStyle(entity.slug, entity.color)}>
      {entity.type === "personal" ? "👤" : <Icon.folder />} {entity.name}
    </span>
  );
}
