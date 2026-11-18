import { useCallback, useState } from "preact/hooks";
import { api, catLabel, compact, leaf, money, monthEnd, monthName, monthShift, monthStart, thisMonth, today, useApi } from "../api";
import { Chart, type Theme } from "../components/chart";
import { ErrorBox, Loading, Sheet, toast } from "../components/ui";
import { EntitySwitcher, go, useApp } from "../app";

type Tab = "pnl" | "cashflow" | "budget" | "networth" | "spending" | "trend";
const TABS: Array<[Tab, string]> = [
  ["pnl", "P&L"],
  ["cashflow", "Cash flow"],
  ["budget", "Budget"],
  ["networth", "Net worth"],
  ["spending", "Spending"],
  ["trend", "Trend"],
];

type Range = "month" | "last" | "ytd" | "12m" | "lastyear";
function rangeDates(r: Range): { from: string; to: string; label: string } {
  const m = thisMonth();
  const y = m.slice(0, 4);
  switch (r) {
    case "month":
      return { from: monthStart(m), to: monthEnd(m), label: monthName(m, { month: "long" }) };
    case "last":
      return { from: monthStart(monthShift(m, -1)), to: monthEnd(monthShift(m, -1)), label: monthName(monthShift(m, -1), { month: "long" }) };
    case "ytd":
      return { from: `${y}-01-01`, to: today(), label: `${y} to date` };
    case "12m":
      return { from: monthStart(monthShift(m, -11)), to: monthEnd(m), label: "Last 12 months" };
    case "lastyear":
      return { from: `${Number(y) - 1}-01-01`, to: `${Number(y) - 1}-12-31`, label: String(Number(y) - 1) };
  }
}

export function Reports({ query }: { query: URLSearchParams }) {
  const tab = (query.get("tab") as Tab) || "pnl";
  const [range, setRange] = useState<Range>("month");
  return (
    <div class="stack">
      <div class="topbar">
        <h1>Reports</h1>
        <EntitySwitcher />
      </div>
      <div class="chips">
        {TABS.map(([k, l]) => (
          <button class={`chip${tab === k ? " active" : ""}`} onClick={() => go(`/reports?tab=${k}`)}>
            {l}
          </button>
        ))}
      </div>
      {tab !== "budget" && tab !== "networth" && tab !== "trend" && (
        <div class="seg" style={{ alignSelf: "flex-start", overflowX: "auto", maxWidth: "100%" }}>
          {(
            [
              ["month", "This month"],
              ["last", "Last month"],
              ["ytd", "YTD"],
              ["12m", "12 mo"],
              ["lastyear", "Last year"],
            ] as const
          ).map(([k, l]) => (
            <button class={range === k ? "active" : ""} onClick={() => setRange(k)}>
              {l}
            </button>
          ))}
        </div>
      )}
      {tab === "pnl" && <Pnl range={range} />}
      {tab === "cashflow" && <Cashflow range={range} />}
      {tab === "budget" && <Budget />}
      {tab === "networth" && <NetWorth />}
      {tab === "spending" && <Spending range={range} />}
      {tab === "trend" && <Trend />}
    </div>
  );
}

const eq = (entity: string | null) => (entity ? `&entity=${encodeURIComponent(entity)}` : "");

function Pnl({ range }: { range: Range }) {
  const { entity, entities } = useApp();
  const r = rangeDates(range);
  const { data, error, loading } = useApi(`/reports/pnl?from=${r.from}&to=${r.to}${eq(entity)}`, [entity, range]);
  if (error) return <ErrorBox error={error} />;
  if (loading || !data) return <Loading h={320} />;
  const max = Math.max(1, ...data.income.map((l: any) => l.amount_cents), ...data.expenses.map((l: any) => l.amount_cents));
  const name = entity ? (entities.find((e) => e.slug === entity)?.name ?? entity) : "All entities";
  return (
    <div class="grid">
      <div class="card hero span-12">
        <div class="upper">
          {name} · {r.label}
        </div>
        <div class={`big num ${data.net_cents < 0 ? "out" : ""}`}>{data.net}</div>
        <div class="muted small">
          Net income · {data.totalIncome} in, {data.totalExpenses} out
        </div>
      </div>
      <div class="card span-6">
        <h2>Income</h2>
        <Lines lines={data.income} max={max} total={data.totalIncome} r={r} />
      </div>
      <div class="card span-6">
        <h2>Expenses</h2>
        <Lines lines={data.expenses} max={max} total={data.totalExpenses} out r={r} />
      </div>
    </div>
  );
}

