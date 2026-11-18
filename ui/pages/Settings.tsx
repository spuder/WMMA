import { useState } from "preact/hooks";
import { api, store, useApi } from "../api";
import { ErrorBox, Loading, Sheet, toast } from "../components/ui";
import { useApp } from "../app";

type SimplefinAccount = { id: string; name: string; kindHint: string | null; balance: string; asOf: string; linkedAccountSlug: string | null };
type SimplefinMapping = { skip?: boolean; entity?: string; kind?: string; slug?: string | undefined };

export function Settings() {
  const s = useApi<any>("/settings");
  const me = useApi<any>("/status");
  const accountData = useApi<{ accounts: any[] }>("/accounts");
  const { entities, reloadEntities } = useApp();
  const [key, setKey] = useState("");
  const [simplefinToken, setSimplefinToken] = useState("");
  const [simplefinBusy, setSimplefinBusy] = useState(false);
  const [simplefinWizard, setSimplefinWizard] = useState(false);
  const [simplefinAccounts, setSimplefinAccounts] = useState<SimplefinAccount[]>([]);
  const [simplefinMappings, setSimplefinMappings] = useState<Record<string, SimplefinMapping>>({});
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
      await openSimplefinWizard();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSimplefinBusy(false);
    }
  };
  const openSimplefinWizard = async () => {
    setSimplefinBusy(true);
    try {
      const preview = await api<{ accounts: SimplefinAccount[]; mappings: Record<string, SimplefinMapping> }>("/simplefin/accounts");
      const activeEntities = entities.filter((e) => e.status === "active");
      const defaultEntity = activeEntities.find((e) => e.type === "personal")?.slug ?? activeEntities[0]?.slug ?? "";
      const existing = accountData.data?.accounts ?? (await api<{ accounts: any[] }>("/accounts")).accounts;
      const mapped: Record<string, SimplefinMapping> = {};
      for (const account of preview.accounts) {
        const current = preview.mappings[account.id];
        const linked = existing.find((a: any) => a.slug === account.linkedAccountSlug);
        mapped[account.id] = current ?? {
          ...(account.linkedAccountSlug ? { slug: account.linkedAccountSlug } : {}),
          entity: linked?.default_entity ?? defaultEntity,
          kind: account.kindHint ?? "bank",
          skip: false,
        };
      }
      setSimplefinAccounts(preview.accounts);
      setSimplefinMappings(mapped);
      setSimplefinWizard(true);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSimplefinBusy(false);
    }
  };
  const setSimplefinMapping = (id: string, patch: Partial<SimplefinMapping>) => {
    setSimplefinMappings((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  };
  const saveSimplefinWizard = async () => {
    const mappings = Object.fromEntries(simplefinAccounts.map((a) => [a.id, simplefinMappings[a.id] ?? { skip: true }]));
    const selectedCount = Object.values(mappings).filter((mapping) => !mapping.skip).length;
    setSimplefinBusy(true);
    try {
      await api("/simplefin/accounts", { method: "POST", body: { accounts: mappings } });
      const r = await api<any>("/sync/simplefin", { body: {} });
      toast(`SimpleFIN ready: ${selectedCount} account(s) connected, ${r.added} transaction(s) imported`);
      setSimplefinWizard(false);
      s.reload();
      accountData.reload();
    } catch (e) {
      toast((e as Error).message);
      s.reload();
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
            <div class="sub">Suggests categories for new transactions; confident picks are applied automatically. Get your Jev API key from <a href="https://console.typesafe.ai/home" target="_blank" rel="noreferrer" style={{ color: "var(--accent)", fontWeight: 650 }}>TypeSafe AI ↗</a>.</div>
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
              <div class="small">1. Add the banks you want to connect in <a href="https://beta-bridge.simplefin.org/my-account" target="_blank" rel="noreferrer" style={{ color: "var(--accent)", fontWeight: 650 }}>your SimpleFIN Bridge account</a>.</div>
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
                    <button class="btn" disabled={simplefinBusy || accountData.loading} onClick={openSimplefinWizard}>{simplefinBusy ? "Loading accounts…" : s.data.simplefin.accountsConfigured ? "Manage account mappings" : "Set up accounts"}</button>
                  </div>}
                </>
              ) : (
                <div class="muted small">Encrypted secret storage is unavailable. Ask the server administrator to restore the secret-key volume.</div>
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
      {simplefinWizard && <SimplefinSetupWizard
        accounts={simplefinAccounts}
        mappings={simplefinMappings}
        entities={entities.filter((e) => e.status === "active")}
        existingAccounts={(accountData.data?.accounts ?? []).filter((a: any) => a.status === "open")}
        onEntityCreated={reloadEntities}
        busy={simplefinBusy}
        onChange={setSimplefinMapping}
        onClose={() => setSimplefinWizard(false)}
        onSave={saveSimplefinWizard}
      />}
    </div>
  );
}

const ACCOUNT_KINDS: Array<[string, string]> = [
  ["bank", "Cash · checking or savings"],
  ["credit", "Credit card"],
  ["investment", "Investment"],
  ["loan", "Loan"],
];

function SimplefinSetupWizard({
  accounts,
  mappings,
  entities,
  existingAccounts,
  onEntityCreated,
  busy,
  onChange,
  onClose,
  onSave,
}: {
  accounts: SimplefinAccount[];
  mappings: Record<string, SimplefinMapping>;
  entities: Array<{ slug: string; name: string; type?: string }>;
  existingAccounts: Array<{ slug: string; name: string; default_entity: string }>;
  onEntityCreated: () => void;
  busy: boolean;
  onChange: (id: string, patch: Partial<SimplefinMapping>) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const [profiles, setProfiles] = useState(entities);
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("schedule_c");
  const [creatingProfile, setCreatingProfile] = useState(false);
  const included = accounts.filter((a) => !mappings[a.id]?.skip);
  const canSave = !busy && included.length > 0 && included.every((a) => Boolean(mappings[a.id]?.entity));
  const createProfile = async (accountId: string) => {
    if (!newName.trim()) return;
    setCreatingProfile(true);
    try {
      const profile = await api<{ slug: string; name: string; type: string }>("/entities", { body: { name: newName.trim(), type: newType } });
      setProfiles((current) => [...current, profile]);
      onChange(accountId, { entity: profile.slug });
      setNewName("");
      setAddingFor(null);
      onEntityCreated();
      toast(`${profile.name} added`);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setCreatingProfile(false);
    }
  };
  return (
    <Sheet open onClose={onClose} title="Set up SimpleFIN accounts">
      <div class="stack">
        <div class="muted small">Choose which bank accounts to add. For each one, select the business or personal profile that owns it.</div>
        {accounts.length === 0 ? (
          <div class="empty">No US dollar accounts were returned by SimpleFIN. Check your connected banks in SimpleFIN Bridge.</div>
        ) : (
          <div class="list">
            {accounts.map((account) => {
              const mapping = mappings[account.id] ?? {};
              const selected = !mapping.skip;
              return (
                <div class="card flat stack" style={{ gap: 10, marginBottom: 8 }}>
                  <label class="row" style={{ cursor: "pointer", alignItems: "flex-start" }}>
                    <input type="checkbox" checked={selected} onChange={(e) => onChange(account.id, { skip: !(e.target as HTMLInputElement).checked })} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <strong>{account.name}</strong>
                      {account.linkedAccountSlug && <div class="muted tiny">Already linked to a WMMA account</div>}
                    </span>
                    <span class="num small">{account.balance}</span>
                  </label>
                  {selected && <div class="stack" style={{ gap: 10 }}>
                    <div class="field">
                      <label>Add as</label>
                      {account.linkedAccountSlug ? (
                        <div class="muted small">Already linked to {existingAccounts.find((a) => a.slug === account.linkedAccountSlug)?.name ?? "a WMMA account"}.</div>
                      ) : (
                        <select class="input" value={mapping.slug ?? ""} onChange={(e) => onChange(account.id, { slug: (e.target as HTMLSelectElement).value || undefined })}>
                          <option value="">Create a new account</option>
                          {existingAccounts.map((existing) => {
                            const taken = accounts.some((other) => other.id !== account.id && (other.linkedAccountSlug === existing.slug || (!mappings[other.id]?.skip && mappings[other.id]?.slug === existing.slug)));
                            return <option value={existing.slug} disabled={taken}>{existing.name} · {profiles.find((entity) => entity.slug === existing.default_entity)?.name ?? existing.default_entity}{taken ? " (already chosen)" : ""}</option>;
                          })}
                        </select>
                      )}
                    </div>
                    <div class="field">
                      <label>Belongs to</label>
                      <select class="input" value={mapping.entity ?? ""} onChange={(e) => {
                        const value = (e.target as HTMLSelectElement).value;
                        if (value === "__new__") {
                          setAddingFor(account.id);
                          onChange(account.id, { entity: "" });
                        } else onChange(account.id, { entity: value });
                      }}>
                        <option value="" disabled>Choose profile</option>
                        {profiles.map((entity) => <option value={entity.slug}>{entity.name}</option>)}
                        <option value="__new__">＋ Create a new business or personal profile</option>
                      </select>
                      {addingFor === account.id && <div class="card flat stack" style={{ marginTop: 8, gap: 8, background: "var(--surface-2)" }}>
                        <strong class="small">New business or personal profile</strong>
                        <input class="input" value={newName} onInput={(e) => setNewName((e.target as HTMLInputElement).value)} placeholder="Business name" autoFocus />
                        <select class="input" value={newType} onChange={(e) => setNewType((e.target as HTMLSelectElement).value)}>
                          <option value="schedule_c">Business · Schedule C</option>
                          <option value="s_corp_1120s">Business · S corp</option>
                          <option value="partnership_1065">Business · Partnership</option>
                          <option value="schedule_e">Rental · Schedule E</option>
                          <option value="personal">Personal profile</option>
                        </select>
                        <div class="row">
                          <button class="btn primary small" disabled={!newName.trim() || creatingProfile} onClick={() => createProfile(account.id)}>{creatingProfile ? "Adding…" : "Add and select"}</button>
                          <button class="btn ghost small" disabled={creatingProfile} onClick={() => setAddingFor(null)}>Cancel</button>
                        </div>
                      </div>}
                    </div>
                    <div class="field">
                      <label>Account type</label>
                      <select class="input" value={mapping.kind ?? account.kindHint ?? "bank"} onChange={(e) => onChange(account.id, { kind: (e.target as HTMLSelectElement).value })}>
                        {ACCOUNT_KINDS.map(([value, label]) => <option value={value}>{label}</option>)}
                      </select>
                    </div>
                  </div>}
                </div>
              );
            })}
          </div>
        )}
        {profiles.length === 0 && <div class="muted small">Create a profile from any “Belongs to” selector above.</div>}
        <div class="spread">
          <button class="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button class="btn primary" disabled={!canSave} onClick={onSave}>{busy ? "Connecting accounts…" : `Save and sync ${included.length} account${included.length === 1 ? "" : "s"}`}</button>
        </div>
      </div>
    </Sheet>
  );
}
