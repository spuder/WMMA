import { useCallback, useState } from "preact/hooks";
import { compact, money, monthShift, thisMonth, today, useApi } from "../api";
import { businessStyle, EntitySwitcher, go, useApp } from "../app";
import { Chart, type Theme } from "../components/chart";
import { axis, csvMoney, downloadCsv, type Interval, periodLabel, qs, Seg, Spark, useStored, valueAxis } from "../components/report-kit";
import { ErrorBox, Icon, Loading } from "../components/ui";

export type Span = "1m" | "3m" | "6m" | "ytd" | "1y" | "5y" | "all";
export const SPANS: Array<[Span, string]> = [
  ["1m", "1M"],
  ["3m", "3M"],
  ["6m", "6M"],
  ["ytd", "YTD"],
  ["1y", "1Y"],
  ["5y", "5Y"],
  ["all", "All"],
];
export function spanRange(s: Span): { from: string; interval: Interval; label: string } {
  const t = today();
  const back = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  switch (s) {
    case "1m":
      return { from: back(30), interval: "day", label: "1 month" };
    case "3m":
      return { from: back(91), interval: "week", label: "3 months" };
    case "6m":
      return { from: back(182), interval: "week", label: "6 months" };
    case "ytd":
      return { from: `${t.slice(0, 4)}-01-01`, interval: "week", label: "year to date" };
    case "1y":
      return { from: `${monthShift(thisMonth(), -12)}-01`, interval: "month", label: "1 year" };
    case "5y":
      return { from: `${monthShift(thisMonth(), -60)}-01`, interval: "month", label: "5 years" };
    case "all":
      return { from: "2000-01-01", interval: "month", label: "all time" };
  }
}

export const KIND_GROUPS: Array<{ kind: string; label: string; color: string; liability?: boolean }> = [
  { kind: "bank", label: "Cash", color: "var(--c0)" },
  { kind: "investment", label: "Investments", color: "var(--c6)" },
  { kind: "real_estate", label: "Real estate", color: "var(--c4)" },
  { kind: "vehicle", label: "Vehicles", color: "var(--c3)" },
  { kind: "other_asset", label: "Other assets", color: "var(--c7)" },
  { kind: "credit", label: "Credit cards", color: "var(--c5)", liability: true },
  { kind: "loan", label: "Loans", color: "var(--c2)", liability: true },
];

export interface AccountSeries {
  account: string;
  slug: string | null;
  name: string;
  kind: string;
  entity: string | null;
  status: string;
  liability: boolean;
  balance_cents: number[];
  flow_cents: number[];
  valuation_cents: number[];
}

/** Drop leading periods where nothing had a balance yet (for "All"). */
export function trimLeading<T extends { periods: any[]; accounts: AccountSeries[]; net_worth_cents: number[] }>(d: T): T {
  let k = 0;
  while (k < d.periods.length - 2 && d.accounts.every((a) => a.balance_cents[k] === 0)) k++;
  if (k === 0) return d;
  const cut = <X,>(xs: X[]) => xs.slice(k);
  return { ...d, periods: cut(d.periods), net_worth_cents: cut(d.net_worth_cents), accounts: d.accounts.map((a) => ({ ...a, balance_cents: cut(a.balance_cents), flow_cents: cut(a.flow_cents), valuation_cents: cut(a.valuation_cents) })) };
}

const Change = ({ now, then, invert }: { now: number; then: number; invert?: boolean | undefined }) => {
  const d = now - then;
  const good = invert ? d <= 0 : d >= 0;
  const p = then !== 0 ? (d / Math.abs(then)) * 100 : null;
  if (d === 0) return <span class="chg muted">$0.00</span>;
  return (
    <span class={`chg ${good ? "in" : "neg"}`}>
      {d > 0 ? "↗" : "↘"} {money(Math.abs(d))}
      {p !== null && ` (${Math.abs(p).toFixed(1)}%)`}
    </span>
  );
};

