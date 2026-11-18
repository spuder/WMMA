import { useCallback } from "preact/hooks";
import { money, useApi } from "../api";
import { businessStyle, EntitySwitcher, go, useApp } from "../app";
import { Chart, type Theme } from "../components/chart";
import { axis, Donut, Kpis, periodLabel, qs, Seg, signed, type Slice, Spark, useStored, valueAxis } from "../components/report-kit";
import { ErrorBox, Loading } from "../components/ui";
import { type AccountSeries, type Span, SPANS, spanRange, trimLeading } from "./NetWorth";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * Per account: where its history starts within the timeframe (the first period
 * with a balance), the value it started at, and money put in after that. An
 * account opened mid-timeframe starts at its first balance, so its opening
 * value is not counted as a gain.
 */
export function perf(a: AccountSeries) {
  let s = a.balance_cents.findIndex((v) => v !== 0);
  if (s < 0) s = 0;
  const startValue = a.balance_cents[s] ?? 0;
  const contributed = sum(a.flow_cents.slice(s + 1));
  const value = a.balance_cents.at(-1) ?? 0;
  const invested = a.balance_cents.map((_, k) => (k < s ? 0 : startValue + sum(a.flow_cents.slice(s + 1, k + 1))));
  return { start: s, startValue, contributed, value, gain: value - startValue - contributed, invested };
}

export function Investments() {
  const { entity, entities } = useApp();
  const [span, setSpan] = useStored<Span>("investments.span", "1y", SPANS.map(([k]) => k));
  const r = spanRange(span);
  const { data: raw, error } = useApi(`/reports/balances${qs({ from: r.from, interval: r.interval, entity })}`, [entity, span]);
  const all = raw ? (span === "all" ? trimLeading(raw) : raw) : null;
  const accounts: AccountSeries[] = (all?.accounts ?? []).filter((a: AccountSeries) => a.kind === "investment");
  const periods: any[] = all?.periods ?? [];
  const value = periods.map((_, k) => sum(accounts.map((a) => a.balance_cents[k]!)));
  const perfs = accounts.map(perf);
  // Starting value plus money put in since, per period.
  const invested = periods.map((_, k) => sum(perfs.map((p) => p.invested[k]!)));
  const option = useCallback(
    (t: Theme) => ({
      grid: { left: 4, right: 10, top: 36, bottom: 0, containLabel: true },
      legend: { top: 0, left: 0, itemWidth: 10, itemHeight: 10, icon: "circle", textStyle: { color: t.muted } },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => money(v) },
      xAxis: { type: "category", boundaryGap: false, data: periods.map((p) => (r.interval === "month" ? `${periodLabel(p.start, "month")} '${p.start.slice(2, 4)}` : periodLabel(p.start, r.interval))), ...axis(t) },
      yAxis: { ...valueAxis(t), scale: true },
      series: [
        {
          name: "Value",
          type: "line",
          smooth: 0.25,
          symbol: "none",
          lineStyle: { width: 2.6, color: t.palette[6] },
          areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: `${t.palette[6]}44` }, { offset: 1, color: `${t.palette[6]}05` }] } },
          data: value,
        },
        { name: "Invested", type: "line", step: "end", symbol: "none", lineStyle: { width: 1.6, type: "dashed", color: t.muted }, data: invested },
      ],
    }),
    [all],
  );
  if (error) return <ErrorBox error={error} />;
  const now = value.at(-1) ?? 0;
  const start = value[0] ?? 0;
  const opening = sum(perfs.map((p) => p.startValue));
  const contributed = sum(perfs.map((p) => p.contributed));
  const gain = sum(perfs.map((p) => p.gain));
  const base = opening + Math.max(0, contributed) / 2;
  const ret = base > 0 ? (gain / base) * 100 : null;
  const ent = (slug: string | null) => entities.find((e) => e.slug === slug);
  const slicesOf: Slice[] = accounts.filter((a) => (a.balance_cents.at(-1) ?? 0) > 0).sort((a, b) => b.balance_cents.at(-1)! - a.balance_cents.at(-1)!).map((a) => ({ key: a.account, text: a.name, cents: a.balance_cents.at(-1)!, label: a.name }));
  return (
    <div class="stack">
      <div class="topbar">
        <h1>Investments</h1>
        <div class="toolbar">
          <Seg value={span} onChange={setSpan} label="Timeframe" options={SPANS} />
          <EntitySwitcher />
        </div>
      </div>
      {!all ? (
        <Loading h={420} />
      ) : accounts.length === 0 ? (
        <div class="card empty">
          No investment accounts yet. Add a brokerage, 401(k) or IRA under <a href="#/accounts">Accounts</a>, then record its value or connect it with SimpleFIN.
        </div>
      ) : (
        <>
          <Kpis
            items={[
              { label: "Total value", value: money(now) },
              { label: `Change · ${r.label}`, value: signed(now - start), tone: now - start < 0 ? "neg" : "in" },
              { label: "Net contributions", value: signed(contributed) },
              { label: `Market gain${ret === null ? "" : ` · ${ret >= 0 ? "+" : ""}${ret.toFixed(1)}%`}`, value: signed(gain), tone: gain < 0 ? "neg" : "in" },
            ]}
          />
          <div class="card chart-card">
            <div class="card-head">
              <div>
                <h2>Performance</h2>
                <div class="sub">Value against money put in. Gains are value changes not explained by contributions (valuation updates, dividends kept in the account).</div>
              </div>
            </div>
            <Chart option={option} class="chart tall" />
          </div>
          <div class="grid">
            <div class="card span-8" style={{ paddingTop: 6 }}>
              <div class="inv-head hide-sm">
                <span>Account</span>
                <span />
                <span class="r">Contributed</span>
                <span class="r">Gain</span>
                <span class="r">Value</span>
              </div>
              {accounts
                .sort((a, b) => (b.balance_cents.at(-1) ?? 0) - (a.balance_cents.at(-1) ?? 0))
                .map((a) => {
                  const { value: v, contributed: c, gain: g } = perf(a);
                  const e = ent(a.entity);
                  return (
                    <button class="inv-row" onClick={() => go(`/transactions?account=${encodeURIComponent(a.account)}`)}>
                      <span class="acct-name">
                        <strong>{a.name}</strong>
                        <span class="meta">
                          {e ? (
                            <span class="business-tag" style={businessStyle(e.slug, e.color)}>
                              {e.name}
                            </span>
                          ) : (
                            a.account
                          )}
                        </span>
                      </span>
                      <span class="hide-sm acct-spark">
                        <Spark values={a.balance_cents} />
                      </span>
                      <span class="r num muted hide-sm">{signed(c)}</span>
                      <span class={`r num hide-sm ${g < 0 ? "neg" : "in"}`}>{signed(g)}</span>
                      <span class="r num">
                        <strong>{money(v)}</strong>
                        <span class={`hide-lg small ${g < 0 ? "neg" : "in"}`} style={{ display: "block" }}>
                          {signed(g)}
                        </span>
                      </span>
                    </button>
                  );
                })}
            </div>
            <div class="card span-4">
              <h2>Allocation</h2>
              <Donut items={slicesOf} total={now} label="By account" />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