function Lines({ lines, max, total, out, r }: { lines: any[]; max: number; total: string; out?: boolean; r: { from: string; to: string } }) {
  if (lines.length === 0) return <div class="empty">Nothing in this period</div>;
  return (
    <table class="table">
      <tbody>
        {lines.map((l) => (
          <tr title={`${l.account} · ${r.from} to ${r.to}`}>
            <td>
              {catLabel(l.account)}
              <div class={`inline-bar${out ? " out" : ""}`} style={{ width: `${Math.max(2, (l.amount_cents / max) * 100)}%` }} />
            </td>
            <td class="r num">{l.amount}</td>
          </tr>
        ))}
        <tr class="total">
          <td>Total</td>
          <td class="r num">{total}</td>
        </tr>
      </tbody>
    </table>
  );
}

function Cashflow({ range }: { range: Range }) {
  const { entity } = useApp();
  const r = rangeDates(range);
  const { data, error, loading } = useApi(`/reports/cashflow?from=${r.from}&to=${r.to}&depth=2${eq(entity)}`, [entity, range]);
  const option = useCallback(
    (t: Theme) => {
      const color = (kind: string, i: number) => (kind === "income" ? t.in : kind === "hub" ? t.accent : kind === "savings" ? t.accent : kind === "deficit" ? t.out : t.palette[(i % (t.palette.length - 1)) + 1]);
      return {
        tooltip: { trigger: "item", valueFormatter: (v: number) => money(v) },
        series: [
          {
            type: "sankey",
            left: 4,
            right: 110,
            top: 10,
            bottom: 10,
            nodeWidth: 12,
            nodeGap: 10,
            draggable: false,
            emphasis: { focus: "adjacency" },
            lineStyle: { color: "gradient", curveness: 0.5, opacity: t.dark ? 0.35 : 0.28 },
            label: { color: t.ink, fontSize: 12, formatter: (p: any) => `${p.data.label}` },
            data: (data?.nodes ?? []).map((n: any, i: number) => ({ name: n.id, label: n.label, itemStyle: { color: color(n.kind, i), borderWidth: 0 } })),
            links: (data?.links ?? []).map((l: any) => ({ source: l.source, target: l.target, value: l.value_cents })),
          },
        ],
      };
    },
    [data],
  );
  if (error) return <ErrorBox error={error} />;
  if (loading || !data) return <Loading h={380} />;
  return (
    <div class="card">
      <div class="spread">
        <div>
          <h2>Where the money went</h2>
          <div class="sub">{r.label}</div>
        </div>
        <span class={`pill ${data.net.startsWith("-") ? "over" : "ok"}`}>{data.net.startsWith("-") ? `${data.net} net` : `${data.net} saved`}</span>
      </div>
      {data.links.length === 0 ? <div class="empty">No income or spending in this period</div> : <Chart option={option} class="chart tall" />}
    </div>
  );
}

