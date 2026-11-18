import { useEffect, useState } from "preact/hooks";
import { money, monthEnd, monthShift, thisMonth, useApi } from "../api";
import { BarList, ByMenu, type By, FlowBars, FlowSankey, Kpis, openSlice, pct, periodLabel, qs, Seg, slices, useStored, ReportFilters, useScope } from "../components/report-kit";
import { ErrorBox, Icon, Loading } from "../components/ui";

type Iv = "month" | "quarter" | "year";
const SPAN: Record<Iv, number> = { month: 19, quarter: 60, year: 120 }; // months of history shown
const STEP: Record<Iv, number> = { month: 12, quarter: 36, year: 60 }; // months the arrows move

/** Monarch-style cash flow: history of income vs expenses; click a period to break it down. */
export function CashFlow() {
  const scope = useScope();
  const [iv, setIv] = useStored<Iv>("cashflow.interval", "month", ["month", "quarter", "year"]);
  const [back, setBack] = useState(0); // pages of history scrolled back
  const endMonth = monthShift(thisMonth(), -back * STEP[iv]);
  const from = `${monthShift(endMonth, -(SPAN[iv] - 1))}-01`;
  const to = back === 0 ? null : monthEnd(endMonth);
  const se = useApi(`/reports/series${qs({ from, to, ...scope.q, interval: iv })}`, [scope.key, iv, back]);
  const periods: any[] = se.data?.periods ?? [];
  const [sel, setSel] = useState<number | null>(null);
  useEffect(() => setSel(null), [iv, scope.key, back]);
  useEffect(() => setBack(0), [iv]);
  const empty = periods.length > 0 && periods.every((p) => p.income_cents === 0 && p.expenses_cents === 0);
  const idx = sel ?? Math.max(0, periods.length - 1);
  const p = periods[idx];
  return (
    <div class="stack">
      <div class="topbar">
        <h1>Cash Flow</h1>
        <div class="toolbar">
          <Seg value={iv} onChange={setIv} label="Interval" options={[["month", "Monthly"], ["quarter", "Quarterly"], ["year", "Yearly"]]} />
          <ReportFilters />
        </div>
      </div>
      {se.error && <ErrorBox error={se.error} />}
      <div class="card chart-card cf-chart">
        <button class="icon-btn cf-arrow left" onClick={() => setBack(back + 1)} disabled={empty} aria-label="Earlier">
          <span class="flip"><Icon.chevron /></span>
        </button>
        <button class="icon-btn cf-arrow right" onClick={() => setBack(Math.max(0, back - 1))} disabled={back === 0} aria-label="Later">
          <Icon.chevron />
        </button>
        {se.data ? <FlowBars periods={periods} interval={iv} selected={idx} onSelect={setSel} /> : <Loading h={380} />}
        <div class="muted tiny cf-hint">Click a bar to see that {iv === "month" ? "month" : iv === "quarter" ? "quarter" : "year"}.</div>
      </div>
      {p && <Period start={p.start} end={p.end} label={periodLabel(p.start, iv, true)} />}
    </div>
  );
}

function Period({ start, end, label }: { start: string; end: string; label: string }) {
  const scope = useScope();
  const { data, error } = useApi(`/reports/overview${qs({ from: start, to: end, ...scope.q })}`, [scope.key, start, end]);
  const [byIn, setByIn] = useStored<By>("cashflow.by.in", "category", ["category", "group", "merchant"]);
  const [byOut, setByOut] = useStored<By>("cashflow.by.out", "category", ["category", "group", "merchant"]);
  const [view, setView] = useStored<"bars" | "sankey">("cashflow.view", "bars", ["bars", "sankey"]);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading h={400} />;
  return (
    <>
      <div class="spread wrap">
        <h2 class="period-title">{label}</h2>
        <Seg value={view} onChange={setView} label="View" options={[["bars", "Breakdown"], ["sankey", "Sankey"]]} />
      </div>
      <Kpis
        items={[
          { label: "Income", value: money(data.income.total_cents), tone: "in" },
          { label: "Expenses", value: money(data.expenses.total_cents), tone: "neg" },
          { label: "Total savings", value: money(data.net_cents), tone: data.net_cents < 0 ? "neg" : "" },
          { label: "Savings rate", value: pct(data.savings_rate, 0) },
        ]}
      />
      {view === "sankey" ? (
        <div class="card chart-card">
          <FlowSankey from={start} to={end} />
        </div>
      ) : (
        <>
      <div class="card">
        <div class="card-head">
          <h2>Income</h2>
          <ByMenu value={byIn} onChange={setByIn} />
        </div>
        <BarList items={slices(data.income, byIn)} tone="in" onPick={openSlice} />
      </div>
      <div class="card">
        <div class="card-head">
          <h2>Expenses</h2>
          <ByMenu value={byOut} onChange={setByOut} />
        </div>
        <BarList items={slices(data.expenses, byOut)} tone="out" onPick={openSlice} limit={15} />
      </div>
        </>
      )}
    </>
  );
}
