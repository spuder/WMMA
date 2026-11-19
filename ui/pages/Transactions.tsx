import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, catLabel, dayLabel, leaf, money, useApi } from "../api";
import { Avatar, CategoryPicker, CatName, CellMenu, ErrorBox, Icon, Loading, MenuOption, Sheet, toast } from "../components/ui";
import { businessStyle, EntitySwitcher, go, transactionEntity, useApp, type Entity } from "../app";
import { loadLogos, retryLogo, usePayeeLogo } from "../logos";

export interface Txn {
  wmma_id: string;
  date: string;
  payee: string;
  note: string | null;
  tags: Record<string, string>;
  postings: Array<{ account: string; amount: string; amount_cents: number; entity: string | null }>;
}

const isCat = (a: string) => /^(Income|Expenses):/.test(a);
const isMoney = (a: string) => /^(Assets|Liabilities):/.test(a);

/** The amount as seen from the user's bank/card side, and the category shown. */
export function summarize(t: Txn): { amount: number; category: string; categoryAccount: string | null; uncategorized: boolean } {
  const bank = t.postings.find((p) => isMoney(p.account) && !p.account.includes(":Due"));
  const cats = t.postings.filter((p) => isCat(p.account));
  const amount = bank ? bank.amount_cents : -cats.reduce((a, p) => a + p.amount_cents, 0);
  const uncategorized = cats.some((p) => p.account.endsWith(":Uncategorized"));
  const category =
    t.tags["kind"] === "transfer"
      ? "Transfer"
      : t.tags["kind"] === "valuation"
        ? "Valuation"
        : cats.length > 1
          ? `Split · ${cats.length}`
          : cats[0]
            ? catLabel(cats[0].account)
            : t.postings.filter((p) => isMoney(p.account)).length > 1
              ? "Transfer"
              : leaf(t.postings.find((p) => p !== bank)?.account ?? "");
  const categoryAccount = t.tags["kind"] === "transfer" || t.tags["kind"] === "valuation" || cats.length !== 1 ? null : cats[0]!.account;
  return { amount, category, categoryAccount, uncategorized };
}

export function TxnRow({ t, entities, onClick }: { t: Txn; entities: Array<{ slug: string; name: string; type: string; color?: string | null }>; onClick?: () => void }) {
  const s = summarize(t);
  const entity = transactionEntity(t);
  const owner = entities.find((e) => e.slug === entity);
  return (
    <div class="item tap" onClick={onClick} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onClick?.()}>
      <Avatar name={t.payee} />
      <div class="body">
        <div class="title">{t.payee}</div>
        <div class="meta">
          {s.uncategorized ? <span style={{ color: "var(--warn)", fontWeight: 650 }}>Needs category</span> : s.categoryAccount ? <CatName account={s.categoryAccount} label={s.category} /> : s.category}
          {t.note ? ` · ${t.note}` : ""}
        </div>
        <div><span class="business-tag" style={entity ? businessStyle(entity, owner?.color) : { color: "var(--muted)", background: "var(--surface-2)", borderColor: "var(--line)" }}>
          {entity ? owner?.type === "personal" ? "👤" : <Icon.folder /> : "＋"} {entity ? owner?.name ?? entity : "Assign business"}
        </span></div>
      </div>
      <div class={`amount num ${s.amount > 0 ? "in" : ""}`} style={{ fontWeight: 650 }}>
        {s.amount > 0 ? "+" : ""}
        {money(s.amount)}
      </div>
    </div>
  );
}

interface AccountInfo {
  slug: string;
  name: string;
  hledger_account: string;
  kind: string;
  balance: string;
  default_entity: string;
}

/** Columns need about this much room; below it (phones, narrow windows) rows become cards. */
const TABLE_MIN_WIDTH = 720;

/** Width of an element, tracked as it resizes (sidebar, window, rotation). */
function useWidth(ref: { current: HTMLElement | null }): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return width;
}

/** Accounts with balances, for naming each transaction's account. */
export function useAccountsInfo(): AccountInfo[] {
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  useEffect(() => {
    api<{ accounts: AccountInfo[] }>("/accounts")
      .then((r) => setAccounts(r.accounts))
      .catch(() => {});
  }, []);
  return accounts;
}

/**
 * Transactions grouped by day: a Monarch-style table (merchant, category,
 * account, business, amount, details chevron) with in-place editing when there
 * is room, otherwise tappable cards.
 */