export function NetWorth() {
  const { entity, entities } = useApp();
  const [span, setSpan] = useStored<Span>("networth.span", "1y", SPANS.map(([k]) => k));
  const [chart, setChart] = useStored<"net" | "stack">("networth.chart", "net", ["net", "stack"]);
  const [mode, setMode] = useState<"totals" | "percent">("totals");
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const r = spanRange(span);
  const { data: raw, error } = useApi(`/reports/balances${qs({ from: r.from, interval: r.interval, entity })}`, [entity, span]);
  const data = raw ? (span === "all" ? trimLeading(raw) : raw) : null;
  const option = useCallback(
    (t: Theme) => {
      if (!data) return {};
      const labels = data.periods.map((p: any) => (r.interval === "month" ? `${periodLabel(p.start, "month")} '${p.start.slice(2, 4)}` : periodLabel(p.start, r.interval)));
      if (chart === "stack") {
        return {
          grid: { left: 4, right: 10, top: 36, bottom: 0, containLabel: true },
          legend: { top: 0, left: 0, itemWidth: 10, itemHeight: 10, icon: "circle", textStyle: { color: t.muted } },
          tooltip: { trigger: "axis", valueFormatter: (v: number) => money(v) },
          xAxis: { type: "category", boundaryGap: false, data: labels, ...axis(t) },
          yAxis: valueAxis(t),
          series: KIND_GROUPS.map((g, i) => ({
            name: g.label,
            type: "line",
            stack: g.liability ? "l" : "a",
            symbol: "none",
            lineStyle: { width: 0 },
            areaStyle: { opacity: 0.75 },
            color: t.palette[[0, 6, 4, 3, 7, 5, 2][i]!],
            data: data.periods.map((_: any, k: number) => data.accounts.filter((a: AccountSeries) => a.kind === g.kind).reduce((s: number, a: AccountSeries) => s + a.balance_cents[k]!, 0)),
          })).filter((s) => s.data.some((v: number) => v !== 0)),
        };
      }
      return {
        grid: { left: 4, right: 10, top: 12, bottom: 0, containLabel: true },
        tooltip: { trigger: "axis", valueFormatter: (v: number) => money(v) },
        xAxis: { type: "category", boundaryGap: false, data: labels, ...axis(t) },
        yAxis: { ...valueAxis(t), scale: true },
        series: [
          {
            name: "Net worth",
            type: "line",
            smooth: 0.25,
            symbol: "none",
            lineStyle: { width: 2.6, color: t.palette[1] },
            areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: `${t.palette[1]}44` }, { offset: 1, color: `${t.palette[1]}05` }] } },
            data: data.net_worth_cents,
          },
        ],
      };
    },
    [data, chart],
  );
  if (error) return <ErrorBox error={error} />;
  const accounts: AccountSeries[] = data?.accounts ?? [];
  const last = (a: AccountSeries) => a.balance_cents.at(-1) ?? 0;
  const first = (a: AccountSeries) => a.balance_cents[0] ?? 0;
  const nw = data?.net_worth_cents.at(-1) ?? 0;
  const nw0 = data?.net_worth_cents[0] ?? 0;
  const groups = KIND_GROUPS.map((g) => ({ ...g, accounts: accounts.filter((a) => a.kind === g.kind) })).filter((g) => g.accounts.length > 0);
  const totalOf = (g: (typeof groups)[number], f: (a: AccountSeries) => number) => g.accounts.reduce((s, a) => s + f(a), 0) * (g.liability ? -1 : 1);
  const assets = groups.filter((g) => !g.liability);
  const liabilities = groups.filter((g) => g.liability);
  const assetTotal = assets.reduce((s, g) => s + totalOf(g, last), 0);
  const liabTotal = liabilities.reduce((s, g) => s + totalOf(g, last), 0);
  const ent = (slug: string | null) => entities.find((e) => e.slug === slug);
  return (
    <div class="stack">
      <div class="topbar">
        <h1>Net Worth</h1>
        <div class="toolbar">
          <EntitySwitcher />
        </div>
      </div>
      <div class="card chart-card">
        <div class="card-head">
          <div>
            <div class="upper">Net worth</div>
            <div class="row wrap" style={{ gap: 12 }}>
              <span class="hero-num num">{data ? money(nw) : "—"}</span>
              {data && (
                <span class="small">
                  <Change now={nw} then={nw0} /> <span class="muted">{r.label} change</span>
                </span>
              )}
            </div>
          </div>
          <div class="row wrap">
            <Seg value={chart} onChange={setChart} label="Chart" options={[["net", "Net worth"], ["stack", "By type"]]} />
            <Seg value={span} onChange={setSpan} label="Timeframe" options={SPANS} />
          </div>
        </div>
        {data ? <Chart option={option} class="chart tall" /> : <Loading h={380} />}
      </div>
      {data && (
        <div class="grid">
          <div class="span-8 stack">
            {groups.length === 0 && <div class="card empty">No account balances yet. Add accounts and import transactions to see your net worth.</div>}
            {groups.map((g) => {
              const now = totalOf(g, last);
              const then = totalOf(g, first);
              return (
                <div class="card acct-group">
                  <button class="acct-group-head" onClick={() => setClosed({ ...closed, [g.kind]: !closed[g.kind] })} aria-expanded={!closed[g.kind]}>
                    <span class={`st-caret${closed[g.kind] ? "" : " open"}`}>
                      <Icon.chevron />
                    </span>
                    <strong>{g.label}</strong>
                    <span class="small hide-sm">
                      <Change now={now} then={then} invert={g.liability} /> <span class="muted">{r.label} change</span>
                    </span>
                    <span class="num acct-group-total">{money(now)}</span>
                  </button>
                  {!closed[g.kind] &&
                    g.accounts
                      .sort((a, b) => Math.abs(last(b)) - Math.abs(last(a)))
                      .map((a) => {
                        const e = ent(a.entity);
                        const sign = a.liability ? -1 : 1;
                        return (
                          <button class="acct-row" onClick={() => go(`/transactions?account=${encodeURIComponent(a.account)}`)}>
                            <span class="acct-name">
                              <strong>{a.name}</strong>
                              <span class="meta">
                                {a.status === "closed" ? "Closed · " : ""}
                                {e ? (
                                  <span class="business-tag" style={businessStyle(e.slug, e.color)}>
                                    {e.name}
                                  </span>
                                ) : (
                                  <span class="muted">{a.account}</span>
                                )}
                              </span>
                            </span>
                            <span class="hide-sm acct-spark">
                              <Spark values={a.balance_cents.map((v) => v * sign)} tone={a.liability ? (last(a) * sign <= first(a) * sign ? "in" : "out") : undefined} />
                            </span>
                            <span class="acct-bal">
                              <span class="num">{money(last(a) * sign)}</span>
                              <Change now={last(a) * sign} then={first(a) * sign} invert={a.liability} />
                            </span>
                          </button>
                        );
                      })}
                </div>
              );
            })}
          </div>
          <div class="span-4">
            <div class="card summary">
              <div class="summary-head">
                <h2>Summary</h2>
                <Seg value={mode} onChange={setMode} label="Show" options={[["totals", "Totals"], ["percent", "Percent"]]} />
              </div>
              {[
                ["Assets", assets, assetTotal],
                ["Liabilities", liabilities, liabTotal],
              ].map(([title, gs, total]) => (
                <div class="nw-block">
                  <div class="spread">
                    <strong>{title as string}</strong>
                    <span class="num muted">{money(total as number)}</span>
                  </div>
                  <div class="stackbar">
                    {(gs as typeof groups).map((g) => (
                      <span style={{ width: `${(total as number) > 0 ? (totalOf(g, last) / (total as number)) * 100 : 0}%`, background: g.color }} title={g.label} />
                    ))}
                    {(gs as typeof groups).length === 0 && <span style={{ width: "100%", background: "var(--surface-3)" }} />}
                  </div>
                  {(gs as typeof groups).map((g) => (
                    <div class="spread nw-line">
                      <span class="row" style={{ gap: 8 }}>
                        <span class="legend-dot" style={{ background: g.color }} />
                        {g.label}
                      </span>
                      <span class="num">{mode === "totals" ? money(totalOf(g, last)) : `${(total as number) ? ((totalOf(g, last) / (total as number)) * 100).toFixed(1) : 0}%`}</span>
                    </div>
                  ))}
                  {(gs as typeof groups).length === 0 && <div class="muted small">None</div>}
                </div>
              ))}
              <div class="summary-foot">
                <button
                  class="linkbtn"
                  onClick={() =>
                    downloadCsv(`net-worth-${today()}.csv`, [
                      ["period_end", "net_worth", ...accounts.map((a) => a.name)],
                      ...data.periods.map((p: any, k: number) => [p.end, csvMoney(data.net_worth_cents[k]), ...accounts.map((a) => csvMoney(a.balance_cents[k]!))]),
                    ])
                  }
                >
                  Download CSV
                </button>
              </div>
            </div>
            <div class="muted tiny" style={{ marginTop: 10 }}>
              Liabilities are shown as amounts owed. {compact(assetTotal)} assets − {compact(liabTotal)} liabilities.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
