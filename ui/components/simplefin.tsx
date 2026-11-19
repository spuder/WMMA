import { useState } from "preact/hooks";
import { api } from "../api";
import { useApp } from "../app";
import { Sheet, toast } from "./ui";

export type SimplefinMapping = { skip?: boolean; entity?: string; kind?: string; slug?: string | undefined };

export const ACCOUNT_KINDS: Array<[string, string]> = [
  ["bank", "Cash · checking or savings"],
  ["credit", "Credit card"],
  ["investment", "Investment"],
  ["loan", "Loan"],
];

const PROFILE_TYPES: Array<[string, string]> = [
  ["schedule_c", "Business · Schedule C"],
  ["s_corp_1120s", "Business · S corp"],
  ["partnership_1065", "Business · Partnership"],
  ["schedule_e", "Rental · Schedule E"],
  ["personal", "Personal profile"],
];

/**
 * Ask SimpleFIN for its current account list (one request against its daily quota).
 * The server keeps the result as a snapshot that /simplefin/status serves from then on.
 */
export async function refreshSimplefinAccounts(): Promise<number> {
  const r = await api<{ accounts: unknown[] }>("/simplefin/accounts");
  return r.accounts.length;
}

type LinkAccount = { id: string; name: string; kindHint: string | null; linkedAccountSlug: string | null };
type ExistingAccount = { slug: string; name: string; default_entity: string; status?: string };

/**
 * Connect one SimpleFIN account: which profile owns it, and whether it feeds a new
 * WMMA account or an existing one. Closing (Esc, scrim, Cancel) leaves it off.
 */
export function SimplefinLinkSheet({
  account,
  mapping,
  existingAccounts,
  takenSlugs,
  editing,
  onClose,
  onSave,
}: {
  account: LinkAccount;
  mapping: SimplefinMapping | undefined;
  existingAccounts: ExistingAccount[];
  /** WMMA accounts already fed by a different SimpleFIN account. */
  takenSlugs: Set<string>;
  /** True when changing an account that already syncs (vs. switching one on). */
  editing: boolean;
  onClose: () => void;
  onSave: (mapping: SimplefinMapping) => Promise<void>;
}) {
  const { entities, reloadEntities } = useApp();
  const [profiles, setProfiles] = useState(entities.filter((e) => e.status === "active"));
  const linked = existingAccounts.find((a) => a.slug === account.linkedAccountSlug);
  const [slug, setSlug] = useState<string>(mapping?.slug ?? account.linkedAccountSlug ?? "");
  const [entity, setEntity] = useState<string>(
    mapping?.entity || linked?.default_entity || profiles.find((e) => e.type === "personal")?.slug || profiles[0]?.slug || "",
  );
  const [kind, setKind] = useState<string>(mapping?.kind ?? account.kindHint ?? "bank");
  const [adding, setAdding] = useState(profiles.length === 0);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("schedule_c");
  const [busy, setBusy] = useState(false);

  const createProfile = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const profile = await api<{ slug: string; name: string; type: string; status: string }>("/entities", { body: { name: newName.trim(), type: newType } });
      setProfiles((current) => [...current, profile as any]);
      setEntity(profile.slug);
      setNewName("");
      setAdding(false);
      reloadEntities();
      toast(`${profile.name} added`);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    try {
      await onSave({ ...(slug ? { slug } : {}), entity, kind, skip: false });
    } finally {
      setBusy(false);
    }
  };
  const pickExisting = (value: string) => {
    setSlug(value);
    const target = existingAccounts.find((a) => a.slug === value);
    if (target) setEntity(target.default_entity);
  };

  return (
    <Sheet open onClose={onClose} title={editing ? "Edit synced account" : "Sync this account"}>
      <div class="stack">
        <div class="card flat" style={{ background: "var(--surface-2)" }}>
          <strong>{account.name}</strong>
        </div>
        <div class="field">
          <label>Add as</label>
          {account.linkedAccountSlug ? (
            <div class="muted small">Linked to {linked?.name ?? "an existing WMMA account"}.</div>
          ) : (
            <select class="input" value={slug} onChange={(e) => pickExisting((e.target as HTMLSelectElement).value)}>
              <option value="">Create a new account</option>
              {existingAccounts.map((existing) => {
                const taken = takenSlugs.has(existing.slug);
                return (
                  <option value={existing.slug} disabled={taken}>
                    {existing.name} · {profiles.find((p) => p.slug === existing.default_entity)?.name ?? existing.default_entity}
                    {taken ? " (already linked)" : ""}
                  </option>
                );
              })}
            </select>
          )}
        </div>
        <div class="field">
          <label>Belongs to</label>
          <select
            class="input"
            value={adding ? "__new__" : entity}
            onChange={(e) => {
              const value = (e.target as HTMLSelectElement).value;
              if (value === "__new__") setAdding(true);
              else {
                setAdding(false);
                setEntity(value);
              }
            }}
          >
            {profiles.length === 0 && <option value="" disabled>Choose profile</option>}
            {profiles.map((p) => <option value={p.slug}>{p.name}</option>)}
            <option value="__new__">＋ New business or personal profile</option>
          </select>
          {adding && (
            <div class="card flat stack" style={{ marginTop: 8, gap: 8, background: "var(--surface-2)" }}>
              <input class="input" value={newName} onInput={(e) => setNewName((e.target as HTMLInputElement).value)} placeholder="Business name" autoFocus />
              <select class="input" value={newType} onChange={(e) => setNewType((e.target as HTMLSelectElement).value)}>
                {PROFILE_TYPES.map(([value, label]) => <option value={value}>{label}</option>)}
              </select>
              <div class="row">
                <button class="btn primary small" disabled={!newName.trim() || busy} onClick={createProfile}>Add and select</button>
                {profiles.length > 0 && <button class="btn ghost small" disabled={busy} onClick={() => setAdding(false)}>Cancel</button>}
              </div>
            </div>
          )}
        </div>
        {!slug && !account.linkedAccountSlug && (
          <div class="field">
            <label>Account type</label>
            <select class="input" value={kind} onChange={(e) => setKind((e.target as HTMLSelectElement).value)}>
              {ACCOUNT_KINDS.map(([value, label]) => <option value={value}>{label}</option>)}
            </select>
          </div>
        )}
        <div class="spread">
          <button class="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button class="btn primary" disabled={busy || adding || !entity} onClick={save}>
            {busy ? "Saving…" : editing ? "Save" : "Turn on sync"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
