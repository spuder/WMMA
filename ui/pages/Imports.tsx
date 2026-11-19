import { useState } from "preact/hooks";
import { api, money, useApi } from "../api";
import { ErrorBox, Icon, Loading, toast } from "../components/ui";
import { useApp } from "../app";

type Kind = "qfx" | "csv" | "ynab-csv" | "reihub";
const KINDS: Array<[Kind, string, string]> = [
  ["qfx", "QFX / OFX", "Bank or card statement download"],
  ["csv", "Bank CSV", "Uses a saved column profile"],
  ["ynab-csv", "YNAB CSV", "Register export (+ optional plan)"],
  ["reihub", "REI Hub CSV", "Rental transactions"],
];

export function Imports() {
  const { refreshReview } = useApp();
  const runs = useApi<{ runs: any[] }>("/import-runs");
  const dups = useApi<{ duplicates: any[] }>("/duplicates");
  const accts = useApi<{ accounts: any[] }>("/accounts");
  const profiles = useApi<{ profiles: any[] }>("/csv-profiles");
  const settings = useApi<any>("/settings");
  const [kind, setKind] = useState<Kind>("qfx");
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<File | null>(null);
  const [account, setAccount] = useState("");
  const [profile, setProfile] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [last, setLast] = useState<any>(null);

  const after = (r: any, label: string) => {
    setLast(r);
    const c = r.categorization && !r.categorization.error ? ` · ${r.categorization.byRule + r.categorization.byJev} auto-categorized, ${r.categorization.queued} to review` : "";
    toast(`${label}: ${r.added} added${r.merged ? `, ${r.merged} merged` : ""}${r.skippedDuplicates ? `, ${r.skippedDuplicates} already had` : ""}${c}`);
    runs.reload();
    dups.reload();
    accts.reload();
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
  return (
    <div class="stack">
      <div class="topbar">
        <h1>Imports</h1>
      </div>
      <div class="grid">
        <div class="card span-7 stack">
          <h2>Upload a file</h2>
          <div class="chips">
            {KINDS.map(([k, l]) => (
              <button class={`chip${kind === k ? " active" : ""}`} onClick={() => setKind(k)}>
                {l}
              </button>
            ))}
          </div>
          <div class="muted small">{KINDS.find((k) => k[0] === kind)![2]}</div>
          <label class="card flat row" style={{ cursor: "pointer", borderStyle: "dashed", justifyContent: "center", padding: 22 }}>
            <span style={{ width: 22, height: 22, display: "inline-flex", color: "var(--accent-text)" }}>
              <Icon.upload />
            </span>
            <span style={{ fontWeight: 600 }}>{file ? file.name : "Choose file"}</span>
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

        <div class="span-5 stack">
          <div class="card stack">
            <h2>Connected sources</h2>
            {settings.data?.simplefin.configured && settings.data.simplefin.accountsConfigured ? (
              <div class="muted small">SimpleFIN is connected. Selected accounts sync to their assigned businesses or personal profile.</div>
            ) : settings.data?.simplefin.configured ? (
              <div class="muted small">Choose which accounts to add and assign them to businesses or personal finances in Settings.</div>
            ) : (
              <div class="small">Connect SimpleFIN in <a href="#/settings" style={{ color: "var(--accent-text)", fontWeight: 650 }}>Settings</a> before syncing.</div>
            )}
            {!settings.loading && settings.data?.simplefin.configured && !settings.data.simplefin.accountsConfigured && <a class="btn block" href="#/settings">Set up SimpleFIN accounts in Settings</a>}
            <button class="btn block" disabled={busy !== null || settings.loading || !settings.data?.simplefin.configured || !settings.data.simplefin.accountsConfigured} onClick={() => action("sf", "/sync/simplefin", {}, "SimpleFIN")}>
              {busy === "sf" ? "Syncing…" : "Sync SimpleFIN now"}
            </button>
            <button class="btn block" disabled={busy !== null} onClick={() => action("ynab", "/imports/ynab-api", { includeBudgets: true }, "YNAB")}>
              {busy === "ynab" ? "Pulling from YNAB…" : "Pull from YNAB (with budgets)"}
            </button>
          </div>
          {last && (
            <div class="card stack" style={{ gap: 6 }}>
              <h2>Last import</h2>
              <div class="small">
                {last.added} added · {last.merged ?? 0} merged · {last.skippedDuplicates} duplicates{last.needsReview ? ` · ${last.needsReview} possible duplicates to check` : ""}
              </div>
              {(last.balances ?? []).length > 0 && (
                <div class="balance-list">
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
                <div class="error small">{e}</div>
              ))}
            </div>
          )}
        </div>

        {(dups.data?.duplicates ?? []).length > 0 && (
          <div class="card span-12">
            <h2>Possible duplicates</h2>
            <div class="sub">These matched more than one existing transaction. Pick what to do.</div>
            <div class="list">
              {dups.data!.duplicates.map((d: any) => (
                <div class="item" style={{ flexWrap: "wrap" }}>
                  <div class="body">
                    <div class="title">
                      {d.record.payee} · {money(d.record.amount)}
                    </div>
                    <div class="meta">
                      {d.record.date} · {d.source} · {d.candidates.length} candidates
                    </div>
                  </div>
                  <div class="row">
                    <button class="btn small" onClick={() => resolveDup(d.id, { action: "merge", wmmaId: d.candidates[0] })}>
                      Merge
                    </button>
                    <button class="btn small" onClick={() => resolveDup(d.id, { action: "import" })}>
                      Keep both
                    </button>
                    <button class="btn small ghost" onClick={() => resolveDup(d.id, { action: "discard" })}>
                      Discard
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div class="card span-12">
          <h2>History</h2>
          {runs.error && <ErrorBox error={runs.error} />}
          {runs.loading ? (
            <Loading h={120} />
          ) : (runs.data?.runs ?? []).length === 0 ? (
            <div class="empty">No imports yet</div>
          ) : (
            <table class="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Source</th>
                  <th class="r">Added</th>
                  <th class="r hide-sm">Skipped</th>
                </tr>
              </thead>
              <tbody>
                {runs.data!.runs.slice(0, 30).map((r: any) => (
                  <tr>
                    <td class="small">{new Date(r.started).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                    <td>
                      {r.source}
                      {r.errors.length > 0 && <span class="pill over" style={{ marginLeft: 6 }}>error</span>}
                    </td>
                    <td class="r num">{r.added}</td>
                    <td class="r num muted hide-sm">{r.skipped_duplicates}</td>
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
