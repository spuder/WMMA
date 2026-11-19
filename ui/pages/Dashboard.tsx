import { useCallback, useState } from "preact/hooks";
import { catEmoji, compact, leaf, money, monthEnd, monthName, monthShift, monthStart, thisMonth, useApi } from "../api";
import { Chart, type Theme } from "../components/chart";
import { CatName, ErrorBox, Icon, Loading } from "../components/ui";
import { EntitySwitcher, go, useApp } from "../app";
import { TxnList, type Txn } from "./Transactions";

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};

export function Dashboard() {
  const { entity, reviewCount, userName } = useApp();
  const [edited, setEdited] = useState<Record<string, Txn>>({});
  const accounts = useApi<{ accounts: any[] }>("/accounts");
  const m = thisMonth();
  const eq = entity ? `&entity=${encodeURIComponent(entity)}` : "";
  const nw = useApi(`/reports/networth?from=${monthShift(m, -11)}&to=${m}`, []);
  const pnl = useApi(`/reports/pnl?from=${monthStart(m)}&to=${monthEnd(m)}${eq}`, [entity]);
  const spend = useApi(`/reports/spending?from=${monthStart(m)}&to=${monthEnd(m)}&depth=2${eq}`, [entity]);
  const trend = useApi(`/reports/trend?from=${monthShift(m, -5)}&to=${m}${eq}`, [entity]);
  const recent = useApi(`/transactions?limit=8${eq}`, [entity]);

  const series: Array<{ month: string; v: number }> = (nw.data?.series ?? []).map((s: any) => ({ month: s.month, v: entity ? (s.by_entity_cents[entity] ?? 0) : s.net_worth_cents }));
  const last = series.at(-1)?.v ?? 0;
  const prev = series.at(-2)?.v ?? 0;
  const delta = last - prev;

  const spark = useCallback(
    (t: Theme) => ({
      grid: { left: 0, right: 0, top: 8, bottom: 0 },
      xAxis: { type: "category", show: false, data: series.map((s) => s.month), boundaryGap: false },
      yAxis: { type: "value", show: false, scale: true },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => money(v, true) },
      series: [
        {
          type: "line",
          data: series.map((s) => s.v),
          smooth: 0.35,
          symbol: "none",
          lineStyle: { width: 2, color: t.in },
          areaStyle: {
            color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: `${t.in}40` }, { offset: 1, color: `${t.in}00` }] },
          },
        },
      ],
    }),
    [nw.data, entity],
  );

  const cats: Array<{ account: string; amount_cents: number; share: number }> = spend.data?.categories ?? [];
  const donut = useCallback(
    (t: Theme) => ({
      tooltip: { trigger: "item", valueFormatter: (v: number) => money(v) },
      series: [
        {
          type: "pie",
          radius: ["62%", "88%"],
          padAngle: 2,
          itemStyle: { borderRadius: 4, borderColor: t.surface, borderWidth: 2 },
          label: { show: false },
          data: cats.slice(0, 8).map((c) => ({ name: `${catEmoji(c.account)} ${leaf(c.account)}`, value: c.amount_cents })),
        },
      ],
    }),
    [spend.data],
  );

  const months: any[] = trend.data?.months ?? [];
  const bars = useCallback(
    (t: Theme) => ({
      grid: { left: 4, right: 4, top: 24, bottom: 0, containLabel: true },
      legend: { top: 0, right: 0, icon: "circle", itemWidth: 8, itemHeight: 8, textStyle: { color: t.muted } },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => money(v, true) },
      xAxis: { type: "category", data: months.map((x) => monthName(x.month)), axisLine: { lineStyle: { color: t.line } }, axisTick: { show: false }, axisLabel: { color: t.muted } },
      yAxis: { type: "value", splitLine: { lineStyle: { color: t.line } }, axisLabel: { color: t.muted, formatter: (v: number) => compact(v) } },
      series: [
        { name: "Income", type: "bar", data: months.map((x) => x.income_cents), itemStyle: { color: t.in, borderRadius: [4, 4, 0, 0] }, barMaxWidth: 16 },
        { name: "Spending", type: "bar", data: months.map((x) => x.expenses_cents), itemStyle: { color: t.out, borderRadius: [4, 4, 0, 0] }, barMaxWidth: 16 },
      ],
    }),
    [trend.data],
  );

  const income = pnl.data ? pnl.data.income.reduce((a: number, l: any) => a + l.amount_cents, 0) : null;
  const spending = pnl.data ? pnl.data.expenses.reduce((a: number, l: any) => a + l.amount_cents, 0) : null;
  const net: number | null = pnl.data?.net_cents ?? null;
  const spentShare = income && spending !== null ? Math.min(100, Math.round((spending / income) * 100)) : spending ? 100 : 0;
  const firstName = userName?.trim().split(/\s+/)[0];

  return (
    <div class="stack">
      <div class="topbar">
        <h1>Dashboard</h1>
        <EntitySwitcher />
      </div>

      <div class="greeting">
        <h2>
          {greeting()}
          {firstName ? `, ${firstName}` : ""}!
        </h2>
        <div class="muted">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</div>
      </div>

      {nw.error && <ErrorBox error={nw.error} />}
      {accounts.error && <ErrorBox error={accounts.error} />}

      {!accounts.loading && !accounts.error && accounts.data?.accounts.length === 0 && (
        <section class="card onboarding span-12">
          <div class="upper">Get started</div>
          <h2>Bring your finances into WMMA</h2>
          <p class="sub">Add an account or import a statement to start seeing balances, spending, and reports here.</p>
          <div class="row onboarding-actions">
            <a class="btn primary" href="#/accounts">Add an account</a>
            <a class="btn" href="#/imports">Import transactions</a>
          </div>
        </section>
      )}

      <div class="grid">
        <div class="card hero span-7">
          <div class="card-hd">
            <h2>Net worth</h2>
            <a class="card-link" href="#/networth">
              View all <Icon.chevron />
            </a>
          </div>
          {nw.loading ? (
            <Loading h={44} />
          ) : (
            <div class="row wrap" style={{ alignItems: "baseline", columnGap: 12, rowGap: 0 }}>
              <div class="big num">{money(last, true)}</div>
              <span class={`delta ${delta >= 0 ? "up" : "down"}`}>
                {delta >= 0 ? "↑" : "↓"} {money(Math.abs(delta), true)} <span style={{ fontWeight: 500, opacity: 0.8 }}>this month</span>
              </span>
            </div>
          )}
          <Chart option={spark} class="chart" />
        </div>

        <div class="span-5 stack">
          <div class="card flow-card">
            <div class="card-hd">
              <h2>This month</h2>
              <a class="card-link" href="#/cashflow">
                Cash flow <Icon.chevron />
              </a>
            </div>
            {pnl.loading ? (
              <Loading h={120} />
            ) : (
              <>
                <div class="flow-stats">
                  <div>
                    <div class="label">Income</div>
                    <div class="value num in">{money(income ?? 0, true)}</div>
                  </div>
                  <div>
                    <div class="label">Spending</div>
                    <div class="value num">{money(spending ?? 0, true)}</div>
                  </div>
                </div>
                <div class="flow-bar" role="img" aria-label={`Spent ${spentShare}% of income`}>
                  <span style={{ width: `${spentShare}%` }} />
                </div>
                <div class="spread flow-left">
                  <span class="muted">{net !== null && net < 0 ? "Overspent" : "Left over"}</span>
                  <strong class={`num ${net !== null && net < 0 ? "neg" : "in"}`}>{money(Math.abs(net ?? 0), true)}</strong>
                </div>
              </>
            )}
          </div>
          {reviewCount > 0 && (
            <button class="card review-cta" onClick={() => go("/review")}>
              <span class="review-cta-icon">
                <Icon.swipe />
              </span>
              <span class="review-cta-text">
                <strong>
                  {reviewCount} {reviewCount === 1 ? "transaction" : "transactions"} to review
                </strong>
                <span class="muted small">Swipe to categorize</span>
              </span>
              <span class="btn primary sm">Review</span>
            </button>
          )}
        </div>

        <div class="card span-5">
          <div class="card-hd">
            <h2>Spending</h2>
            <a class="card-link" href="#/reports?tab=spending">
              View all <Icon.chevron />
            </a>
          </div>
          {spend.loading ? (
            <Loading h={200} />
          ) : cats.length === 0 ? (
            <div class="empty">No spending yet this month</div>
          ) : (
            <div class="row" style={{ alignItems: "center", gap: 10 }}>
              <div style={{ position: "relative", width: "46%", flex: "none" }}>
                <Chart option={donut} class="chart" />
                <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none", textAlign: "center" }}>
                  <div>
                    <div class="muted tiny">Total</div>
                    <div class="num" style={{ fontWeight: 600, fontSize: 18 }}>{compact(cats.reduce((a, c) => a + c.amount_cents, 0))}</div>
                  </div>
                </div>
              </div>
              <div class="list" style={{ flex: 1, minWidth: 0 }}>
                {cats.slice(0, 5).map((c, i) => (
                  <div class="spread small" style={{ padding: "6px 0" }}>
                    <span class="row" style={{ gap: 8, minWidth: 0 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 4, flex: "none", background: `var(--c${i})` }} />
                      <CatName account={c.account} label={leaf(c.account)} />
                    </span>
                    <span class="num muted">{c.share}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div class="card span-7">
          <div class="card-hd">
            <h2>Income vs spending</h2>
            <span class="muted small">Last 6 months</span>
          </div>
          {trend.loading ? <Loading h={220} /> : <Chart option={bars} class="chart" />}
        </div>

        <div class="card flush span-12">
          <div class="card-hd">
            <h2>Recent transactions</h2>
            <a class="card-link" href="#/transactions">
              All transactions <Icon.chevron />
            </a>
          </div>
          {recent.loading ? (
            <div style={{ padding: 18 }}>
              <Loading h={200} />
            </div>
          ) : (recent.data?.transactions ?? []).length === 0 ? (
            <div class="empty">No transactions yet. <a href="#/imports">Import a bank statement</a> to see activity here.</div>
          ) : (
            <TxnList
              rows={(recent.data.transactions as Txn[]).map((t) => edited[t.wmma_id] ?? t)}
              accounts={accounts.data?.accounts ?? []}
              onOpen={(t) => go(`/transactions?id=${t.wmma_id}`)}
              onChanged={(t) => setEdited((e) => ({ ...e, [t.wmma_id]: t }))}
              onFilterAccount={(a) => go(a ? `/transactions?account=${encodeURIComponent(a)}` : "/transactions")}
            />
          )}
        </div>
      </div>
    </div>
  );
}
