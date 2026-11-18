import { useEffect, useMemo, useState } from "preact/hooks";
import { api, catLabel, dayLabel, leaf, money } from "../api";
import { Avatar, CategoryPicker, ErrorBox, Icon, Loading, Sheet, toast } from "../components/ui";
import { businessStyle, EntitySwitcher, go, transactionEntity, useApp } from "../app";

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
export function summarize(t: Txn): { amount: number; category: string; uncategorized: boolean } {
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
  return { amount, category, uncategorized };
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
          {s.uncategorized ? <span style={{ color: "var(--warn)", fontWeight: 650 }}>Needs category</span> : s.category}
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

export function Transactions({ query }: { query: URLSearchParams }) {
  const { entity, entities } = useApp();
  const [text, setText] = useState(query.get("q") ?? "");
  const [debounced, setDebounced] = useState(text);
  const [rows, setRows] = useState<Txn[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "uncat" | "in" | "out">("all");
  const openId = query.get("id");

  useEffect(() => {
    const t = setTimeout(() => setDebounced(text), 250);
    return () => clearTimeout(t);
  }, [text]);

  const load = (offset = 0) => {
    const q = new URLSearchParams({ limit: "100", offset: String(offset) });
    if (debounced) q.set("text", debounced);
    if (entity) q.set("entity", entity);
    api<{ total: number; transactions: Txn[] }>(`/transactions?${q}`)
      .then((r) => {
        setTotal(r.total);
        setRows((prev) => (offset === 0 ? r.transactions : [...(prev ?? []), ...r.transactions]));
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  };
  useEffect(() => load(0), [debounced, entity]);

  const shown = useMemo(
    () =>
      (rows ?? []).filter((t) => {
        if (filter === "all") return true;
        const s = summarize(t);
        return filter === "uncat" ? s.uncategorized : filter === "in" ? s.amount > 0 : s.amount < 0;
      }),
    [rows, filter],
  );
  const groups = useMemo(() => {
    const g: Array<[string, Txn[]]> = [];
    for (const t of shown) {
      const last = g[g.length - 1];
      if (last && last[0] === t.date) last[1].push(t);
      else g.push([t.date, [t]]);
    }
    return g;
  }, [shown]);

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
      </div>
      {error && <ErrorBox error={error} />}
      {!rows && !error && <Loading h={360} />}
      {rows && (
        <div class="card" style={{ paddingTop: 4 }}>
          {groups.length === 0 && <div class="empty">No transactions</div>}
          {groups.map(([d, list]) => (
            <div>
              <div class="dategroup upper">{dayLabel(d)}</div>
              <div class="list">
                {list.map((t) => (
                  <TxnRow t={t} entities={entities} onClick={() => go(`/transactions?id=${t.wmma_id}${text ? `&q=${encodeURIComponent(text)}` : ""}`)} />
                ))}
              </div>
            </div>
          ))}
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
          onClose={() => go(`/transactions${text ? `?q=${encodeURIComponent(text)}` : ""}`)}
          onChanged={(t) => setRows((rs) => (rs ?? []).map((r) => (r.wmma_id === t.wmma_id ? t : r)))}
        />
      )}
    </div>
  );
}

function TxnSheet({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: (t: Txn) => void }) {
  const { entities, categories, refreshReview } = useApp();
  const [t, setT] = useState<Txn | null>(null);
  const [mode, setMode] = useState<"view" | "split">("view");
  const [expanded, setExpanded] = useState<"category" | "business" | null>(null);
  const [memo, setMemo] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
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
    <Sheet open onClose={onClose} title={mode === "split" ? "Split" : "Transaction"}>
      {error && <ErrorBox error={error} />}
      {!t && !error && <Loading h={200} />}
      {t && s && mode === "view" && (
        <div class="stack">
          <div class="row">
            <Avatar name={t.payee} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 17 }}>{t.payee}</div>
              <div class="muted small">{dayLabel(t.date)}</div>
            </div>
            <div class={`num ${s.amount > 0 ? "in" : ""}`} style={{ fontSize: 22, fontWeight: 750, letterSpacing: "-0.02em" }}>
              {s.amount > 0 ? "+" : ""}
              {money(s.amount)}
            </div>
          </div>
          {catPostings.length === 1 && (
            <button class={`card flat spread choice-row${expanded === "category" ? " open" : ""}`} onClick={() => setExpanded((current) => current === "category" ? null : "category")}>
              <span>
                <span class="upper">Category</span>
                <br />
                <strong style={{ color: s.uncategorized ? "var(--warn)" : undefined }}>{s.uncategorized ? "Choose a category" : catLabel(catPostings[0]!.account)}</strong>
              </span>
              <Icon.chevron />
            </button>
          )}
          {catPostings.length === 1 && expanded === "category" && (
            <div class="choice-options">
              <CategoryPicker categories={categories} direction={s.amount < 0 ? "out" : "in"} onPick={(a) => patch({ category: { to: a, from: catPostings[0]?.account } }, `Moved to ${leaf(a)}`)} />
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
                    {e.slug === entity && <span style={{ color: "var(--accent)", display: "inline-flex" }}><Icon.check /></span>}
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
            {p.account ? catLabel(p.account) : <span class="muted">Category…</span>}
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
