import { useState } from "preact/hooks";
import { api, money, today, useApi } from "../api";
import { ErrorBox, Loading, Sheet, toast } from "../components/ui";
import { businessStyle, useApp } from "../app";

const KIND_LABEL: Record<string, string> = {
  bank: "💵 Cash · checking & savings",
  credit: "💳 Credit cards",
  investment: "📈 Investments · crypto & private assets",
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
  const [sheet, setSheet] = useState<null | "entity" | "account" | { valuation: any } | { contribution: any } | { website: any } | { archive: any }>(null);
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
      </div>
      <section class="stack" style={{ gap: 8 }}>
        <div class="spread">
          <h2 style={{ margin: 0, fontSize: 18 }}>Businesses & personal finances</h2>
          <button class="btn" onClick={() => setSheet("entity")}>
            + Add business
          </button>
        </div>
        <div class="muted small">Set up a business or personal profile, then assign accounts and transactions to it. Filter activity and reports by profile.</div>
        {all.error && <ErrorBox error={all.error} />}
        <div class="card" style={{ paddingTop: 4, paddingBottom: 4 }}>
          <div class="list">
            {(all.data?.entities ?? []).map((e: any) => (
              <div class="item">
                <span class="business-icon" style={businessStyle(e.slug)}>{e.type === "personal" ? "👤" : "💼"}</span>
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
              <div class="empty">No businesses or personal profiles yet. Add one above before creating accounts.</div>
            )}
            {all.loading && <Loading h={64} />}
          </div>
        </div>
      </section>

      <div class="spread" style={{ marginTop: 8 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18 }}>Accounts</h2>
          <div class="muted small">Add accounts after creating the business or personal profile they belong to.</div>
        </div>
        <button class="btn" disabled={entities.length === 0} onClick={() => setSheet("account")}>
          {entities.length === 0 ? "Create a business first" : "+ Account"}
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
                      {a.kind === "investment" && (
                        <div class="small muted" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                          <span>Transferred in {money(a.contributed_cents ?? 0)}</span>
                          {a.website_url ? (
                            <>
                              <a href={a.website_url} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>Investment website ↗</a>
                              <button class="btn ghost small" style={{ height: 24, padding: "0 4px" }} onClick={() => setSheet({ website: a })}>Edit link</button>
                            </>
                          ) : (
                            <button class="btn ghost small" style={{ height: 24, padding: "0 4px", color: "var(--accent)" }} onClick={() => setSheet({ website: a })}>Add website</button>
                          )}
                        </div>
                      )}
                    </div>
                    <div class="stack" style={{ gap: 2, alignItems: "flex-end" }}>
                      {a.kind === "investment" && <span class="muted tiny">Current value</span>}
                      <span class={`num ${a.balance_cents < 0 ? "out" : ""}`} style={{ fontWeight: 650 }}>
                        {a.balance}
                      </span>
                      {a.kind === "investment" && (
                        <button class="btn ghost small" style={{ height: 24, padding: "0 4px", color: "var(--accent)" }} onClick={() => setSheet({ contribution: a })}>
                          Record contribution
                        </button>
                      )}
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

      <Sheet open={sheet === "entity"} onClose={() => setSheet(null)} title="Add business or personal profile">
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
      {sheet && typeof sheet === "object" && "contribution" in sheet && (
        <Sheet open onClose={() => setSheet(null)} title={`Contribute to ${sheet.contribution.name}`}>
          <InvestmentContribution
            account={sheet.contribution}
            accounts={accts.data?.accounts ?? []}
            onDone={() => {
              setSheet(null);
              reload();
            }}
          />
        </Sheet>
      )}
      {sheet && typeof sheet === "object" && "website" in sheet && (
        <Sheet open onClose={() => setSheet(null)} title={`Investment website · ${sheet.website.name}`}>
          <InvestmentWebsite
            account={sheet.website}
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
      toast(`${name} added as ${TYPE_LABEL[type]}`);
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
        <label>Is this a business or personal profile?</label>
        <select class="input" value={type} onChange={(e) => setType((e.target as HTMLSelectElement).value)}>
          {Object.entries(TYPE_LABEL).map(([k, l]) => (
            <option value={k}>{l}</option>
          ))}
        </select>
        <div class="muted small">Business types also set up matching tax categories. Transactions and accounts can be assigned to this profile.</div>
      </div>
      <button class="btn primary block" disabled={!name.trim()} onClick={save}>
        Add {type === "personal" ? "personal profile" : "business"}
      </button>
    </div>
  );
}

function NewAccount({ onDone }: { onDone: () => void }) {
  const { entities, entity } = useApp();
  const initialEntity = entities.find((e) => e.slug === entity) ?? entities.find((e) => e.type === "personal") ?? entities[0];
  const [name, setName] = useState("");
  const [kind, setKind] = useState("bank");
  const [websiteUrl, setWebsiteUrl] = useState("");
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
      await api("/accounts", { body: { name, kind, entity: ent, ...(kind === "investment" && websiteUrl.trim() ? { websiteUrl: websiteUrl.trim() } : {}) } });
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
        {kind === "bank" && <div class="muted small">Use for a checking or savings account, personal or business.</div>}
        {kind === "investment" && <div class="muted small">Use for brokerage, crypto, private equity, unvested stock, or other investments.</div>}
      </div>
      {kind === "investment" && (
        <div class="field">
          <label>Investment website (optional)</label>
          <input class="input" type="url" value={websiteUrl} onInput={(e) => setWebsiteUrl((e.target as HTMLInputElement).value)} placeholder="https://example.com/account" />
          <div class="muted small">A shortcut to the site where you check this investment.</div>
        </div>
      )}
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
          <div class="muted small">No {ownerType} profile yet. Add one with “+ Add business” before creating this account.</div>
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

function InvestmentContribution({ account, accounts, onDone }: { account: any; accounts: any[]; onDone: () => void }) {
  const sources = accounts.filter((a) => a.kind === "bank" && a.status === "open" && a.slug !== account.slug);
  const [from, setFrom] = useState(sources.find((a) => a.default_entity === account.default_entity)?.slug ?? sources[0]?.slug ?? "");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today());
  const [memo, setMemo] = useState("");
  const save = async () => {
    try {
      await api("/transfers", { body: { from, to: account.slug, amount, date, ...(memo.trim() ? { memo: memo.trim() } : {}) } });
      toast(`Contribution to ${account.name} recorded`);
      onDone();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  if (sources.length === 0) {
    return <div class="stack"><p class="muted">Add a Cash account first. Contributions are recorded as transfers from cash to this investment.</p></div>;
  }
  return (
    <div class="stack">
      <div class="muted small">Record money you put into this investment. This transfers money from a Cash account and updates both balances.</div>
      <div class="field">
        <label>From cash account</label>
        <select class="input" value={from} onChange={(e) => setFrom((e.target as HTMLSelectElement).value)}>
          {sources.map((a) => <option value={a.slug}>{a.name} · {a.balance}</option>)}
        </select>
      </div>
      <div class="field">
        <label>Amount invested</label>
        <input class="input num" inputMode="decimal" value={amount} onInput={(e) => setAmount((e.target as HTMLInputElement).value)} placeholder="100.00" />
      </div>
      <div class="field">
        <label>Date</label>
        <input class="input" type="date" value={date} onInput={(e) => setDate((e.target as HTMLInputElement).value)} />
      </div>
      <div class="field">
        <label>Note (optional)</label>
        <input class="input" value={memo} onInput={(e) => setMemo((e.target as HTMLInputElement).value)} placeholder="Monthly contribution" />
      </div>
      <button class="btn primary block" disabled={!from || !amount.trim()} onClick={save}>Record contribution</button>
    </div>
  );
}

function InvestmentWebsite({ account, onDone }: { account: any; onDone: () => void }) {
  const [websiteUrl, setWebsiteUrl] = useState(account.website_url ?? "");
  const save = async () => {
    try {
      await api(`/accounts/${account.slug}`, { method: "PATCH", body: { websiteUrl: websiteUrl.trim() || null } });
      toast(websiteUrl.trim() ? "Investment website saved" : "Investment website removed");
      onDone();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <div class="stack">
      <div class="field">
        <label>Website URL</label>
        <input class="input" type="url" value={websiteUrl} onInput={(e) => setWebsiteUrl((e.target as HTMLInputElement).value)} placeholder="https://example.com/account" />
      </div>
      <div class="muted small">Save the website where you check this investment. Use a full HTTPS URL.</div>
      <button class="btn primary block" onClick={save}>Save website</button>
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
