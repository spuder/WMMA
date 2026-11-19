import { useState } from "preact/hooks";
import { api, money, today, useApi } from "../api";
import { Avatar, ErrorBox, Icon, Loading, Sheet, toast } from "../components/ui";
import { BUSINESS_PALETTE, businessStyle, useApp } from "../app";

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
const ASSET_KINDS = ["vehicle", "real_estate", "other_asset"];

/** Editable asset details as form strings (numbers are validated by the server). */
type DetailsForm = Partial<Record<"year" | "make" | "model" | "trim" | "vin" | "mileage" | "purchaseDate" | "purchasePrice" | "address" | "description", string>>;
const DETAIL_KEYS: Record<string, Array<keyof DetailsForm>> = {
  vehicle: ["year", "make", "model", "trim", "vin", "mileage", "purchaseDate", "purchasePrice"],
  real_estate: ["address", "purchaseDate", "purchasePrice", "description"],
  other_asset: ["description", "purchaseDate", "purchasePrice"],
};
const toForm = (d: any): DetailsForm => Object.fromEntries(Object.entries(d ?? {}).filter(([k]) => k !== "mileageAsOf").map(([k, v]) => [k, String(v)]));
const fromForm = (kind: string, f: DetailsForm) => {
  const out: Record<string, string> = {};
  for (const k of DETAIL_KEYS[kind] ?? []) if (f[k]?.trim()) out[k] = f[k]!.trim();
  return Object.keys(out).length ? out : null;
};
export const vehicleTitle = (d: any) => [d?.year, d?.make, d?.model].filter(Boolean).join(" ");

/** One-line summary under an asset's name, e.g. "2021 Toyota RAV4 XLE · 42,180 mi". */
function assetSummary(a: any): string | null {
  const d = a.details;
  if (!d) return null;
  if (a.kind === "vehicle") {
    const title = [vehicleTitle(d), d.trim].filter(Boolean).join(" ");
    const parts = [title !== a.name ? title : "", d.mileage !== undefined ? `${Number(d.mileage).toLocaleString()} mi` : ""].filter(Boolean);
    return parts.join(" · ") || null;
  }
  return d.address ?? d.description ?? null;
}

function AssetFields({ kind, form, onChange }: { kind: string; form: DetailsForm; onChange: (f: DetailsForm) => void }) {
  const [decoding, setDecoding] = useState(false);
  const set = (k: keyof DetailsForm) => (e: Event) => onChange({ ...form, [k]: (e.target as HTMLInputElement).value });
  const decode = async () => {
    setDecoding(true);
    try {
      const v = await api<{ year: number | null; make: string | null; model: string | null; trim: string | null }>(`/vin/${encodeURIComponent((form.vin ?? "").trim())}`);
      onChange({
        ...form,
        ...(v.year ? { year: String(v.year) } : {}),
        ...(v.make ? { make: v.make } : {}),
        ...(v.model ? { model: v.model } : {}),
        ...(v.trim ? { trim: v.trim } : {}),
      });
      toast(`Found ${[v.year, v.make, v.model].filter(Boolean).join(" ")}`);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setDecoding(false);
    }
  };
  return (
    <div class="stack" style={{ gap: 12 }}>
      {kind === "vehicle" && (
        <>
          <div class="field">
            <label>VIN (optional)</label>
            <div class="row">
              <input class="input" style={{ textTransform: "uppercase", fontFamily: "var(--font-mono, monospace)" }} maxLength={17} value={form.vin ?? ""} onInput={set("vin")} placeholder="17 characters" autoComplete="off" />
              <button class="btn" disabled={decoding || (form.vin ?? "").trim().length !== 17} onClick={decode}>
                {decoding ? "Looking up…" : "Look up"}
              </button>
            </div>
            <div class="muted small">Fills in year, make and model from the free NHTSA decoder. Only the VIN is sent.</div>
          </div>
          <div class="asset-grid">
            <div class="field">
              <label>Year</label>
              <input class="input num" inputMode="numeric" maxLength={4} value={form.year ?? ""} onInput={set("year")} placeholder="2021" />
            </div>
            <div class="field">
              <label>Make</label>
              <input class="input" value={form.make ?? ""} onInput={set("make")} placeholder="Toyota" />
            </div>
            <div class="field">
              <label>Model</label>
              <input class="input" value={form.model ?? ""} onInput={set("model")} placeholder="RAV4" />
            </div>
            <div class="field">
              <label>Trim</label>
              <input class="input" value={form.trim ?? ""} onInput={set("trim")} placeholder="XLE" />
            </div>
          </div>
          <div class="field">
            <label>Odometer (miles)</label>
            <input class="input num" inputMode="numeric" value={form.mileage ?? ""} onInput={set("mileage")} placeholder="42,180" />
          </div>
        </>
      )}
      {kind === "real_estate" && (
        <div class="field">
          <label>Address</label>
          <input class="input" value={form.address ?? ""} onInput={set("address")} placeholder="123 Main St, Springfield" autoComplete="street-address" />
        </div>
      )}
      {kind !== "vehicle" && (
        <div class="field">
          <label>Description</label>
          <input class="input" value={form.description ?? ""} onInput={set("description")} placeholder={kind === "real_estate" ? "Primary home" : "Boat, jewelry, collectibles…"} />
        </div>
      )}
      <div class="asset-grid">
        <div class="field">
          <label>Purchase price</label>
          <input class="input num" inputMode="decimal" value={form.purchasePrice ?? ""} onInput={set("purchasePrice")} placeholder="0.00" />
        </div>
        <div class="field">
          <label>Purchase date</label>
          <input class="input" type="date" value={form.purchaseDate ?? ""} onInput={set("purchaseDate")} />
        </div>
      </div>
    </div>
  );
}

