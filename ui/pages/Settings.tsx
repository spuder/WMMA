import { useState } from "preact/hooks";
import { api, store, useApi } from "../api";
import { ErrorBox, Loading, toast } from "../components/ui";

export function Settings() {
  const s = useApi<any>("/settings");
  const me = useApi<any>("/status");
  const [key, setKey] = useState("");
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
            <div class="sub">Suggests categories for new transactions; confident picks are applied automatically.</div>
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
                <div class="muted small">To save a key here, set WMMA_SECRET_KEY on the server (16+ characters), or set JEV_API_KEY.</div>
              )}
            </>
          )}
        </div>

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
    </div>
  );
}
