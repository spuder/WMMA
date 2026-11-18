import { useCallback, useState } from "preact/hooks";
import { catLabel, compact, money, useApi } from "../api";
import { businessStyle, go, useApp } from "../app";
import { Chart, type Theme } from "../components/chart";
import {
  axis,
  ByMenu,
  ChartMenu,
  type ChartKind,
  Treemap,
  BarList,
  BY_OPTIONS,
  type By,
  csvMoney,
  Donut,
  downloadCsv,
  FlowBars,
  FlowSankey,
  type Interval,
  Kpis,
  openSlice,
  pct,
  PeriodTransactions,
  periodLabel,
  qs,
  RANGES,
  RangeMenu,
  type RangeKey,
  rangeDates,
  Seg,
  shortDate,
  slices,
  StackBars,
  Summary,
  useStored,
  valueAxis, ReportFilters, useScope } from "../components/report-kit";
import { CatName, ErrorBox, Icon, Loading } from "../components/ui";

type Tab = "cashflow" | "spending" | "income" | "pnl";
const TABS: Array<[Tab, string]> = [
  ["cashflow", "Cash flow"],
  ["spending", "Spending"],
  ["income", "Income"],
  ["pnl", "Profit & loss"],
];
const RANGE_KEYS = RANGES.map(([k]) => k);

export function Reports({ query }: { query: URLSearchParams }) {
  const tab = (TABS.find(([k]) => k === query.get("tab"))?.[0] ?? "cashflow") as Tab;
  const [range, setRange] = useStored<RangeKey>("reports.range", "12m", RANGE_KEYS);
  const r = rangeDates(range);
  return (
    <div class="stack">
      <div class="topbar report-top">
        <div class="report-title">
          <h1>Reports</h1>
          <nav class="tabs" aria-label="Report">
            {TABS.map(([k, l]) => (
              <button class={`tab${tab === k ? " active" : ""}`} aria-current={tab === k ? "page" : undefined} onClick={() => go(`/reports?tab=${k}`)}>
                {l}
              </button>
            ))}
          </nav>
        </div>
        <div class="toolbar">
          <RangeMenu value={range} onChange={setRange} />
          <ReportFilters />
        </div>
      </div>
      {tab === "cashflow" && <CashflowReport from={r.from} to={r.to} label={r.label} />}
      {tab === "spending" && <KindReport kind="expense" from={r.from} to={r.to} label={r.label} />}
      {tab === "income" && <KindReport kind="income" from={r.from} to={r.to} label={r.label} />}
      {tab === "pnl" && <ProfitLoss from={r.from} to={r.to} label={r.label} range={range} />}
    </div>
  );
}

/** Interval that keeps a range's chart readable. */
function autoInterval(from: string | null, to: string | null): Interval {
  if (!from || !to) return "month";
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  return days <= 45 ? "day" : days <= 120 ? "week" : days <= 1100 ? "month" : "quarter";
}