function Budget() {
  const { entity, entities } = useApp();
  const [month, setMonth] = useState(thisMonth());
  const ent = entity ?? entities.find((e) => e.type === "personal")?.slug ?? entities[0]?.slug ?? null;
  const { data, error, loading, reload } = useApi(ent ? `/reports/budget?entity=${encodeURIComponent(ent)}&month=${month}` : null, [ent, month]);
  const [edit, setEdit] = useState<{ account: string; amount: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const save = async (account: string, amount: string) => {
    try {
      await api("/budgets", { method: "PUT", body: [{ entity: ent, account, month, amount }] });
      toast(`Budget set for ${leaf(account)}`);
      setEdit(null);
      setAdding(false);
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  if (!ent) return <div class="empty">Add an entity first</div>;
  const lines: any[] = data?.lines ?? [];
  const cents = (s: string) => Math.round(Number(s.replace(/[$,]/g, "")) * 100);
  const totalBudget = lines.reduce((a, l) => a + cents(l.budgeted), 0);
  const totalSpent = lines.reduce((a, l) => a + cents(l.activity), 0);
  return (
    <div class="stack">
      <div class="spread">
        <div class="seg">
          <button onClick={() => setMonth(monthShift(month, -1))} aria-label="Previous month">
            ‹
          </button>
          <button class="active">{monthName(month, { month: "long", year: "numeric" })}</button>
          <button onClick={() => setMonth(monthShift(month, 1))} aria-label="Next month">
            ›
          </button>
        </div>
        <button class="btn" onClick={() => setAdding(true)}>
          + Budget
        </button>
      </div>
      {!entity && <div class="muted small">Showing {entities.find((e) => e.slug === ent)?.name}. Pick an entity above to switch.</div>}
      {error && <ErrorBox error={error} />}
      {loading && <Loading h={300} />}
      {data && (
        <>
          <div class="grid-2">
            <div class="card tile">
              <div class="label">Budgeted</div>
              <div class="value num">{money(totalBudget, true)}</div>
            </div>
            <div class="card tile">
              <div class="label">Spent</div>
              <div class={`value num ${totalSpent > totalBudget ? "out" : ""}`}>{money(totalSpent, true)}</div>
            </div>
          </div>
          <div class="card" style={{ paddingTop: 6 }}>
            {lines.length === 0 && <div class="empty">No budgets yet. Tap “+ Budget” to add one.</div>}
            {lines.map((l) => {
              const avail = l.available_cents as number;
              const budget = cents(l.budgeted) + cents(l.rolledOver);
              const spent = cents(l.activity);
              const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : spent > 0 ? 100 : 0;
              const state = avail < 0 ? "over" : budget > 0 && spent / budget > 0.85 ? "warn" : avail === 0 ? "zero" : "ok";
              return (
                <div class="item tap" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }} onClick={() => setEdit({ account: l.account, amount: l.budgeted.replace(/[$,]/g, "") })}>
                  <div class="spread">
                    <strong>{catLabel(l.account)}</strong>
                    <span class={`pill ${state}`}>{l.available}</span>
                  </div>
                  <div class={`bar ${state === "over" ? "over" : state === "warn" ? "warn" : ""}`}>
                    <div style={{ width: `${pct}%` }} />
                  </div>
                  <div class="spread tiny muted">
                    <span>
                      {l.activity} of {l.budgeted}
                      {cents(l.rolledOver) !== 0 && ` · ${cents(l.rolledOver) > 0 ? "+" : ""}${l.rolledOver} rolled over`}
                    </span>
                    <span>available</span>
                  </div>
                </div>
              );
            })}
            {data.unbudgetedSpending !== "$0.00" && <div class="muted small" style={{ paddingTop: 10 }}>Unbudgeted spending this month: {data.unbudgetedSpending}</div>}
          </div>
        </>
      )}
      <Sheet open={!!edit} onClose={() => setEdit(null)} title={edit ? catLabel(edit.account) : ""}>
        {edit && <AmountForm initial={edit.amount} note={`Monthly amount from ${monthName(month, { month: "long", year: "numeric" })} on`} onSave={(a) => save(edit.account, a)} />}
      </Sheet>
      <Sheet open={adding} onClose={() => setAdding(false)} title="New budget">
        <NewBudget onSave={save} />
      </Sheet>
    </div>
  );
}

function AmountForm({ initial, note, onSave }: { initial: string; note: string; onSave: (amount: string) => void }) {
  const [v, setV] = useState(initial);
  return (
    <form
      class="stack"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(v);
      }}
    >
      <div class="field">
        <label>{note}</label>
        <input class="input num" style={{ fontSize: 22, height: 54 }} inputMode="decimal" value={v} onInput={(e) => setV((e.target as HTMLInputElement).value)} autoFocus />
      </div>
      <button class="btn primary block" type="submit">
        Save
      </button>
    </form>
  );
}

function NewBudget({ onSave }: { onSave: (account: string, amount: string) => void }) {
  const { categories } = useApp();
  const [account, setAccount] = useState("");
  const [amount, setAmount] = useState("");
  const expenses = categories.filter((c) => c.startsWith("Expenses:"));
  return (
    <div class="stack">
      <div class="field">
        <label>Category</label>
        <select class="input" value={account} onChange={(e) => setAccount((e.target as HTMLSelectElement).value)}>
          <option value="">Choose…</option>
          {expenses.map((c) => (
            <option value={c}>{catLabel(c)}</option>
          ))}
        </select>
      </div>
      <div class="field">
        <label>Monthly amount</label>
        <input class="input num" inputMode="decimal" placeholder="400.00" value={amount} onInput={(e) => setAmount((e.target as HTMLInputElement).value)} />
      </div>
      <button class="btn primary block" disabled={!account || !amount} onClick={() => onSave(account, amount)}>
        Add budget
      </button>
    </div>
  );
}

