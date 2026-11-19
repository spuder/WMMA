import { useState } from "preact/hooks";
import { api } from "../api";
import { useApp } from "../app";
import { Sheet, toast } from "./ui";

export type SimplefinAccount = { id: string; name: string; kindHint: string | null; balance: string; asOf: string; linkedAccountSlug: string | null };
export type SimplefinMapping = { skip?: boolean; entity?: string; kind?: string; slug?: string | undefined };

export const ACCOUNT_KINDS: Array<[string, string]> = [
  ["bank", "Cash · checking or savings"],
  ["credit", "Credit card"],
  ["investment", "Investment"],
  ["loan", "Loan"],
];


/**
 * The SimpleFIN account setup sheet and its loading/saving, shared by Settings and Imports.
 * `start()` fetches the live account list from SimpleFIN (one request against its daily quota).
 */
export function useSimplefinWizard(onSaved: (result: any) => void) {
  const { entities, reloadEntities } = useApp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accounts, setAccounts] = useState<SimplefinAccount[]>([]);
  const [mappings, setMappings] = useState<Record<string, SimplefinMapping>>({});
  const [existing, setExisting] = useState<any[]>([]);
  const active = entities.filter((e) => e.status === "active");

  const start = async () => {
    setBusy(true);
    try {
      const [preview, accts] = await Promise.all([
        api<{ accounts: SimplefinAccount[]; mappings: Record<string, SimplefinMapping> }>("/simplefin/accounts"),
        api<{ accounts: any[] }>("/accounts"),
      ]);
      const defaultEntity = active.find((e) => e.type === "personal")?.slug ?? active[0]?.slug ?? "";
      const mapped: Record<string, SimplefinMapping> = {};
      for (const account of preview.accounts) {
        const current = preview.mappings[account.id];
        const linked = accts.accounts.find((a: any) => a.slug === account.linkedAccountSlug);
        mapped[account.id] = current ?? {
          ...(account.linkedAccountSlug ? { slug: account.linkedAccountSlug } : {}),
          entity: linked?.default_entity ?? defaultEntity,
          kind: account.kindHint ?? "bank",
          skip: false,
        };
      }
      setAccounts(preview.accounts);
      setMappings(mapped);
      setExisting(accts.accounts.filter((a: any) => a.status === "open"));
      setOpen(true);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    const all = Object.fromEntries(accounts.map((a) => [a.id, mappings[a.id] ?? { skip: true }]));
    const selectedCount = Object.values(all).filter((m) => !m.skip).length;
    setBusy(true);
    try {
      await api("/simplefin/accounts", { method: "POST", body: { accounts: all } });
      const r = await api<any>("/sync/simplefin", { body: {} });
      toast(`SimpleFIN ready: ${selectedCount} account(s) connected, ${r.added} transaction(s) imported`);
      setOpen(false);
      onSaved(r);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const element = open ? (
    <SimplefinSetupWizard
      accounts={accounts}
      mappings={mappings}
      entities={active}
      existingAccounts={existing}
      onEntityCreated={reloadEntities}
      busy={busy}
      onChange={(id, patch) => setMappings((current) => ({ ...current, [id]: { ...current[id], ...patch } }))}
      onClose={() => setOpen(false)}
      onSave={save}
    />
  ) : null;
  return { start, busy, element };
}

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
