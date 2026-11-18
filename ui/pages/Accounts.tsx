import { useState } from "preact/hooks";
import { api, money, today, useApi } from "../api";
import { ErrorBox, Loading, Sheet, toast } from "../components/ui";
import { useApp } from "../app";

const KIND_LABEL: Record<string, string> = {
  bank: "💵 Cash",
  credit: "💳 Credit cards",
  investment: "📈 Investments",
  vehicle: "🚗 Vehicles",
  real_estate: "🏠 Real estate",
  other_asset: "📦 Other assets",
  loan: "🏦 Loans",
};
const KIND_ORDER = ["bank", "credit", "investment", "real_estate", "vehicle", "other_asset", "loan"];
const TYPE_LABEL: Record<string, string> = {
  personal: "Personal",
  schedule_c: "Schedule C",
  s_corp_1120s: "S corp · 1120-S",
  partnership_1065: "Partnership · 1065",
  schedule_e: "Rentals · Schedule E",
};

export function Accounts() {
  const { entities, entity, reloadEntities } = useApp();
  const accts = useApi<{ accounts: any[] }>("/accounts");
  const all = useApi<{ entities: any[] }>("/entities?status=all");
  const [sheet, setSheet] = useState<null | "entity" | "account" | { valuation: any } | { archive: any }>(null);
  const reload = () => {
    accts.reload();
    all.reload();
    reloadEntities();
  };

  const list = (accts.data?.accounts ?? []).filter((a) => !entity || a.default_entity === entity);
  const byKind = KIND_ORDER.map((k) => [k, list.filter((a) => a.kind === k)] as const).filter(([, xs]) => xs.length);
  const total = list.reduce((s, a) => s + a.balance_cents, 0);

  return (
    <div class="stack">
      <div class="topbar">
        <h1>Accounts</h1>
        <button class="btn" onClick={() => setSheet("account")}>
          + Account
        </button>
      </div>
      {accts.error && <ErrorBox error={accts.error} />}
      {accts.loading ? (
        <Loading h={240} />
      ) : (
        <div class="grid">
          <div class="card hero span-12">
            <div class="upper">{entity ? entities.find((e) => e.slug === entity)?.name : "All accounts"}</div>
            <div class="big num">{money(total, true)}</div>
            <div class="muted small">{list.length} accounts</div>
          </div>
          {byKind.map(([kind, xs]) => (
            <div class="card span-6">
              <div class="spread">
                <h2>{KIND_LABEL[kind]}</h2>
                <span class="num muted small">{money(xs.reduce((s, a) => s + a.balance_cents, 0))}</span>
              </div>
              <div class="list">
                {xs.map((a) => (
                  <div class="item">
                    <div class="body">
                      <div class="title">
                        {a.name} {a.status === "closed" && <span class="pill zero">closed</span>}
                      </div>
                      <div class="meta">
                        {entities.find((e) => e.slug === a.default_entity)?.name ?? a.default_entity} · {a.hledger_account}
                      </div>
                    </div>
                    <div class="stack" style={{ gap: 2, alignItems: "flex-end" }}>
                      <span class={`num ${a.balance_cents < 0 ? "out" : ""}`} style={{ fontWeight: 650 }}>
                        {a.balance}
                      </span>
                      {["investment", "vehicle", "real_estate", "other_asset"].includes(a.kind) && (
                        <button class="btn ghost small" style={{ height: 24, padding: "0 4px", color: "var(--accent)" }} onClick={() => setSheet({ valuation: a })}>
                          Update value
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {list.length === 0 && <div class="card span-12 empty">No accounts yet. Add one, or import from YNAB / your bank.</div>}
        </div>
      )}

      <div class="spread" style={{ marginTop: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Entities</h2>
        <button class="btn" onClick={() => setSheet("entity")}>
          + Entity
        </button>
      </div>
      {all.error && <ErrorBox error={all.error} />}
      <div class="card" style={{ paddingTop: 4, paddingBottom: 4 }}>
        <div class="list">
          {(all.data?.entities ?? []).map((e: any) => (
            <div class="item">
              <div class="body">
                <div class="title">
                  {e.name} {e.status === "archived" && <span class="pill zero">archived</span>}
                </div>
                <div class="meta">{TYPE_LABEL[e.type] ?? e.type}</div>
              </div>
              {e.status === "active" && (
                <button class="btn ghost small danger" onClick={() => setSheet({ archive: e })}>
                  Archive
                </button>
              )}
            </div>
          ))}
          {!all.loading && !all.error && (all.data?.entities ?? []).length === 0 && (
            <div class="empty">No entities yet. Add an entity to organize accounts for your household or business.</div>
          )}
          {all.loading && <Loading h={64} />}
        </div>
      </div>

      <Sheet open={sheet === "entity"} onClose={() => setSheet(null)} title="New entity">
        <NewEntity
          onDone={() => {
            setSheet(null);
            reload();
          }}
        />
      </Sheet>
      <Sheet open={sheet === "account"} onClose={() => setSheet(null)} title="New account">
        <NewAccount
          onDone={() => {
            setSheet(null);
            reload();
          }}
        />
      </Sheet>
      {sheet && typeof sheet === "object" && "valuation" in sheet && (
        <Sheet open onClose={() => setSheet(null)} title={`Value of ${sheet.valuation.name}`}>
          <Valuation
            account={sheet.valuation}
            onDone={() => {
              setSheet(null);
              reload();
            }}
          />
        </Sheet>
      )}
      {sheet && typeof sheet === "object" && "archive" in sheet && (
        <Sheet open onClose={() => setSheet(null)} title={`Archive ${sheet.archive.name}?`}>
          <Archive
            entity={sheet.archive}
            onDone={() => {
              setSheet(null);
              reload();
            }}
          />
        </Sheet>
      )}
    </div>
  );
}

function NewEntity({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("schedule_c");
  const save = async () => {
    try {
      await api("/entities", { body: { name, type } });
      toast(`${name} added with its ${TYPE_LABEL[type]} categories`);
      onDone();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <div class="stack">
      <div class="field">
        <label>Name</label>
        <input class="input" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="Acme LLC" />
      </div>
      <div class="field">
        <label>Type (sets up categories that match the tax form)</label>
        <select class="input" value={type} onChange={(e) => setType((e.target as HTMLSelectElement).value)}>
          {Object.entries(TYPE_LABEL).map(([k, l]) => (
            <option value={k}>{l}</option>
          ))}
        </select>
      </div>
      <button class="btn primary block" disabled={!name.trim()} onClick={save}>
        Add entity
      </button>
    </div>
  );
}

function NewAccount({ onDone }: { onDone: () => void }) {
  const { entities, entity } = useApp();
  const initialEntity = entities.find((e) => e.slug === entity) ?? entities.find((e) => e.type === "personal") ?? entities[0];
  const [name, setName] = useState("");
  const [kind, setKind] = useState("bank");
  const [ownerType, setOwnerType] = useState(initialEntity?.type === "personal" || !initialEntity ? "personal" : "business");
  const [ent, setEnt] = useState(initialEntity?.slug ?? "");
  const matchingEntities = entities.filter((e) => ownerType === "personal" ? e.type === "personal" : e.type !== "personal");
  const changeOwnerType = (value: string) => {
    setOwnerType(value);
    const first = entities.find((e) => value === "personal" ? e.type === "personal" : e.type !== "personal");
    setEnt(first?.slug ?? "");
  };
  const save = async () => {
    try {
      await api("/accounts", { body: { name, kind, entity: ent } });
      toast(`${name} added`);
      onDone();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <div class="stack">
      <div class="field">
        <label>Name</label>
        <input class="input" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="Chase Checking" />
      </div>
      <div class="field">
        <label>Kind</label>
        <select class="input" value={kind} onChange={(e) => setKind((e.target as HTMLSelectElement).value)}>
          {KIND_ORDER.map((k) => (
            <option value={k}>{KIND_LABEL[k]}</option>
          ))}
        </select>
      </div>
      <div class="field">
        <label>Personal or business</label>
        <select class="input" value={ownerType} onChange={(e) => changeOwnerType((e.target as HTMLSelectElement).value)}>
          <option value="personal">Personal account</option>
          <option value="business">Business account</option>
        </select>
        <div class="muted small">Choose whether this account is for personal or business finances.</div>
      </div>
      <div class="field">
        <label>{ownerType === "personal" ? "Personal entity" : "Business entity"}</label>
        <select class="input" value={ent} onChange={(e) => setEnt((e.target as HTMLSelectElement).value)}>
          {matchingEntities.map((e) => (
            <option value={e.slug}>{e.name}</option>
          ))}
        </select>
        {matchingEntities.length === 0 && (
          <div class="muted small">No {ownerType} entity yet. Add one with “+ Entity” before creating this account.</div>
        )}
      </div>
      <button class="btn primary block" disabled={!name.trim() || !ent || matchingEntities.length === 0} onClick={save}>
        Add account
      </button>
    </div>
  );
}

function Valuation({ account, onDone }: { account: any; onDone: () => void }) {
  const [value, setValue] = useState((account.balance_cents / 100).toFixed(2));
  const [date, setDate] = useState(today());
  const save = async () => {
    try {
      const r = await api<{ change: string }>("/valuations", { body: { account: account.slug, date, value } });
      toast(`Value updated (${r.change.startsWith("-") ? "" : "+"}${r.change})`);
      onDone();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <div class="stack">
      <div class="field">
        <label>Value</label>
        <input class="input num" style={{ fontSize: 22, height: 54 }} inputMode="decimal" value={value} onInput={(e) => setValue((e.target as HTMLInputElement).value)} />
      </div>
      <div class="field">
        <label>As of</label>
        <input class="input" type="date" value={date} onInput={(e) => setDate((e.target as HTMLInputElement).value)} />
      </div>
      <div class="muted small">The change is recorded as an unrealized gain or loss, so it never shows up in a P&L.</div>
      <button class="btn primary block" onClick={save}>
        Save value
      </button>
    </div>
  );
}

function Archive({ entity, onDone }: { entity: any; onDone: () => void }) {
  const [date, setDate] = useState(today());
  const save = async () => {
    try {
      const r = await api<{ closedAccounts: string[] }>(`/entities/${entity.slug}`, { method: "PATCH", body: { archive: { date } } });
      toast(`${entity.name} archived · ${r.closedAccounts.length} account(s) closed`);
      onDone();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <div class="stack">
      <div class="muted">Its accounts are closed as of this date. History stays and still shows in past reports.</div>
      <div class="field">
        <label>Closing date</label>
        <input class="input" type="date" value={date} onInput={(e) => setDate((e.target as HTMLInputElement).value)} />
      </div>
      <button class="btn block danger" onClick={save}>
        Archive {entity.name}
      </button>
    </div>
  );
}