function NetWorth() {
  const { entity } = useApp();
  const m = thisMonth();
  const [span, setSpan] = useState(12);
  const { data, error, loading } = useApi(`/reports/networth?from=${monthShift(m, -(span - 1))}&to=${m}`, [span]);
  const option = useCallback(
    (t: Theme) => {
      const series: any[] = data?.series ?? [];
      const ents: string[] = (data?.entities ?? []).filter((e: string) => e !== "(none)");
      return {
        grid: { left: 4, right: 8, top: 30, bottom: 0, containLabel: true },
        legend: { top: 0, left: 0, itemWidth: 10, itemHeight: 10, textStyle: { color: t.muted } },
        tooltip: { trigger: "axis", valueFormatter: (v: number) => money(v, true) },
        xAxis: { type: "category", boundaryGap: false, data: series.map((s) => monthName(s.month)), axisLine: { lineStyle: { color: t.line } }, axisTick: { show: false }, axisLabel: { color: t.muted } },
        yAxis: { type: "value", scale: true, splitLine: { lineStyle: { color: t.line, type: "dashed" } }, axisLabel: { color: t.muted, formatter: (v: number) => compact(v) } },
        series: entity
          ? [{ name: entity, type: "line", smooth: 0.3, symbol: "none", lineStyle: { width: 3, color: t.accent }, areaStyle: { color: `${t.accent}22` }, data: series.map((s) => s.by_entity_cents[entity] ?? 0) }]
          : [
              ...ents.map((e) => ({ name: e, type: "line", stack: "nw", smooth: 0.3, symbol: "none", lineStyle: { width: 0 }, areaStyle: { opacity: 0.55 }, data: series.map((s) => s.by_entity_cents[e] ?? 0) })),
              { name: "Total", type: "line", smooth: 0.3, symbol: "none", lineStyle: { width: 3, color: t.ink }, data: series.map((s) => s.net_worth_cents) },
            ],
      };
    },
    [data, entity],
  );
  if (error) return <ErrorBox error={error} />;
  if (loading || !data) return <Loading h={360} />;
  const s = data.series;
  const last = entity ? (s.at(-1)?.by_entity_cents[entity] ?? 0) : (s.at(-1)?.net_worth_cents ?? 0);
  const first = entity ? (s[0]?.by_entity_cents[entity] ?? 0) : (s[0]?.net_worth_cents ?? 0);
  return (
    <div class="stack">
      <div class="card hero">
        <div class="spread">
          <div class="upper">Net worth</div>
          <div class="seg">
            {[6, 12, 36].map((n) => (
              <button class={span === n ? "active" : ""} onClick={() => setSpan(n)}>
                {n < 12 ? `${n}M` : `${n / 12}Y`}
              </button>
            ))}
          </div>
        </div>
        <div class="big num">{money(last, true)}</div>
        <span class={`delta ${last >= first ? "up" : "down"}`}>
          {last >= first ? "▲" : "▼"} {money(Math.abs(last - first), true)} over {span} months
        </span>
        <Chart option={option} class="chart tall" />
      </div>
      {!entity && (
        <div class="grid-2">
          <div class="card tile">
            <div class="label">Assets</div>
            <div class="value num">{money(s.at(-1)?.assets_cents ?? 0, true)}</div>
          </div>
          <div class="card tile">
            <div class="label">Liabilities</div>
            <div class="value num">{money(-(s.at(-1)?.liabilities_cents ?? 0), true)}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function Spending({ range }: { range: Range }) {
  const { entity } = useApp();
  const r = rangeDates(range);
  const [depth, setDepth] = useState(2);
  const { data, error, loading } = useApi(`/reports/spending?from=${r.from}&to=${r.to}&depth=${depth}${eq(entity)}`, [entity, range, depth]);
  const cats: any[] = data?.categories ?? [];
  const option = useCallback(
    (t: Theme) => ({
      tooltip: { trigger: "item", valueFormatter: (v: number) => money(v) },
      series: [
        {
          type: "pie",
          radius: ["58%", "86%"],
          padAngle: 1.5,
          itemStyle: { borderRadius: 7, borderColor: t.surface, borderWidth: 2 },
          label: { show: false },
          data: cats.map((c) => ({ name: catLabel(c.account), value: c.amount_cents })),
        },
      ],
    }),
    [data],
  );
  if (error) return <ErrorBox error={error} />;
  if (loading || !data) return <Loading h={360} />;
  return (
    <div class="grid">
      <div class="card span-5" style={{ position: "relative" }}>
        <div class="spread">
          <h2>{r.label}</h2>
          <div class="seg">
            <button class={depth === 2 ? "active" : ""} onClick={() => setDepth(2)}>
              Groups
            </button>
            <button class={depth === 3 ? "active" : ""} onClick={() => setDepth(3)}>
              Detail
            </button>
          </div>
        </div>
        {cats.length === 0 ? (
          <div class="empty">No spending in this period</div>
        ) : (
          <div style={{ position: "relative" }}>
            <Chart option={option} class="chart tall" />
            <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none", textAlign: "center" }}>
              <div>
                <div class="muted small">Total spent</div>
                <div class="num" style={{ fontWeight: 760, fontSize: 26, letterSpacing: "-0.03em" }}>{data.total}</div>
              </div>
            </div>
          </div>
        )}
      </div>
      <div class="card span-7">
        <table class="table">
          <thead>
            <tr>
              <th>Category</th>
              <th class="r">Share</th>
              <th class="r">Amount</th>
            </tr>
          </thead>
          <tbody>
            {cats.map((c) => (
              <tr>
                <td>
                  {catLabel(c.account)}
                  <div class="inline-bar" style={{ width: `${Math.max(2, c.share)}%` }} />
                </td>
                <td class="r num muted">{c.share}%</td>
                <td class="r num">{c.amount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Trend() {
  const { entity } = useApp();
  const m = thisMonth();
  const { data, error, loading } = useApi(`/reports/trend?from=${monthShift(m, -11)}&to=${m}${eq(entity)}`, [entity]);
  const months: any[] = data?.months ?? [];
  const option = useCallback(
    (t: Theme) => ({
      grid: { left: 4, right: 8, top: 30, bottom: 0, containLabel: true },
      legend: { top: 0, left: 0, itemWidth: 10, itemHeight: 10, textStyle: { color: t.muted } },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => money(v, true) },
      xAxis: { type: "category", data: months.map((x) => monthName(x.month)), axisLine: { lineStyle: { color: t.line } }, axisTick: { show: false }, axisLabel: { color: t.muted } },
      yAxis: { type: "value", splitLine: { lineStyle: { color: t.line, type: "dashed" } }, axisLabel: { color: t.muted, formatter: (v: number) => compact(v) } },
      series: [
        { name: "Income", type: "bar", data: months.map((x) => x.income_cents), itemStyle: { color: t.in, borderRadius: [6, 6, 0, 0] }, barMaxWidth: 16 },
        { name: "Spending", type: "bar", data: months.map((x) => x.expenses_cents), itemStyle: { color: t.out, borderRadius: [6, 6, 0, 0] }, barMaxWidth: 16 },
        { name: "Net", type: "line", smooth: 0.3, data: months.map((x) => x.net_cents), symbol: "circle", symbolSize: 6, lineStyle: { width: 2.5, color: t.ink }, itemStyle: { color: t.ink } },
      ],
    }),
    [data],
  );
  if (error) return <ErrorBox error={error} />;
  if (loading || !data) return <Loading h={360} />;
  const avgIn = months.reduce((a, x) => a + x.income_cents, 0) / Math.max(1, months.length);
  const avgOut = months.reduce((a, x) => a + x.expenses_cents, 0) / Math.max(1, months.length);
  return (
    <div class="stack">
      <div class="grid-2">
        <div class="card tile">
          <div class="label">Avg monthly income</div>
          <div class="value num in">{money(avgIn, true)}</div>
        </div>
        <div class="card tile">
          <div class="label">Avg monthly spending</div>
          <div class="value num">{money(avgOut, true)}</div>
        </div>
      </div>
      <div class="card">
        <h2>Income vs spending</h2>
        <div class="sub">Last 12 months</div>
        <Chart option={option} class="chart tall" />
      </div>
    </div>
  );
}