export function TxnList({
  rows,
  accounts,
  accountFilter = null,
  onOpen,
  onChanged,
  onFilterAccount,
  empty = "No transactions",
}: {
  rows: Txn[];
  accounts: AccountInfo[];
  accountFilter?: string | null;
  onOpen: (t: Txn) => void;
  onChanged: (t: Txn) => void;
  onFilterAccount: (account: string | null) => void;
  empty?: string;
}) {
  const { entities, categories } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const groups = useMemo(() => {
    const g: Array<[string, Txn[]]> = [];
    for (const t of rows) {
      const last = g[g.length - 1];
      if (last && last[0] === t.date) last[1].push(t);
      else g.push([t.date, [t]]);
    }
    return g;
  }, [rows]);
  const table = width >= TABLE_MIN_WIDTH;
  return (
    <div ref={ref}>
      {groups.length === 0 && <div class="empty">{empty}</div>}
      {table && groups.length > 0 && (
        <div class="txn-table">
          <div class="txn-head">
            <span>Merchant</span>
            <span>Category</span>
            <span>Account</span>
            <span>Business</span>
            <span class="r">Amount</span>
            <span />
          </div>
          {groups.map(([d, list]) => (
            <div>
              <div class="txn-day upper">
                <span>{dayLabel(d)}</span>
                <span class="num">{money(list.reduce((sum, t) => sum + summarize(t).amount, 0))}</span>
              </div>
              {list.map((t) => (
                <TxnLine
                  key={t.wmma_id}
                  t={t}
                  entities={entities}
                  accounts={accounts}
                  categories={categories}
                  accountFilter={accountFilter}
                  onOpen={() => onOpen(t)}
                  onChanged={onChanged}
                  onFilterAccount={onFilterAccount}
                />
              ))}
            </div>
          ))}
        </div>
      )}
      {!table &&
        groups.map(([d, list]) => (
          <div>
            <div class="dategroup upper">{dayLabel(d)}</div>
            <div class="list">
              {list.map((t) => (
                <TxnRow t={t} entities={entities} onClick={() => onOpen(t)} />
              ))}
            </div>
          </div>
        ))}
    </div>
  );
}

const bankPosting = (t: Txn) => t.postings.find((p) => isMoney(p.account) && !p.account.includes(":Due"));
const KIND_LABEL: Record<string, string> = { bank: "Bank account", credit: "Credit card", investment: "Investment", loan: "Loan", property: "Property", cash: "Cash" };

