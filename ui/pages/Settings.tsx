import { useEffect, useState } from "preact/hooks";
import { api, store, useApi } from "../api";
import { Avatar, CatName, ErrorBox, Icon, Loading, toast } from "../components/ui";
import { refreshSimplefinAccounts } from "../components/simplefin";
import { loadLogos } from "../logos";

export function Settings() {
  const s = useApi<any>("/settings");
  const me = useApi<any>("/status");
  const [key, setKey] = useState("");
  const [simplefinToken, setSimplefinToken] = useState("");
  const [simplefinBusy, setSimplefinBusy] = useState(false);
  const [theme, setTheme] = useState(store.get("theme") ?? "system");

  const applyTheme = (t: string) => {
    setTheme(t);
    store.set("theme", t === "system" ? null : t);
    if (t === "system") delete document.documentElement.dataset["theme"];
    else document.documentElement.dataset["theme"] = t;
    window.dispatchEvent(new Event("wmma-theme"));
  };
  const saveKey = async (value: string | null) => {
    try {
      await api("/settings", { method: "PUT", body: { jevApiKey: value } });
      setKey("");
      s.reload();
      toast(value ? "Jev key saved (encrypted)" : "Jev key removed");
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const connectSimplefin = async () => {
    setSimplefinBusy(true);
    try {
      await api("/settings", { method: "PUT", body: { simplefinSetupToken: simplefinToken.trim() } });
      setSimplefinToken("");
      s.reload();
      await refreshSimplefinAccounts().catch(() => 0); // prime the account list; Imports can retry
      toast("SimpleFIN connected. Switch on the accounts to sync on the Imports page.");
      location.hash = "#/imports";
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSimplefinBusy(false);
    }
  };
  const disconnectSimplefin = async () => {
    setSimplefinBusy(true);
    try {
      await api("/settings", { method: "PUT", body: { simplefinDisconnect: true } });
      s.reload();
      toast("SimpleFIN disconnected");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSimplefinBusy(false);
    }
  };

  return (
    <div class="stack">
      <div class="topbar">
        <h1>Settings</h1>
      </div>
      {s.error && <ErrorBox error={s.error} />}
      <div class="grid">
        <div class="card span-6 stack">
          <div>
            <h2>Jev categorization</h2>
            <div class="sub">Suggests categories for new transactions; confident picks are applied automatically. Get your Jev API key from <a href="https://console.typesafe.ai/home" target="_blank" rel="noreferrer" style={{ color: "var(--accent-text)", fontWeight: 650 }}>TypeSafe AI ↗</a>.</div>
          </div>
          {s.loading ? (
            <Loading h={80} />
          ) : (
            <>
              <div class="spread">
                <span>Status</span>
                <span class={`pill ${s.data.jev.configured ? "ok" : "zero"}`}>
                  {s.data.jev.configured ? `Connected · ${s.data.jev.source === "env" ? "from environment" : "set here"}` : "Not configured"}
                </span>
              </div>
              {s.data.jev.source === "env" ? (
                <div class="muted small">The key comes from JEV_API_KEY in the environment. Change it there.</div>
              ) : s.data.jev.canStoreInUi ? (
                <>
                  <div class="field">
                    <label>API key</label>
                    <input class="input" type="password" autoComplete="off" placeholder={s.data.jev.configured ? "•••••••• (saved)" : "Paste your Jev key"} value={key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} />
                  </div>
                  <div class="row">
                    <button class="btn primary" disabled={key.trim().length < 8} onClick={() => saveKey(key.trim())}>
                      Save key
                    </button>
                    {s.data.jev.configured && (
                      <button class="btn ghost danger" onClick={() => saveKey(null)}>
                        Remove
                      </button>
                    )}
                  </div>
                  <div class="muted tiny">Stored encrypted on the server. It is never shown again or written to the log.</div>
                </>
              ) : (
                <div class="muted small">Encrypted secret storage is unavailable. Ask the server administrator to restore the secret-key volume.</div>
              )}
            </>
          )}
        </div>

        <div class="card span-6 stack">
          <div>
            <h2>SimpleFIN bank sync</h2>
            <div class="sub">Add your banks to SimpleFIN Bridge, then connect them to WMMA.</div>
          </div>
          {s.loading ? (
            <Loading h={80} />
          ) : (
            <>
              <div class="spread">
                <span>Status</span>
                <span class={`pill ${s.data.simplefin.configured ? "ok" : "zero"}`}>
                  {s.data.simplefin.configured ? `Connected · ${s.data.simplefin.source === "env" ? "from environment" : "set here"}` : "Not configured"}
                </span>
              </div>
              <div class="small">1. Add the banks you want to connect in <a href="https://beta-bridge.simplefin.org/my-account" target="_blank" rel="noreferrer" style={{ color: "var(--accent-text)", fontWeight: 650 }}>your SimpleFIN Bridge account</a>.</div>
              {s.data.simplefin.canStoreInUi ? (
                <>
                  <div class="small">2. In SimpleFIN Bridge, create and copy a Setup Token. Paste it below; WMMA exchanges it for an Access URL and stores that URL encrypted.</div>
                  <div class="field">
                    <label>SimpleFIN Setup Token</label>
                    <input class="input" type="password" autoComplete="off" placeholder="Paste the one-time token" value={simplefinToken} onInput={(e) => setSimplefinToken((e.target as HTMLInputElement).value)} />
                  </div>
                  <div class="row">
                    <button class="btn primary" disabled={!simplefinToken.trim() || simplefinBusy} onClick={connectSimplefin}>
                      {simplefinBusy ? "Connecting…" : "Connect SimpleFIN"}
                    </button>
                    {s.data.simplefin.configured && (
                      <button class="btn ghost danger" disabled={simplefinBusy} onClick={disconnectSimplefin}>Disconnect</button>
                    )}
                  </div>
                  <div class="muted tiny">Setup Tokens can only be claimed once. WMMA never displays or logs the saved Access URL.</div>
                  {s.data.simplefin.configured && <div class="card flat stack" style={{ gap: 6, background: "var(--surface-2)" }}>
                    <strong class="small">Accounts</strong>
                    <div class="muted small">Switch accounts on and off, and pick the business or personal profile each belongs to, on the Imports page.</div>
                    <a class="btn" href="#/imports">Manage synced accounts</a>
                  </div>}
                </>
              ) : (
                <div class="muted small">Encrypted secret storage is unavailable. Ask the server administrator to restore the secret-key volume.</div>
              )}
            </>
          )}
        </div>

        <LogosCard />
        <RulesCard />

        <div class="card span-6 stack">
          <div>
            <h2>Appearance</h2>
            <div class="sub">Saved on this device.</div>
          </div>
          <div class="seg" style={{ alignSelf: "flex-start" }}>
            {["system", "light", "dark"].map((t) => (
              <button class={theme === t ? "active" : ""} onClick={() => applyTheme(t)}>
                {t[0]!.toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div class="card span-12 stack" style={{ gap: 6 }}>
          <h2>About</h2>
          <div class="spread small">
            <span class="muted">Signed in as</span>
            <span>{me.data?.user ?? "…"}</span>
          </div>
          <div class="spread small">
            <span class="muted">hledger-web</span>
            <span>{me.data?.hledgerWeb ?? "unreachable"}</span>
          </div>
          <div class="spread small">
            <span class="muted">Timezone</span>
            <span>{me.data?.timezone ?? "…"}</span>
          </div>
          <div class="spread small">
            <span class="muted">Version</span>
            {me.data?.commit ? (
              <a href={`https://github.com/spuder/WMMA/commit/${me.data.commit}`} target="_blank" rel="noopener noreferrer" title={me.data.commit}>
                <code class="small">{me.data.commit.slice(0, 7)}</code>
              </a>
            ) : (
              <span class="muted">{me.data ? "unknown" : "…"}</span>
            )}
          </div>
          <div class="spread small">
            <span class="muted">AI access</span>
            <code class="small">claude mcp add --transport http wmma {location.origin}/mcp</code>
          </div>
        </div>
      </div>
    </div>
  );
}

type LogoCoverage = {
  transactions: { total: number; covered: number };
  payees: { total: number; covered: number };
  missing: Array<{ key: string; payee: string; count: number; domain: string | null; status: string }>;
  fetchEnabled: boolean;
};

const pct = (c: { total: number; covered: number }) => (c.total ? Math.round((1000 * c.covered) / c.total) / 10 : 0);
const MISSING_LABEL: Record<string, string> = { none: "no website known", not_found: "no logo found", pending: "not fetched yet", logo: "logo found ✓", glyph: "icon set ✓" };
const LOGO_PAGE = 20;

function LogosCard() {
  const cov = useApi<LogoCoverage>("/logos/coverage?limit=5000");
  // The first list seen stays put: fixed payees keep their row (now showing the logo) until the page is reloaded.
  const [snapshot, setSnapshot] = useState<LogoCoverage["missing"] | null>(null);
  const [shown, setShown] = useState(LOGO_PAGE);
  useEffect(() => {
    if (cov.data && !snapshot) setSnapshot(cov.data.missing);
  }, [cov.data]);
  const [busy, setBusy] = useState(false);
  const fetchNow = async () => {
    setBusy(true);
    try {
      const r = await api<{ fetched: number; found: number }>("/logos/prefetch", { body: {} });
      toast(r.fetched ? `Found ${r.found} of ${r.fetched} logos` : "All logos are up to date");
      cov.reload();
      void loadLogos(true);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const toggle = async () => {
    try {
      await api("/settings", { method: "PUT", body: { settings: { "ui.logos_fetch": cov.data?.fetchEnabled ? "off" : null } } });
      cov.reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const c = cov.data;
  return (
    <div class="card span-6 stack">
      <div>
        <h2>Merchant logos</h2>
        <div class="sub">Fetched by this server from each merchant's own website (Google and DuckDuckGo icon services as fallbacks). Only website names are sent, never transactions.</div>
      </div>
      {cov.error && <ErrorBox error={cov.error} />}
      {!c && !cov.error && <Loading h={80} />}
      {c && (
        <>
          <div class="stack" style={{ gap: 6 }}>
            <div class="spread small">
              <span>Transactions with a logo</span>
              <strong class="num">{pct(c.transactions)}%</strong>
            </div>
            <div class={`bar${pct(c.transactions) < 90 ? " warn" : ""}`}>
              <div style={{ width: `${pct(c.transactions)}%` }} />
            </div>
            <div class="muted tiny">
              {c.payees.covered} of {c.payees.total} payees · {c.transactions.covered} of {c.transactions.total} transactions
            </div>
          </div>
          <div class="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button class="btn" disabled={busy || !c.fetchEnabled} onClick={fetchNow}>
              {busy ? "Fetching…" : "Fetch missing logos"}
            </button>
            <button class="btn ghost" onClick={toggle}>
              {c.fetchEnabled ? "Turn off logo fetching" : "Turn on logo fetching"}
            </button>
          </div>
          {snapshot && snapshot.length > 0 && (
            <details>
              <summary class="small" style={{ cursor: "pointer" }}>
                Most frequent payees without a logo <span class="muted">· {snapshot.length}</span>
              </summary>
              <div class="muted tiny" style={{ margin: "6px 0 2px" }}>Tap a payee to set the website its logo comes from.</div>
              <div class="list">
                {snapshot.slice(0, shown).map((m) => (
                  <MissingLogoRow key={m.key} m={c.missing.find((x) => x.key === m.key) ?? { ...m, status: "logo" }} onSaved={cov.reload} />
                ))}
              </div>
              {shown < snapshot.length && (
                <button class="btn ghost" style={{ width: "100%", marginTop: 6, gap: 6 }} onClick={() => setShown((n) => n + LOGO_PAGE)}>
                  Show {Math.min(LOGO_PAGE, snapshot.length - shown)} more
                  <span style={{ display: "inline-flex", transform: "rotate(90deg)" }}>
                    <Icon.chevron />
                  </span>
                </button>
              )}
            </details>
          )}
        </>
      )}
    </div>
  );
}

/** One payee without a logo: tap to type the website its logo should come from. */
function MissingLogoRow({ m, onSaved }: { m: LogoCoverage["missing"][number]; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.domain ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const domainShown = saved ?? m.domain;
  const done = m.status === "logo" || m.status === "glyph";
  const save = async () => {
    const domain = draft.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    if (!domain) return;
    setSaving(true);
    try {
      await api(`/logos/payees/${encodeURIComponent(m.payee)}`, { method: "PUT", body: { domain } });
      // Look the new site up right away so the row shows whether it has a usable icon.
      const r = await api<{ found: boolean; retried: boolean }>(`/logos/img/${encodeURIComponent(domain)}/retry`, { method: "POST" }).catch(() => null);
      toast(r?.found ? `Logo found for ${m.payee}` : r?.retried ? `No logo found on ${domain}` : `Website saved for ${m.payee}`);
      setSaved(domain);
      setEditing(false);
      onSaved();
      void loadLogos(true);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const cancel = () => (setEditing(false), setDraft(domainShown ?? ""));
  return (
    <div style={{ padding: "10px 0", borderBottom: "1px solid var(--line)" }}>
      <button
        type="button"
        class="row"
        style={{ width: "100%", background: "none", border: 0, padding: 0, color: "inherit", font: "inherit", textAlign: "left", cursor: "pointer", gap: 12 }}
        onClick={() => (editing ? cancel() : setEditing(true))}
        aria-expanded={editing}
        title="Set logo website"
      >
        <Avatar name={m.payee} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {m.payee} <span class="muted">· {m.count}×</span>
          </span>
          <span class="muted small" style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: done ? "var(--accent-text)" : undefined }}>
            {domainShown ? `${domainShown} · ` : ""}
            {MISSING_LABEL[m.status] ?? m.status}
          </span>
        </span>
        <span class="muted" style={{ flexShrink: 0, fontSize: 18, padding: "0 4px" }} aria-hidden>
          {editing ? "✕" : "✎"}
        </span>
      </button>
      {editing && (
        <form
          class="row"
          style={{ gap: 8, marginTop: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            class="input"
            style={{ flex: 1, minWidth: 0 }}
            value={draft}
            onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === "Escape" && cancel()}
            placeholder="example.com"
            inputMode="url"
            autoFocus
          />
          <button class="btn" type="submit" disabled={saving || !draft.trim() || draft.trim() === domainShown}>
            {saving ? "Saving…" : "Save"}
          </button>
        </form>
      )}
    </div>
  );
}

type RuleRow = {
  id: string;
  match: { payeeKey?: string; recurringKey?: string; payeeContains?: string; amountMin?: number; amountMax?: number; account?: string };
  target_account: string;
  entity_override: string | null;
  created_from: "swipe" | "manual";
  hit_count: number;
};

const describeMatch = (m: RuleRow["match"]) =>
  [
    m.payeeKey ? `payee is “${m.payeeKey}”` : null,
    m.recurringKey ? `recurring “${m.recurringKey}”` : null,
    m.payeeContains ? `payee contains “${m.payeeContains}”` : null,
    m.amountMax !== undefined && m.amountMax < 0 && m.amountMin === undefined ? "money out" : null,
    m.amountMin !== undefined && m.amountMin > 0 && m.amountMax === undefined ? "money in" : null,
    m.account ? `account ${m.account.split(":").pop()}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

/** Rules categorize new transactions on import (before Jev). Made from "apply to similar", Review, or recurring series. */
function RulesCard() {
  const rules = useApi<{ rules: RuleRow[] }>("/rules");
  const [shown, setShown] = useState(LOGO_PAGE);
  const remove = async (r: RuleRow) => {
    try {
      await api(`/rules/${encodeURIComponent(r.id)}`, { method: "DELETE" });
      toast("Rule deleted");
      rules.reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const list = rules.data?.rules ?? [];
  return (
    <div class="card span-6 stack">
      <div>
        <h2>Rules</h2>
        <div class="sub">
          New transactions that match a rule get its category automatically, before Jev is asked. Create one by setting a category on a transaction and choosing “Create a rule”.
        </div>
      </div>
      {rules.error && <ErrorBox error={rules.error} />}
      {!rules.data && !rules.error && <Loading h={80} />}
      {rules.data && list.length === 0 && <div class="muted small">No rules yet.</div>}
      {list.length > 0 && (
        <div class="list">
          {list.slice(0, shown).map((r) => (
            <div class="row" style={{ gap: 10, padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <CatName account={r.target_account} />
                </div>
                <div class="muted tiny" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  When {describeMatch(r.match)}
                  {r.entity_override ? ` · profile ${r.entity_override}` : ""} · used {r.hit_count}× · {r.created_from === "swipe" ? "learned in Review" : "manual"}
                </div>
              </div>
              <button class="btn ghost danger" style={{ height: 30, padding: "0 10px" }} onClick={() => remove(r)} aria-label="Delete rule">
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
      {shown < list.length && (
        <button class="btn ghost" style={{ width: "100%", gap: 6 }} onClick={() => setShown((n) => n + LOGO_PAGE)}>
          Show {Math.min(LOGO_PAGE, list.length - shown)} more
          <span style={{ display: "inline-flex", transform: "rotate(90deg)" }}>
            <Icon.chevron />
          </span>
        </button>
      )}
    </div>
  );
}
