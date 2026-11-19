import { useState } from "preact/hooks";
import { api, store, useApi } from "../api";
import { ErrorBox, Loading, toast } from "../components/ui";
import { useSimplefinWizard } from "../components/simplefin";
import { loadLogos } from "../logos";

export function Settings() {
  const s = useApi<any>("/settings");
  const me = useApi<any>("/status");
  const [key, setKey] = useState("");
  const [simplefinToken, setSimplefinToken] = useState("");
  const [simplefinBusy, setSimplefinBusy] = useState(false);
  const wizard = useSimplefinWizard(() => s.reload());
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
      toast("SimpleFIN connected. Choose which accounts to add.");
      await wizard.start();
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
                    <div class="spread small"><strong>Account setup</strong><span class="muted">{s.data.simplefin.accountsConfigured ? "Ready" : "Needs setup"}</span></div>
                    <div class="muted small">Choose the SimpleFIN accounts to add and which business or personal profile each belongs to.</div>
                    <button class="btn" disabled={simplefinBusy || wizard.busy} onClick={wizard.start}>{wizard.busy ? "Loading accounts…" : s.data.simplefin.accountsConfigured ? "Manage account mappings" : "Set up accounts"}</button>
                  </div>}
                </>
              ) : (
                <div class="muted small">Encrypted secret storage is unavailable. Ask the server administrator to restore the secret-key volume.</div>
              )}
            </>
          )}
        </div>

        <LogosCard />

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
            <span class="muted">AI access</span>
            <code class="small">claude mcp add --transport http wmma {location.origin}/mcp</code>
          </div>
        </div>
      </div>
      {wizard.element}
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
const MISSING_LABEL: Record<string, string> = { none: "no website known", not_found: "no logo found", pending: "not fetched yet" };

function LogosCard() {
  const cov = useApi<LogoCoverage>("/logos/coverage");
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
          {c.missing.length > 0 && (
            <details>
              <summary class="small" style={{ cursor: "pointer" }}>
                Most frequent payees without a logo
              </summary>
              <div class="list" style={{ marginTop: 6 }}>
                {c.missing.slice(0, 15).map((m) => (
                  <div class="spread small" style={{ padding: "5px 0", borderBottom: "1px solid var(--line)" }}>
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {m.payee} <span class="muted">· {m.count}×</span>
                    </span>
                    <span class="muted tiny">{m.domain ? `${m.domain}: ` : ""}{MISSING_LABEL[m.status] ?? m.status}</span>
                  </div>
                ))}
              </div>
              <div class="muted tiny" style={{ marginTop: 6 }}>Open one of their transactions and set its logo website.</div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