function LoanSelect({ accounts, value, assetSlug, onChange }: { accounts: any[]; value: string; assetSlug?: string; onChange: (slug: string) => void }) {
  const loans = accounts.filter((a) => a.kind === "loan" && a.status === "open");
  return (
    <div class="field">
      <label>Loan against it (optional)</label>
      <select class="input" value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
        <option value="">No loan</option>
        {loans.map((l) => {
          const taken = accounts.some((a) => a.linked_loan === l.slug && a.slug !== assetSlug);
          return (
            <option value={l.slug} disabled={taken}>
              {l.name} · {l.balance}
              {taken ? " (linked elsewhere)" : ""}
            </option>
          );
        })}
      </select>
      <div class="muted small">{loans.length ? "Shows your equity: value minus what you still owe." : "Add a loan account first to track equity."}</div>
    </div>
  );
}
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
  const [sheet, setSheet] = useState<null | "entity" | "account" | { valuation: any } | { contribution: any } | { website: any } | { archive: any } | { color: any } | { asset: any }>(null);
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
                <span class="business-icon" style={businessStyle(e.slug, e.color)}>{e.type === "personal" ? "👤" : <Icon.folder />}</span>
                <div class="body">
                  <div class="title">
                    {e.name} {e.status === "archived" && <span class="pill zero">archived</span>}
                  </div>
                  <div class="meta">{TYPE_LABEL[e.type] ?? e.type}</div>
                </div>
                {e.status === "active" && (
                  <div class="row" style={{ gap: 4 }}>
                    <button class="btn ghost small" onClick={() => setSheet({ color: e })}>Color</button>
                    <button class="btn ghost small danger" onClick={() => setSheet({ archive: e })}>Archive</button>
                  </div>
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
                    <Avatar name={a.name} logo={a.logo ?? null} />
                    <div class="body">
                      <div class="title">
                        {a.name} {a.status === "closed" && <span class="pill zero">closed</span>}
                      </div>
                      {ASSET_KINDS.includes(a.kind) && assetSummary(a) && <div class="small" style={{ marginTop: 1 }}>{assetSummary(a)}</div>}
                      <div class="meta">
                        {entities.find((e) => e.slug === a.default_entity)?.name ?? a.default_entity} · {a.hledger_account}
                      </div>
                      {a.linked_loan && (() => {
                        const loan = (accts.data?.accounts ?? []).find((l: any) => l.slug === a.linked_loan);
                        if (!loan) return null;
                        const equity = a.balance_cents + loan.balance_cents;
                        return (
                          <div class="small muted">
                            Equity <strong class={`num ${equity < 0 ? "out" : ""}`}>{money(equity)}</strong> · owe {money(-loan.balance_cents)} on {loan.name}
                          </div>
                        );
                      })()}
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
                      {ASSET_KINDS.includes(a.kind) && (
                        <button class="btn ghost small" style={{ height: 24, padding: "0 4px" }} onClick={() => setSheet({ asset: a })}>
                          Details
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
          accounts={accts.data?.accounts ?? []}
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
      {sheet && typeof sheet === "object" && "asset" in sheet && (
        <Sheet open side onClose={() => setSheet(null)} title={sheet.asset.name}>
          <AssetDetailsSheet
            account={sheet.asset}
            accounts={accts.data?.accounts ?? []}
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
      {sheet && typeof sheet === "object" && "color" in sheet && (
        <Sheet open onClose={() => setSheet(null)} title={`Folder color · ${sheet.color.name}`}>
          <ColorPicker
            value={sheet.color.color ?? businessStyle(sheet.color.slug).color}
            onChoose={async (color) => {
              try {
                await api(`/entities/${sheet.color.slug}`, { method: "PATCH", body: { color } });
                toast(`Updated ${sheet.color.name} folder color`);
                setSheet(null);
                reload();
              } catch (e) { toast((e as Error).message); }
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
  const [color, setColor] = useState(BUSINESS_PALETTE[0]!);
  const save = async () => {
    try {
      await api("/entities", { body: { name, type, color } });
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
      <div class="field">
        <label>Folder color</label>
        <ColorPicker value={color} onChoose={setColor} />
      </div>
      <button class="btn primary block" disabled={!name.trim()} onClick={save}>
        Add {type === "personal" ? "personal profile" : "business"}
      </button>
    </div>
  );
}

function ColorPicker({ value, onChoose }: { value: string; onChoose: (color: string) => void }) {
  const labels = ["Blue", "Pink", "Purple", "Orange", "Green", "Red", "Gold"];
  return (
    <div class="color-options" role="group" aria-label="Folder color">
      {BUSINESS_PALETTE.map((color, i) => (
        <button class={`color-swatch${value.toLowerCase() === color ? " selected" : ""}`} style={{ background: color }} aria-label={labels[i]} title={labels[i]} onClick={() => onChoose(color)}>
          {value.toLowerCase() === color && <Icon.check />}
        </button>
      ))}
    </div>
  );
}

function NewAccount({ accounts, onDone }: { accounts: any[]; onDone: () => void }) {
  const { entities, entity } = useApp();
  const initialEntity = entities.find((e) => e.slug === entity) ?? entities.find((e) => e.type === "personal") ?? entities[0];
  const [name, setName] = useState("");
  const [kind, setKind] = useState("bank");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [details, setDetails] = useState<DetailsForm>({});
  const [value, setValue] = useState("");
  const [loan, setLoan] = useState("");
  const isAsset = ASSET_KINDS.includes(kind);
  const autoName = kind === "vehicle" ? vehicleTitle(details) : "";
  const finalName = name.trim() || autoName;
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
      const assetDetails = isAsset ? fromForm(kind, details) : null;
      await api("/accounts", {
        body: {
          name: finalName,
          kind,
          entity: ent,
          ...(kind === "investment" && websiteUrl.trim() ? { websiteUrl: websiteUrl.trim() } : {}),
          ...(assetDetails ? { details: assetDetails } : {}),
          ...(isAsset && loan ? { linkedLoan: loan } : {}),
          ...((isAsset || kind === "investment") && value.trim() ? { value: { value: value.replace(/[$,]/g, "").trim(), date: today() } } : {}),
        },
      });
      toast(`${finalName} added`);
      onDone();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <div class="stack">
      <div class="field">
        <label>Name</label>
        <input class="input" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder={autoName || (kind === "vehicle" ? "Family car" : kind === "real_estate" ? "Home" : "Chase Checking")} />
        {autoName && !name.trim() && <div class="muted small">Will be named “{autoName}”.</div>}
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
        {kind === "vehicle" && <div class="muted small">Cars, trucks, motorcycles, RVs and boats. Track what it's worth and what you owe on it.</div>}
      </div>
      {isAsset && <AssetFields kind={kind} form={details} onChange={setDetails} />}
      {(isAsset || kind === "investment") && (
        <div class="field">
          <label>Current value</label>
          <input class="input num" inputMode="decimal" value={value} onInput={(e) => setValue((e.target as HTMLInputElement).value)} placeholder="0.00" />
          <div class="muted small">{kind === "vehicle" ? "What it would sell for today. Check KBB or Edmunds, then update it now and then." : "You can update this any time."}</div>
        </div>
      )}
      {isAsset && <LoanSelect accounts={accounts} value={loan} onChange={setLoan} />}
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
      <button class="btn primary block" disabled={!finalName || !ent || matchingEntities.length === 0} onClick={save}>
        Add account
      </button>
    </div>
  );
}

function Valuation({ account, onDone }: { account: any; onDone: () => void }) {
  const [value, setValue] = useState((account.balance_cents / 100).toFixed(2));
  const [date, setDate] = useState(today());
  const [mileage, setMileage] = useState("");
  const save = async () => {
    try {
      const r = await api<{ change: string }>("/valuations", { body: { account: account.slug, date, value, ...(mileage.trim() ? { mileage: mileage.replace(/,/g, "").trim() } : {}) } });
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
      {account.kind === "vehicle" && (
        <div class="field">
          <label>Odometer (optional)</label>
          <input class="input num" inputMode="numeric" value={mileage} onInput={(e) => setMileage((e.target as HTMLInputElement).value)} placeholder={account.details?.mileage !== undefined ? `Last: ${Number(account.details.mileage).toLocaleString()} mi` : "Miles"} />
        </div>
      )}
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

function AssetDetailsSheet({ account, accounts, onDone }: { account: any; accounts: any[]; onDone: () => void }) {
  const [form, setForm] = useState<DetailsForm>(toForm(account.details));
  const [loan, setLoan] = useState<string>(account.linked_loan ?? "");
  const [busy, setBusy] = useState(false);
  const history = useApi<{ valuations: Array<{ date: string; value: string; value_cents: number }> }>(`/accounts/${account.slug}/valuations`);
  const loanRow = accounts.find((a) => a.slug === (loan || null));
  const purchase = Number(String(form.purchasePrice ?? "").replace(/[$,]/g, ""));
  const save = async () => {
    setBusy(true);
    try {
      await api(`/accounts/${account.slug}`, { method: "PATCH", body: { details: fromForm(account.kind, form), linkedLoan: loan || null } });
      toast("Details saved");
      onDone();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const vals = [...(history.data?.valuations ?? [])].reverse();
  return (
    <div class="stack">
      <div class="asset-stats">
        <div>
          <div class="upper">Value</div>
          <div class="num asset-stat">{account.balance}</div>
        </div>
        {loanRow && (
          <div>
            <div class="upper">Equity</div>
            <div class={`num asset-stat ${account.balance_cents + loanRow.balance_cents < 0 ? "out" : ""}`}>{money(account.balance_cents + loanRow.balance_cents)}</div>
          </div>
        )}
        {purchase > 0 && (
          <div>
            <div class="upper">Since purchase</div>
            <div class={`num asset-stat ${account.balance_cents < purchase * 100 ? "out" : "in"}`}>{money(account.balance_cents - Math.round(purchase * 100))}</div>
          </div>
        )}
      </div>
      {account.details?.mileageAsOf && (
        <div class="muted small">
          Odometer {Number(account.details.mileage).toLocaleString()} mi as of {account.details.mileageAsOf}
        </div>
      )}
      <AssetFields kind={account.kind} form={form} onChange={setForm} />
      <LoanSelect accounts={accounts} value={loan} assetSlug={account.slug} onChange={setLoan} />
      <button class="btn primary block" disabled={busy} onClick={save}>
        {busy ? "Saving…" : "Save details"}
      </button>
      <div class="card flat stack" style={{ gap: 4 }}>
        <div class="upper">Value history</div>
        {history.loading && <Loading h={60} />}
        {!history.loading && vals.length === 0 && <div class="muted small">No values recorded yet. Use “Update value” to add one.</div>}
        {vals.map((v, i) => {
          const prev = vals[i + 1];
          const change = prev ? v.value_cents - prev.value_cents : null;
          return (
            <div class="spread small" style={{ padding: "5px 0" }}>
              <span class="muted">{v.date}</span>
              <span>
                {change !== null && change !== 0 && <span class={`num ${change < 0 ? "out" : "in"}`} style={{ marginRight: 10 }}>{change > 0 ? "+" : ""}{money(change)}</span>}
                <strong class="num">{v.value}</strong>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
