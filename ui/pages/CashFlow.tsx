import { useEffect, useState } from "preact/hooks";
import { money, monthShift, thisMonth, useApi } from "../api";
import { EntitySwitcher, useApp } from "../app";
import { BarList, BY_OPTIONS, type By, FlowBars, Kpis, openSlice, pct, periodLabel, qs, Seg, slices, useStored } from "../components/report-kit";
import { ErrorBox, Loading } from "../components/ui";

type Iv = "month" | "quarter" | "year";
const SPAN: Record<Iv, number> = { month: 19, quarter: 60, year: 120 }; // months of history shown

/** Monarch-style cash flow: history of income vs expenses; click a period to break it down. */
export function CashFlow() {
  const { entity } = useApp();
  const [iv, setIv] = useStored<Iv>("cashflow.interval", "month", ["month", "quarter", "year"]);
  const from = `${monthShift(thisMonth(), -(SPAN[iv] - 1))}-01`;
  const se = useApi(`/reports/series${qs({ from, entity, interval: iv })}`, [entity, iv]);
  const periods: any[] = se.data?.periods ?? [];
  const [sel, setSel] = useState<number | null>(null);
  useEffect(() => setSel(null), [iv, entity]);
  const idx = sel ?? Math.max(0, periods.length - 1);
  const p = periods[idx];
  return (
    <div class="stack">
      <div class="topbar">
        <h1>Cash Flow</h1>
        <div class="toolbar">
          <Seg value={iv} onChange={setIv} label="Interval" options={[["month", "Monthly"], ["quarter", "Quarterly"], ["year", "Yearly"]]} />
          <EntitySwitcher />
        </div>
      </div>
      {se.error && <ErrorBox error={se.error} />}
      <div class="card chart-card">{se.data ? <FlowBars periods={periods} interval={iv} selected={idx} onSelect={setSel} /> : <Loading h={380} />}</div>
      {p && <Period start={p.start} end={p.end} label={periodLabel(p.start, iv, true)} />}
    </div>
  );
}

function Period({ start, end, label }: { start: string; end: string; label: string }) {
  const { entity } = useApp();
  const { data, error } = useApi(`/reports/overview${qs({ from: start, to: end, entity })}`, [entity, start, end]);
  const [byIn, setByIn] = useStored<By>("cashflow.by.in", "category", ["category", "group", "merchant"]);
  const [byOut, setByOut] = useStored<By>("cashflow.by.out", "category", ["category", "group", "merchant"]);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading h={400} />;
  return (
    <>
      <h2 class="period-title">{label}</h2>
      <Kpis
        items={[
          { label: "Income", value: money(data.income.total_cents), tone: "in" },
          { label: "Expenses", value: money(data.expenses.total_cents), tone: "neg" },
          { label: "Total savings", value: money(data.net_cents), tone: data.net_cents < 0 ? "neg" : "" },
          { label: "Savings rate", value: pct(data.savings_rate, 0) },
        ]}
      />
      <div class="card">
        <div class="card-head">
          <h2>Income</h2>
          <Seg value={byIn} onChange={setByIn} label="Income by" options={BY_OPTIONS} />
        </div>
        <BarList items={slices(data.income, byIn)} tone="in" onPick={openSlice} />
      </div>
      <div class="card">
        <div class="card-head">
          <h2>Expenses</h2>
          <Seg value={byOut} onChange={setByOut} label="Expenses by" options={BY_OPTIONS} />
        </div>
        <BarList items={slices(data.expenses, byOut)} tone="out" onPick={openSlice} limit={15} />
      </div>
    </>
  );
}