/** One table row on wide screens: category, account and business change in place. */
function TxnLine({
  t,
  entities,
  accounts,
  categories,
  accountFilter,
  onOpen,
  onChanged,
  onFilterAccount,
}: {
  t: Txn;
  entities: Entity[];
  accounts: AccountInfo[];
  categories: string[];
  accountFilter: string | null;
  onOpen: () => void;
  onChanged: (t: Txn) => void;
  onFilterAccount: (account: string | null) => void;
}) {
  const { refreshReview } = useApp();
  const [flash, setFlash] = useState<"category" | "business" | null>(null);
  const s = summarize(t);
  const cats = t.postings.filter((p) => isCat(p.account));
  const bank = bankPosting(t);
  const account = accounts.find((a) => a.hledger_account === bank?.account);
  const entity = transactionEntity(t);
  const owner = entities.find((e) => e.slug === entity);

  const patch = async (body: Record<string, unknown>, field: "category" | "business", msg: string) => {
    try {
      const next = await api<Txn>(`/transactions/${t.wmma_id}`, { method: "PATCH", body });
      onChanged(next);
      if (field === "category") refreshReview();
      setFlash(field);
      setTimeout(() => setFlash(null), 900);
      toast(msg);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const businessValue = (
    <>
      <span class="business-icon compact" style={entity ? businessStyle(entity, owner?.color) : {}}>
        {owner?.type === "personal" ? "👤" : <Icon.folder />}
      </span>
      <span class={entity ? "" : "muted-text"}>{owner?.name ?? entity ?? "Assign"}</span>
    </>
  );

  return (
    <div class="txn-line" onClick={onOpen}>
      <div class="txn-payee" title={t.note ?? t.payee}>
        <Avatar name={t.payee} />
        <span>{t.payee}</span>
      </div>

      {cats.length === 1 && s.categoryAccount !== null ? (
        <CellMenu
          label={`Category for ${t.payee}`}
          flash={flash === "category"}
          value={s.uncategorized ? <span style={{ color: "var(--warn)", fontWeight: 650 }}>❓ Needs category</span> : <CatName account={cats[0]!.account} />}
        >
          {(close) => (
            <CategoryPicker
              categories={categories}
              direction={s.amount < 0 ? "out" : "in"}
              onPick={(a) => {
                close();
                if (a !== cats[0]!.account) patch({ category: { to: a, from: cats[0]!.account } }, "category", `Moved to ${leaf(a)}`);
              }}
            />
          )}
        </CellMenu>
      ) : (
        <span class="txn-static">{s.category}</span>
      )}

      {bank ? (
        <CellMenu label={`Account for ${t.payee}`} width={290} value={<><span class="cat-emoji" aria-hidden="true">🏦</span><span>{account?.name ?? leaf(bank.account)}</span></>}>
          {(close) => (
            <>
              <div class="menu-head">
                <strong>{account?.name ?? leaf(bank.account)}</strong>
                <span class="muted small">
                  {account ? `${KIND_LABEL[account.kind] ?? account.kind} · ${account.balance}` : bank.account}
                </span>
              </div>
              {accountFilter === bank.account ? (
                <MenuOption onClick={() => (close(), onFilterAccount(null))}>
                  <Icon.x /> Show all accounts
                </MenuOption>
              ) : (
                <MenuOption onClick={() => (close(), onFilterAccount(bank.account))}>
                  <Icon.list /> Only show this account
                </MenuOption>
              )}
              <MenuOption index={1} onClick={() => (close(), go("/accounts"))}>
                <Icon.bank /> Open accounts
              </MenuOption>
              <div class="menu-note">Imported transactions stay with the bank account they came from.</div>
            </>
          )}
        </CellMenu>
      ) : (
        <span class="txn-static">—</span>
      )}

      <CellMenu label={`Business for ${t.payee}`} width={280} flash={flash === "business"} value={businessValue}>
        {(close) => (
          <>
            <div class="menu-head muted small">Business or personal</div>
            {entities
              .filter((e) => e.status === "active" || e.slug === entity)
              .map((e, i) => (
                <MenuOption
                  index={i}
                  selected={e.slug === entity}
                  onClick={() => {
                    close();
                    if (e.slug !== entity) patch({ entity: e.slug }, "business", `Assigned to ${e.name}`);
                  }}
                >
                  <span class="business-icon compact" style={businessStyle(e.slug, e.color)}>
                    {e.type === "personal" ? "👤" : <Icon.folder />}
                  </span>
                  {e.name}
                </MenuOption>
              ))}
          </>
        )}
      </CellMenu>

      <div class={`txn-amt num ${s.amount > 0 ? "in" : ""}`}>
        {s.amount > 0 ? "+" : ""}
        {money(s.amount)}
      </div>
      <button
        class="txn-open"
        aria-label={`Open details for ${t.payee}`}
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
      >
        <Icon.chevron />
      </button>
    </div>
  );
}

/** Transactions per /categorize request when sending many to Jev (keeps each request short). */
const JEV_BATCH = 3;

export function Transactions({ query }: { query: URLSearchParams }) {
  const { entity } = useApp();
  const accountFilter = query.get("account");
  const accounts = useAccountsInfo();
  const [text, setText] = useState(query.get("q") ?? "");
  const [debounced, setDebounced] = useState(text);
  const [rows, setRows] = useState<Txn[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "uncat" | "in" | "out">("all");
  const openId = query.get("id");
  const { refreshReview } = useApp();
  const settings = useApi<{ jev: { configured: boolean } }>("/settings");
  /** A Jev run over many transactions: "uncat" sends uncategorized ones, "rerun" re-asks about Jev's own picks. */
  const [jevRun, setJevRun] = useState<{ kind: "uncat" | "rerun"; done: number; total: number; stop: boolean } | null>(null);
  /** "Re-run Jev" asks first, showing how many transactions it would touch. */
  const [rerunIds, setRerunIds] = useState<string[] | null>(null);
  const jevStop = useRef(false);
  const entityQs = entity ? `?entity=${encodeURIComponent(entity)}` : "";
  const runJev = async (kind: "uncat" | "rerun", ids: string[]) => {
    jevStop.current = false;
    setRerunIds(null);
    const counts = { categorized: 0, suggested: 0, changed: 0, confirmed: 0, kept: 0 };
    let error: string | null = null;
    setJevRun({ kind, done: 0, total: ids.length, stop: false });
    try {
      for (let i = 0; i < ids.length && !jevStop.current; i += JEV_BATCH) {
        const batch = ids.slice(i, i + JEV_BATCH);
        let errors: string[];
        let moved = false;
        if (kind === "uncat") {
          const r = await api<{ errors: string[]; outcomes?: Record<string, { category?: string; choices?: unknown[] }> }>("/categorize", { body: { wmmaIds: batch } });
          for (const o of Object.values(r.outcomes ?? {})) o.category ? counts.categorized++ : o.choices?.length ? counts.suggested++ : null;
          moved = Object.values(r.outcomes ?? {}).some((o) => o.category);
          errors = r.errors;
        } else {
          const r = await api<{ errors: string[]; changed: number; confirmed: number; kept: number }>("/categorize/rerun", { body: { wmmaIds: batch } });
          counts.changed += r.changed;
          counts.confirmed += r.confirmed;
          counts.kept += r.kept;
          moved = r.changed > 0;
          errors = r.errors;
        }
        setJevRun((a) => ({ kind, done: Math.min(i + JEV_BATCH, ids.length), total: ids.length, stop: a?.stop ?? false }));
        if (moved) load(0);
        if (errors.length) {
          error = errors[0]!;
          break;
        }
      }
    } catch (e) {
      error = (e as Error).message;
    }
    const parts =
      kind === "uncat"
        ? [counts.categorized ? `${counts.categorized} categorized` : null, counts.suggested ? `${counts.suggested} have suggestions in Review` : null]
        : [counts.changed ? `${counts.changed} moved to a better category` : null, counts.confirmed ? `${counts.confirmed} confirmed` : null, counts.kept ? `${counts.kept} kept (Jev unsure)` : null];
    const summary = parts.filter(Boolean).join(" · ");
    toast(error ? `${error}${summary ? ` · ${summary} before that` : ""}` : summary || "Jev had nothing new to add");
    setJevRun(null);
    load(0);
    refreshReview();
  };
  const sendAllToJev = async () => {
    try {
      const { ids } = await api<{ ids: string[] }>(`/categorize/uncategorized${entityQs}`);
      await runJev("uncat", ids);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const askRerun = async () => {
    try {
      const { ids } = await api<{ ids: string[] }>(`/categorize/jev${entityQs}`);
      if (ids.length === 0) toast("Jev hasn't categorized any transactions yet");
      else setRerunIds(ids);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  useEffect(() => {
    const t = setTimeout(() => setDebounced(text), 250);
    return () => clearTimeout(t);
  }, [text]);

  const load = (offset = 0) => {
    const q = new URLSearchParams({ limit: "100", offset: String(offset) });
    if (debounced) q.set("text", debounced);
    if (entity) q.set("entity", entity);
    if (accountFilter) q.set("account", accountFilter);
    api<{ total: number; transactions: Txn[] }>(`/transactions?${q}`)
      .then((r) => {
        setTotal(r.total);
        setRows((prev) => (offset === 0 ? r.transactions : [...(prev ?? []), ...r.transactions]));
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  };
  useEffect(() => load(0), [debounced, entity, accountFilter]);

  /** Build a route that keeps the search and account filter. */
  const route = (extra: Record<string, string | null> = {}) => {
    const q = new URLSearchParams();
    if (text) q.set("q", text);
    if (accountFilter) q.set("account", accountFilter);
    for (const [k, v] of Object.entries(extra)) v === null ? q.delete(k) : q.set(k, v);
    const qs = q.toString();
    return `/transactions${qs ? `?${qs}` : ""}`;
  };
  const replaceRow = (t: Txn) => setRows((rs) => (rs ?? []).map((r) => (r.wmma_id === t.wmma_id ? t : r)));
  const filteredAccount = accountFilter ? accounts.find((a) => a.hledger_account === accountFilter) : null;

  const shown = useMemo(
    () =>
      (rows ?? []).filter((t) => {
        if (filter === "all") return true;
        const s = summarize(t);
        return filter === "uncat" ? s.uncategorized : filter === "in" ? s.amount > 0 : s.amount < 0;
      }),
    [rows, filter],
  );

  return (
    <div class="stack">
      <div class="topbar">
        <h1>Activity</h1>
        <EntitySwitcher />
      </div>
      <div class="search">
        <Icon.search />
        <input class="input" type="search" placeholder="Search payee, memo, category" value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} />
      </div>
      <div class="chips">
        {(
          [
            ["all", "All"],
            ["uncat", "Needs category"],
            ["out", "Money out"],
            ["in", "Money in"],
          ] as const
        ).map(([k, l]) => (
          <button class={`chip${filter === k ? " active" : ""}`} onClick={() => setFilter(k)}>
            {l}
          </button>
        ))}
        {settings.data?.jev.configured && (
          <button class="chip" disabled={!!jevRun} onClick={askRerun} title="Ask Jev again about transactions it categorized">
            ↻ Re-run Jev
          </button>
        )}
        {accountFilter && (
          <button class="chip active txn-filter" onClick={() => go(route({ account: null }))} aria-label="Clear account filter">
            🏦 {filteredAccount?.name ?? leaf(accountFilter)} <Icon.x />
          </button>
        )}
      </div>
      {error && <ErrorBox error={error} />}
      {jevRun ? (
        <div class="card flat row" style={{ gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <strong>{jevRun.kind === "rerun" ? "Re-running Jev" : "Asking Jev"}</strong>
            <div class="muted small">
              {jevRun.done} of {jevRun.total} sent
            </div>
          </div>
          <button class="btn ghost" disabled={jevRun.stop} onClick={() => ((jevStop.current = true), setJevRun((a) => a && { ...a, stop: true }))}>
            {jevRun.stop ? "Stopping…" : "Stop"}
          </button>
        </div>
      ) : rerunIds ? (
        <div class="card flat row" style={{ gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <strong>Re-run Jev on {rerunIds.length} transaction{rerunIds.length === 1 ? "" : "s"}?</strong>
            <div class="muted small">
              Only ones Jev categorized{entity ? " in this profile" : ""}. Anything you, a rule or an import categorized is left alone. Confident answers replace the
              category; unsure ones keep it.
            </div>
          </div>
          <div class="row" style={{ gap: 8 }}>
            <button class="btn ghost" onClick={() => setRerunIds(null)}>
              Cancel
            </button>
            <button class="btn primary" onClick={() => runJev("rerun", rerunIds)}>
              Re-run
            </button>
          </div>
        </div>
      ) : (
        filter === "uncat" &&
        settings.data?.jev.configured &&
        shown.length > 0 && (
          <div class="card flat row" style={{ gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <strong>Send to Jev</strong>
              <div class="muted small">Re-asks Jev about every transaction that still needs a category, including ones it wasn't sure about before.</div>
            </div>
            <button class="btn" onClick={sendAllToJev}>
              Send all to Jev
            </button>
          </div>
        )
      )}
      {!rows && !error && <Loading h={360} />}
      {rows && (
        <div class="card flush">
          <TxnList
            rows={shown}
            accounts={accounts}
            accountFilter={accountFilter}
            onOpen={(t) => go(route({ id: t.wmma_id }))}
            onChanged={replaceRow}
            onFilterAccount={(a) => go(route({ account: a }))}
          />
          {rows.length < total && (
            <button class="btn block" style={{ marginTop: 10 }} onClick={() => load(rows.length)}>
              Load more ({total - rows.length})
            </button>
          )}
        </div>
      )}
      {openId && (
        <TxnSheet
          id={openId}
          account={accounts.find((a) => a.hledger_account === bankPosting(rows?.find((r) => r.wmma_id === openId) ?? ({ postings: [] } as unknown as Txn))?.account) ?? null}
          onClose={() => go(route({ id: null }))}
          onChanged={replaceRow}
        />
      )}
    </div>
  );
}

function TxnSheet({ id, account, onClose, onChanged }: { id: string; account: AccountInfo | null; onClose: () => void; onChanged: (t: Txn) => void }) {
  const { entities, categories, refreshReview } = useApp();
  const [t, setT] = useState<Txn | null>(null);
  const [mode, setMode] = useState<"view" | "split">("view");
  const [expanded, setExpanded] = useState<"category" | "business" | null>(null);
  const [memo, setMemo] = useState("");
  const [logoOpen, setLogoOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settings = useApi<{ jev: { configured: boolean } }>("/settings");
  const [jevChoices, setJevChoices] = useState<Array<{ account: string; probability: number }>>([]);
  const [asking, setAsking] = useState(false);
  useEffect(() => setJevChoices([]), [id]);
  const rerunOne = async () => {
    setAsking(true);
    try {
      const r = await api<{ errors: string[]; outcomes: Record<string, { from: string; to?: string; confidence?: number }> }>("/categorize/rerun", { body: { wmmaIds: [id] } });
      const o = r.outcomes[id];
      if (r.errors.length) toast(r.errors[0]!);
      else if (o?.to && o.to !== o.from) {
        const next = await api<Txn>(`/transactions/${encodeURIComponent(id)}`);
        setT(next);
        onChanged(next);
        toast(`Jev moved it to ${leaf(o.to)}`);
      } else if (o?.to) toast(`Jev still says ${leaf(o.to)}`);
      else toast(`Jev isn't sure: kept ${o ? leaf(o.from) : "the category"}`);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setAsking(false);
    }
  };
  const askJev = async () => {
    setAsking(true);
    try {
      const r = await api<{ errors: string[]; outcomes?: Record<string, { category?: string; choices?: Array<{ account: string; probability: number }>; reason?: string }> }>(
        "/categorize",
        { body: { wmmaIds: [id] } },
      );
      const o = r.outcomes?.[id];
      if (o?.category) {
        const next = await api<Txn>(`/transactions/${encodeURIComponent(id)}`);
        setT(next);
        onChanged(next);
        toast(`Jev picked ${leaf(o.category)}`);
      } else if (o?.choices?.length) {
        setJevChoices(o.choices);
        setExpanded("category");
        toast("Jev isn't sure: its best guesses are at the top");
      } else {
        toast(r.errors[0] ?? o?.reason ?? "Jev had no suggestion");
      }
      refreshReview();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setAsking(false);
    }
  };
  // Opening a transaction whose site had no logo is the one time we look again.
  const logo = usePayeeLogo(t?.payee ?? null);
  const missingDomain = logo && "domain" in logo && logo.missing ? logo.domain : null;
  useEffect(() => {
    if (missingDomain) retryLogo(missingDomain).catch(() => {});
  }, [id, missingDomain]);
  useEffect(() => {
    setLogoOpen(false);
    api<Txn>(`/transactions/${encodeURIComponent(id)}`)
      .then((found) => {
        setT(found);
        setMemo(found.note ?? "");
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);

  const patch = async (body: Record<string, unknown>, msg: string) => {
    try {
      const next = await api<Txn>(`/transactions/${id}`, { method: "PATCH", body });
      setT(next);
      onChanged(next);
      refreshReview();
      toast(msg);
      setMode("view");
      setExpanded(null);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const s = t ? summarize(t) : null;
  const catPostings = t?.postings.filter((p) => isCat(p.account)) ?? [];
  return (
    <Sheet open side onClose={onClose} title={mode === "split" ? "Split" : "Transaction"}>
      {error && <ErrorBox error={error} />}
      {!t && !error && <Loading h={200} />}
      {t && s && mode === "view" && (
        <div class="stack">
          <div class="row">
            <Avatar name={t.payee} onClick={() => setLogoOpen((o) => !o)} label={logoOpen ? "Hide logo options" : "Logo options"} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 17 }}>{t.payee}</div>
              <div class="muted small">
                {dayLabel(t.date)}
                {account && ` · 🏦 ${account.name}`}
              </div>
            </div>
            <div class={`num ${s.amount > 0 ? "in" : ""}`} style={{ fontSize: 22, fontWeight: 750, letterSpacing: "-0.02em" }}>
              {s.amount > 0 ? "+" : ""}
              {money(s.amount)}
            </div>
          </div>
          {logoOpen && <LogoPanel payee={t.payee} />}
          {catPostings.length === 1 && (
            <button class={`card flat spread choice-row${expanded === "category" ? " open" : ""}`} onClick={() => setExpanded((current) => current === "category" ? null : "category")}>
              <span>
                <span class="upper">Category</span>
                <br />
                <strong style={{ color: s.uncategorized ? "var(--warn)" : undefined }}>{s.uncategorized ? "Choose a category" : <CatName account={catPostings[0]!.account} />}</strong>
              </span>
              <Icon.chevron />
            </button>
          )}
          {catPostings.length === 1 && !s.uncategorized && t.tags["cat_by"] === "jev" && settings.data?.jev.configured && (
            <button class="btn block" disabled={asking} onClick={rerunOne}>
              {asking ? "Asking Jev…" : "Re-run Jev"}
            </button>
          )}
          {catPostings.length === 1 && s.uncategorized && settings.data?.jev.configured && (
            <button class="btn block" disabled={asking} onClick={askJev}>
              {asking ? "Asking Jev…" : jevChoices.length ? "Ask Jev again" : "Ask Jev"}
            </button>
          )}
          {catPostings.length === 1 && expanded === "category" && (
            <div class="choice-options">
              <CategoryPicker categories={categories} suggested={jevChoices} direction={s.amount < 0 ? "out" : "in"} onPick={(a) => patch({ category: { to: a, from: catPostings[0]?.account } }, `Moved to ${leaf(a)}`)} />
            </div>
          )}
          <div class="card flat stack" style={{ gap: 8 }}>
            <div class="upper">Postings</div>
            {t.postings.map((p) => (
              <div class="spread small">
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {p.account}
                  {p.entity && <span class="muted"> · {p.entity}</span>}
                </span>
                <span class="num">{money(p.amount_cents)}</span>
              </div>
            ))}
          </div>
          {(() => {
            const entity = transactionEntity(t);
            const owner = entities.find((e) => e.slug === entity);
            return <>
              <button class={`card flat spread choice-row${expanded === "business" ? " open" : ""}`} onClick={() => setExpanded((current) => current === "business" ? null : "business")}>
                <span style={{ textAlign: "left" }}>
                  <span class="upper">Business or personal</span>
                  <br />
                  <strong class="row" style={{ gap: 7 }}>
                    <span class="business-icon compact" style={entity ? businessStyle(entity, owner?.color) : {}}>{owner?.type === "personal" ? "👤" : <Icon.folder />}</span>
                    {owner?.name ?? "Choose a profile"}
                  </strong>
                </span>
                <Icon.chevron />
              </button>
              {expanded === "business" && <div class="choice-options catlist">
                {entities.map((e) => (
                  <button class="catbtn" onClick={() => patch({ entity: e.slug }, "Business updated")}>
                    <span class="row" style={{ gap: 9 }}>
                      <span class="business-icon compact" style={businessStyle(e.slug, e.color)}>{e.type === "personal" ? "👤" : <Icon.folder />}</span>
                      {e.name}
                    </span>
                    {e.slug === entity && <span style={{ color: "var(--accent-text)", display: "inline-flex" }}><Icon.check /></span>}
                  </button>
                ))}
              </div>}
            </>;
          })()}
          <div class="field">
            <label>Memo</label>
            <div class="row">
              <input class="input" value={memo} onInput={(e) => setMemo((e.target as HTMLInputElement).value)} placeholder="Add a note" />
              <button class="btn" disabled={memo === (t.note ?? "")} onClick={() => patch({ memo: memo || null }, "Memo saved")}>
                Save
              </button>
            </div>
          </div>
          {catPostings.length === 1 && (
            <button class="btn block" onClick={() => setMode("split")}>
              Split across categories
            </button>
          )}
          <div class="muted tiny">
            {t.tags["source"] && `Source: ${t.tags["source"]}`}
            {t.tags["cat_by"] && ` · categorized by ${t.tags["cat_by"]}`}
            {t.tags["jev_conf"] && ` (${Math.round(Number(t.tags["jev_conf"]) * 100)}%)`}
            {t.tags["orig_category"] && ` · was “${t.tags["orig_category"]}”`}
          </div>
        </div>
      )}
      {t && mode === "split" && catPostings[0] && <SplitForm t={t} from={catPostings[0]} onDone={(n) => (setT(n), onChanged(n), setMode("view"))} />}
    </Sheet>
  );
}

/** Opened by tapping the logo: visit the payee's website, or pick which site its logo comes from. */
function LogoPanel({ payee }: { payee: string }) {
  const logo = usePayeeLogo(payee);
  const site = logo && "domain" in logo ? logo : null;
  return (
    <div class="card flat stack logo-panel" style={{ gap: 10 }}>
      {site ? (
        <div class="row">
          <Avatar name={payee} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div class="upper">Website</div>
            <div class="domain">{site.domain}</div>
            {site.missing && <div class="muted tiny">No logo found on this site</div>}
          </div>
          <a class="btn" href={`https://${site.domain}`} target="_blank" rel="noopener noreferrer">
            Visit ↗
          </a>
        </div>
      ) : (
        <div class="muted small">{logo === undefined ? "Loading…" : `No website for “${payee}” yet. Add one below to show its logo.`}</div>
      )}
      <PayeeLogoField payee={payee} />
    </div>
  );
}

/** Pick the website whose logo shows for every transaction from this payee. */
function PayeeLogoField({ payee }: { payee: string }) {
  const logo = usePayeeLogo(payee);
  const current = logo && "domain" in logo ? logo.domain : "";
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? current;
  const save = async (body: { domain: string | null } | null, msg: string) => {
    try {
      await api(`/logos/payees/${encodeURIComponent(payee)}`, body ? { method: "PUT", body } : { method: "DELETE" });
      await loadLogos(true);
      setDraft(null);
      toast(msg);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <div class="field">
      <label>Logo website</label>
      <div class="row">
        <input class="input" value={value} onInput={(e) => setDraft((e.target as HTMLInputElement).value)} placeholder="example.com" inputMode="url" />
        <button class="btn" disabled={!value.trim() || value.trim() === current} onClick={() => save({ domain: value.trim() }, "Logo updated")}>
          Save
        </button>
      </div>
      <div class="row" style={{ gap: 4 }}>
        <button class="btn ghost" style={{ height: 30, padding: "0 8px" }} onClick={() => save({ domain: null }, "Showing initials")}>
          Use initials
        </button>
        <button class="btn ghost" style={{ height: 30, padding: "0 8px" }} onClick={() => save(null, "Logo set automatically")}>
          Automatic
        </button>
        <span class="muted tiny">Applies to every “{payee}” transaction.</span>
      </div>
    </div>
  );
}

function SplitForm({ t, from, onDone }: { t: Txn; from: Txn["postings"][number]; onDone: (t: Txn) => void }) {
  const { categories } = useApp();
  const total = from.amount_cents;
  const [parts, setParts] = useState<Array<{ account: string; amount: string }>>([
    { account: from.account.endsWith(":Uncategorized") ? "" : from.account, amount: (total / 100 / 2).toFixed(2) },
    { account: "", amount: (total / 100 - Number((total / 100 / 2).toFixed(2))).toFixed(2) },
  ]);
  const [picking, setPicking] = useState<number | null>(null);
  const sum = parts.reduce((a, p) => a + Math.round(Number(p.amount || 0) * 100), 0);
  const ok = sum === total && parts.every((p) => p.account);
  const save = async () => {
    try {
      const next = await api<Txn>(`/transactions/${t.wmma_id}/split`, { body: { from: from.account, postings: parts } });
      toast("Split saved");
      onDone(next);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  if (picking !== null)
    return (
      <CategoryPicker
        categories={categories}
        onPick={(a) => {
          setParts((ps) => ps.map((p, i) => (i === picking ? { ...p, account: a } : p)));
          setPicking(null);
        }}
      />
    );
  return (
    <div class="stack">
      {parts.map((p, i) => (
        <div class="row">
          <button class="input" style={{ textAlign: "left", flex: 1, cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} onClick={() => setPicking(i)}>
            {p.account ? <CatName account={p.account} /> : <span class="muted">Category…</span>}
          </button>
          <input class="input num" style={{ width: 110, textAlign: "right" }} inputMode="decimal" value={p.amount} onInput={(e) => setParts((ps) => ps.map((x, j) => (j === i ? { ...x, amount: (e.target as HTMLInputElement).value } : x)))} />
          {parts.length > 2 && (
            <button class="btn ghost" aria-label="Remove" onClick={() => setParts((ps) => ps.filter((_, j) => j !== i))}>
              ×
            </button>
          )}
        </div>
      ))}
      <div class="spread small">
        <button class="btn ghost" onClick={() => setParts((ps) => [...ps, { account: "", amount: "0.00" }])}>
          + Add line
        </button>
        <span class={sum === total ? "muted" : ""} style={sum === total ? {} : { color: "var(--out)", fontWeight: 650 }}>
          {money(sum)} of {money(total)}
        </span>
      </div>
      <button class="btn primary block" disabled={!ok} onClick={save}>
        Save split
      </button>
    </div>
  );
}