function CashflowReport({ from, to, label }: { from: string | null; to: string | null; label: string }) {
  const scope = useScope();
  const [view, setView] = useStored<"bars" | "sankey">("reports.cf.view", "bars", ["bars", "sankey"]);
  const [interval, setInterval] = useStored<Interval | "auto">("reports.cf.interval", "auto", ["auto", "week", "month", "quarter", "year"]);
  const [by, setBy] = useStored<By>("reports.cf.by", "category", ["category", "group", "merchant"]);
  const iv = interval === "auto" ? autoInterval(from, to) : interval;
  const ov = useApi(`/reports/overview${qs({ from, to, ...scope.q })}`, [scope.key, from, to]);
  const se = useApi(`/reports/series${qs({ from, to, ...scope.q, interval: iv })}`, [scope.key, from, to, iv]);
  if (ov.error) return <ErrorBox error={ov.error} />;
  const d = ov.data;
  return (
    <div class="stack">
      {d ? (
        <Kpis
          items={[
            { label: "Total income", value: money(d.income.total_cents), tone: "in" },
            { label: "Total expenses", value: money(d.expenses.total_cents), tone: "neg" },
            { label: "Total net income", value: money(d.net_cents), tone: d.net_cents < 0 ? "neg" : "" },
            { label: "Savings rate", value: pct(d.savings_rate, 0) },
          ]}
        />
      ) : (
        <Loading h={92} />
      )}
      <div class="card chart-card">
        <div class="card-head">
          <div>
            <h2>{label}</h2>
            {d && <div class="sub">{shortDate(d.from)} – {shortDate(d.to)}</div>}
          </div>
          <div class="row wrap">
            <ChartMenu value={view === "bars" ? "trend" : "sankey"} onChange={(k) => setView(k === "sankey" ? "sankey" : "bars")} options={["trend", "sankey"]} noun="cash flow" />
            {view === "bars" && (
              <Seg
                value={interval}
                onChange={setInterval}
                label="Interval"
                options={[["auto", "Auto"], ["month", "Monthly"], ["quarter", "Quarterly"], ["year", "Yearly"]]}
              />
            )}
          </div>
        </div>
        {view === "sankey" ? <FlowSankey from={d?.from ?? from} to={d?.to ?? to} /> : se.data ? <FlowBars periods={se.data.periods} interval={se.data.interval} /> : <Loading h={380} />}
      </div>
      <div class="grid">
        <div class="card span-8">
          <div class="card-head">
            <h2>Breakdown</h2>
            <ByMenu value={by} onChange={setBy} />
          </div>
          {d ? (
            <>
              <h3 class="section-h">Income</h3>
              <BarList items={slices(d.income, by)} tone="in" onPick={openSlice} limit={8} />
              <h3 class="section-h">Expenses</h3>
              <BarList items={slices(d.expenses, by)} tone="out" onPick={openSlice} />
            </>
          ) : (
            <Loading h={300} />
          )}
        </div>
        <div class="span-4">
          {d && (
            <Summary
              sub={
                <span class="row" style={{ gap: 6 }}>
                  <span class="tiny-ico"><Icon.calendar /></span>
                  {label}
                </span>
              }
              rows={[
                ["Total income", `+${money(d.income.total_cents)}`, "in"],
                ["Total spending", money(d.expenses.total_cents)],
                ["Net cash flow", money(d.net_cents), d.net_cents < 0 ? "neg" : ""],
                ["Savings rate", pct(d.savings_rate, 0)],
                ["Income transactions", String(d.income.count)],
                ["Expense transactions", String(d.expenses.count)],
              ]}
              footer={
                <button
                  class="linkbtn"
                  onClick={() =>
                    downloadCsv(`cash-flow-${d.from}-${d.to}.csv`, [
                      ["kind", "category", "amount"],
                      ...d.income.categories.map((c: any) => ["income", c.account, csvMoney(c.cents)]),
                      ...d.expenses.categories.map((c: any) => ["expense", c.account, csvMoney(c.cents)]),
                    ])
                  }
                >
                  Download CSV
                </button>
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}

function KindReport({ kind, from, to, label }: { kind: "expense" | "income"; from: string | null; to: string | null; label: string }) {
  const scope = useScope();
  const [view, setView] = useStored<ChartKind>(`reports.${kind}.chart`, "pie", ["pie", "breakdown", "treemap", "trend"]);
  const [by, setBy] = useStored<By>(`reports.${kind}.by`, "category", ["category", "group", "merchant"]);
  const iv = autoInterval(from, to);
  const ov = useApi(`/reports/overview${qs({ from, to, ...scope.q })}`, [scope.key, from, to]);
  const se = useApi(view === "trend" ? `/reports/series${qs({ from, to, ...scope.q, interval: iv, stack: kind, top: 8 })}` : null, [scope.key, from, to, view]);
  if (ov.error) return <ErrorBox error={ov.error} />;
  const d = ov.data;
  const k = d ? (kind === "income" ? d.income : d.expenses) : null;
  return (
    <div class="stack">
      <div class="card chart-card">
        <div class="card-head">
          <div class="stack" style={{ gap: 10 }}>
            <div>
              <h2>{label}</h2>
              {d && <div class="sub">{shortDate(d.from)} – {shortDate(d.to)}</div>}
            </div>
            <ChartMenu value={view} onChange={setView} options={["pie", "breakdown", "treemap", "trend"]} noun={kind === "income" ? "income" : "expense"} />
          </div>
          <div class="row wrap">
            {view !== "trend" && <ByMenu value={by} onChange={setBy} />}
            {k && (
              <button class="icon-btn" aria-label="Download CSV" title="Download CSV" onClick={() => downloadCsv(`${kind === "income" ? "income" : "spending"}-${d.from}-${d.to}.csv`, [[by, "amount"], ...slices(k, by).map((x) => [x.account ?? x.text, csvMoney(x.cents)])])}>
                <Icon.download />
              </button>
            )}
          </div>
        </div>
        {!k ? (
          <Loading h={380} />
        ) : view === "pie" ? (
          <Donut items={slices(k, by)} total={k.total_cents} label="Total" />
        ) : view === "breakdown" ? (
          <BarList items={slices(k, by)} tone={kind === "income" ? "in" : "out"} onPick={openSlice} limit={15} />
        ) : view === "treemap" ? (
          <Treemap items={slices(k, by)} total={k.total_cents} />
        ) : se.data?.stack ? (
          <StackBars periods={se.data.periods} interval={se.data.interval} stack={se.data.stack} tone={kind === "income" ? "in" : "out"} />
        ) : (
          <Loading h={380} />
        )}
      </div>
      <div class="grid">
        <div class="card span-8">
          <div class="card-head">
            <h2>Transactions</h2>
          </div>
          <PeriodTransactions from={d?.from ?? from} to={d?.to ?? to} kind={kind} />
        </div>
        <div class="span-4 stack">
          {k && (
            <Summary
              rows={[
                ["Total transactions", String(k.count)],
                ["Largest transaction", money(k.largest_cents), kind === "income" ? "in" : ""],
                ["Average transaction", money(k.average_cents), kind === "income" ? "in" : ""],
                [kind === "income" ? "Total income" : "Total spending", money(k.total_cents), kind === "income" ? "in" : ""],
                ["First transaction", shortDate(k.first_date)],
                ["Last transaction", shortDate(k.last_date)],
              ]}
              footer={
                <button
                  class="linkbtn"
                  onClick={() => downloadCsv(`${kind === "income" ? "income" : "spending"}-${d.from}-${d.to}.csv`, [["category", "transactions", "amount"], ...k.categories.map((c: any) => [c.account, c.count, csvMoney(c.cents)])])}
                >
                  Download CSV
                </button>
              }
            />
          )}
          {k && k.merchants.length > 0 && (
            <div class="card">
              <h2>Top {kind === "income" ? "payers" : "merchants"}</h2>
              <BarList items={slices(k, "merchant")} tone={kind === "income" ? "in" : "out"} limit={6} onPick={openSlice} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- profit & loss ----------------------------------------------------------

const FORM_NAME: Record<string, string> = {
  schedule_c: "Schedule C",
  s_corp_1120s: "Form 1120-S",
  partnership_1065: "Form 1065",
  schedule_e: "Schedule E",
  personal: "Personal",
};

function ProfitLoss({ from, to, label, range }: { from: string | null; to: string | null; label: string; range: RangeKey }) {
  const { entities } = useApp();
  const scope = useScope();
  const iv = autoInterval(from, to) === "day" || autoInterval(from, to) === "week" ? "week" : "month";
  const biz = useApi(`/reports/businesses${qs({ from, to, interval: iv, ...scope.q })}`, [from, to, iv, scope.key]);
  const [pick, setPick] = useStored<string>("reports.pnl.entity", "");
  const list: any[] = biz.data?.entities ?? [];
  const businesses = list.filter((e) => e.type !== "personal");
  const chosen = list.find((e) => e.slug === pick) ?? businesses[0] ?? list[0];
  const option = useCallback(
    (t: Theme) => {
      const ps: any[] = biz.data?.periods ?? [];
      return {
        grid: { left: 4, right: 10, top: 36, bottom: 0, containLabel: true },
        legend: { top: 0, left: 0, itemWidth: 10, itemHeight: 10, icon: "circle", textStyle: { color: t.muted } },
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: (v: number) => money(v) },
        xAxis: { type: "category", data: ps.map((p) => periodLabel(p.start, iv)), ...axis(t) },
        yAxis: valueAxis(t),
        series: businesses.map((e) => ({
          name: e.name,
          type: "bar",
          barMaxWidth: 22,
          itemStyle: { color: businessStyle(e.slug, e.color).color, borderRadius: 4 },
          data: e.income_series.map((v: number, i: number) => v - e.expense_series[i]),
        })),
      };
    },
    [biz.data],
  );
  if (biz.error) return <ErrorBox error={biz.error} />;
  if (!biz.data) return <Loading h={400} />;
  if (entities.length === 0) return <div class="empty">Add a business or personal profile first</div>;
  return (
    <div class="stack">
      <div class="biz-cards">
        {list.map((e) => (
          <button class={`card biz-card${chosen?.slug === e.slug ? " active" : ""}`} onClick={() => setPick(e.slug)}>
            <div class="row" style={{ gap: 9 }}>
              <span class="business-icon compact" style={businessStyle(e.slug, e.color)}>
                {e.type === "personal" ? "👤" : <Icon.folder />}
              </span>
              <strong class="biz-name">{e.name}</strong>
              {e.status === "archived" && <span class="pill zero">Archived</span>}
            </div>
            <div class={`biz-net num ${e.net_cents < 0 ? "neg" : ""}`}>{money(e.net_cents)}</div>
            <div class="muted small">{e.type === "personal" ? "Net cash flow" : "Net profit"} · {label}</div>
            <div class="biz-split">
              <span>
                <span class="muted">In</span> <span class="num in">{compact(e.income_cents)}</span>
              </span>
              <span>
                <span class="muted">Out</span> <span class="num">{compact(e.expenses_cents)}</span>
              </span>
              <span>
                <span class="muted">Margin</span> <span class="num">{pct(e.margin, 0)}</span>
              </span>
            </div>
          </button>
        ))}
      </div>
      {businesses.length > 0 && (
        <div class="card chart-card">
          <div class="card-head">
            <div>
              <h2>Net profit by business</h2>
              <div class="sub">{label}</div>
            </div>
          </div>
          <Chart option={option} class="chart" />
        </div>
      )}
      {chosen && <Statement entity={chosen.slug} from={from} to={to} label={label} range={range} />}
    </div>
  );
}

function Statement({ entity, from, to, label, range }: { entity: string; from: string | null; to: string | null; label: string; range: RangeKey }) {
  const [cols, setCols] = useStored<"total" | "month" | "quarter">("reports.pnl.cols", "total", ["total", "month", "quarter"]);
  const [showAll, setShowAll] = useState(false);
  const scope = useScope();
  const hidden = scope.q.exclude_categories;
  const { data, error } = useApi(`/reports/statement${qs({ entity, from, to, interval: cols, exclude_categories: hidden })}`, [entity, from, to, cols, hidden]);
  const [open, setOpen] = useState<Record<string, boolean>>({ income: true, cogs: true, expenses: true });
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading h={400} />;
  const periods: any[] = data.periods;
  const multi = data.interval !== "total";
  const form = FORM_NAME[data.entity.type] ?? "";
  const isBiz = data.entity.type !== "personal";
  const isCogs = (a: string) => a.startsWith("Expenses:CostOfGoodsSold");
  const lineNo = (l: string | null) => (l ? parseFloat(l) + (/[a-z]$/.test(l) ? (l.charCodeAt(l.length - 1) - 96) / 100 : 0) : 999);
  /** With "show all", add the form's lines that had no activity (as zero rows). */
  const withForm = (lines: any[], pick: (account: string) => boolean) => {
    if (!showAll || !isBiz) return lines;
    const have = new Set(lines.map((l) => l.account));
    const extra = (data.form_lines as any[]).filter((f) => pick(f.account) && !have.has(f.account)).map((f) => ({ account: f.account, line: f.line, values: periods.map(() => 0), total_cents: 0 }));
    return [...lines, ...extra].sort((a, b) => lineNo(a.line) - lineNo(b.line));
  };
  const income = withForm(data.income, (a) => a.startsWith("Income:"));
  const cogs = withForm(data.cost_of_goods, isCogs);
  const expenses = withForm(data.expenses, (a) => a.startsWith("Expenses:") && !isCogs(a));
  const t = data.totals;
  const Section = ({ id, title, lines, totals, total, sign }: { id: string; title: string; lines: any[]; totals: number[]; total: number; sign?: string }) => (
    <>
      <tr class="st-section" onClick={() => setOpen({ ...open, [id]: !open[id] })}>
        <td colSpan={2}>
          <span class={`st-caret${open[id] ? " open" : ""}`}>
            <Icon.chevron />
          </span>
          {title}
        </td>
        {multi && totals.map((v) => <td class="r num">{money(v)}</td>)}
        <td class="r num">{sign}{money(total)}</td>
      </tr>
      {open[id] &&
        lines.map((l) => (
          <tr class={`st-line${l.total_cents === 0 ? " zero" : ""}`} onClick={() => go(`/transactions?account=${encodeURIComponent(l.account)}`)}>
            <td class="st-indent" />
            <td>
              <span class="st-name">
                {l.line && <span class="st-lineno">Line {l.line}</span>}
                <CatName account={l.account} />
              </span>
            </td>
            {multi && l.values.map((v: number) => <td class="r num">{v ? money(v) : <span class="muted">–</span>}</td>)}
            <td class="r num">{money(l.total_cents)}</td>
          </tr>
        ))}
      {open[id] && lines.length === 0 && (
        <tr class="st-line zero">
          <td class="st-indent" />
          <td colSpan={multi ? periods.length + 2 : 2}>
            <span class="muted small">Nothing recorded</span>
          </td>
        </tr>
      )}
    </>
  );
  const exportCsv = () =>
    downloadCsv(`pnl-${data.entity.slug}-${data.from}-${data.to}.csv`, [
      ["section", "line", "category", ...(multi ? periods.map((p) => p.start) : []), "total"],
      ...income.map((l: any) => ["income", l.line ?? "", catLabel(l.account), ...(multi ? l.values.map(csvMoney) : []), csvMoney(l.total_cents)]),
      ...cogs.map((l: any) => ["cost of goods sold", l.line ?? "", catLabel(l.account), ...(multi ? l.values.map(csvMoney) : []), csvMoney(l.total_cents)]),
      ...expenses.map((l: any) => ["expenses", l.line ?? "", catLabel(l.account), ...(multi ? l.values.map(csvMoney) : []), csvMoney(l.total_cents)]),
      ["net", "", isBiz ? "Net profit" : "Net", ...(multi ? t.net.map(csvMoney) : []), csvMoney(t.net_total)],
    ]);
  return (
    <div class="card statement">
      <div class="card-head">
        <div>
          <div class="st-title">
            {data.entity.name} <span class="muted">{range === "all" ? "" : label}</span>
          </div>
          <div class="sub">
            {isBiz ? `${form} profit & loss` : "Income statement"} · {shortDate(data.from)} – {shortDate(data.to)}
          </div>
        </div>
        <div class="row wrap">
          <Seg value={cols} onChange={setCols} label="Columns" options={[["total", "Total"], ["quarter", "Quarterly"], ["month", "Monthly"]]} />
          <button class="btn sm" onClick={exportCsv}>
            <span class="tiny-ico"><Icon.download /></span> CSV
          </button>
        </div>
      </div>
      {hidden && <div class="filter-note">{scope.excludeCategories.length} hidden {scope.excludeCategories.length === 1 ? "category is" : "categories are"} left out of this statement. Use Filters to show them.</div>}
      {isBiz && (
        <label class="switch-row">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll((e.target as HTMLInputElement).checked)} />
          <span>Include {form} lines without activity</span>
        </label>
      )}
      <div class="st-scroll">
        <table class="table st-table">
          {multi && (
            <thead>
              <tr>
                <th colSpan={2} />
                {periods.map((p) => (
                  <th class="r">{periodLabel(p.start, data.interval)}</th>
                ))}
                <th class="r">Total</th>
              </tr>
            </thead>
          )}
          <tbody>
            <Section id="income" title={isBiz ? "Part I · Income" : "Income"} lines={income} totals={t.income} total={t.income_total} />
            {(cogs.length > 0 || t.cost_of_goods_total !== 0) && (
              <>
                <Section id="cogs" title="Cost of goods sold" lines={cogs} totals={t.cost_of_goods} total={t.cost_of_goods_total} />
                <tr class="st-total">
                  <td colSpan={2}>Gross profit</td>
                  {multi && t.gross_profit.map((v: number) => <td class="r num">{money(v)}</td>)}
                  <td class="r num">{money(t.gross_profit_total)}</td>
                </tr>
              </>
            )}
            <Section id="expenses" title={isBiz ? "Part II · Expenses" : "Expenses"} lines={expenses} totals={t.expenses} total={t.expenses_total} />
            <tr class="st-net">
              <td colSpan={2}>{isBiz ? "Net profit (or loss)" : "Net income"}</td>
              {multi && t.net.map((v: number) => <td class={`r num ${v < 0 ? "neg" : ""}`}>{money(v)}</td>)}
              <td class={`r num ${t.net_total < 0 ? "neg" : ""}`}>{money(t.net_total)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {isBiz && <div class="muted tiny" style={{ marginTop: 10 }}>For information only. Line numbers follow {form}; WMMA does not file taxes. Check with a tax professional.</div>}
    </div>
  );
}
