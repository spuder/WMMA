import { useCallback, useMemo, useState } from "preact/hooks";
import { compact, money, monthShift, store, thisMonth, useApi } from "../api";
import { Chart, type Theme } from "../components/chart";
import { axis, Kpis, qs, Seg, valueAxis, BusinessFilter, useScope } from "../components/report-kit";
import { ErrorBox, Icon, Loading, Sheet } from "../components/ui";

interface Assumptions {
  age: number;
  retireAge: number;
  endAge: number;
  /** Annual return on net worth, percent. */
  returnPct: number;
  /** Annual inflation applied to retirement spending, percent. */
  inflationPct: number;
  /** null = use the last 12 months' average. */
  monthlySavings: number | null;
  monthlyRetirementSpend: number | null;
  /** Monthly income in retirement (pension, Social Security), today's dollars. */
  monthlyRetirementIncome: number;
}
interface Event {
  id: string;
  year: number;
  label: string;
  cents: number;
}
const DEFAULTS: Assumptions = { age: 35, retireAge: 65, endAge: 90, returnPct: 6, inflationPct: 3, monthlySavings: null, monthlyRetirementSpend: null, monthlyRetirementIncome: 0 };

function load<T>(k: string, d: T): T {
  try {
    const v = store.get(k);
    return v ? { ...d, ...JSON.parse(v) } : d;
  } catch {
    return d;
  }
}

interface YearRow {
  year: number;
  age: number;
  start: number;
  contributions: number;
  withdrawals: number;
  growth: number;
  events: number;
  end: number;
}

export function project(nw: number, a: Assumptions, savings: number, spend: number, events: Event[], now: { year: number; month: number }): YearRow[] {
  const rows: YearRow[] = [];
  let bal = nw;
  const r = a.returnPct / 100;
  for (let y = now.year, age = a.age; age <= a.endAge; y++, age++) {
    const months = y === now.year ? 12 - now.month : 12;
    const growth = Math.round(bal * ((1 + r) ** (months / 12) - 1));
    const infl = (1 + a.inflationPct / 100) ** (y - now.year);
    const retired = age >= a.retireAge;
    const contributions = retired ? 0 : Math.round(savings * months);
    const withdrawals = retired ? Math.round((spend - a.monthlyRetirementIncome * 100) * infl * months) : 0;
    const ev = events.filter((e) => e.year === y).reduce((s, e) => s + e.cents, 0);
    const end = bal + growth + contributions - withdrawals + ev;
    rows.push({ year: y, age, start: bal, contributions, withdrawals, growth, events: ev, end });
    bal = end;
  }
  return rows;
}

export function Forecast() {
  const scope = useScope();
  const m = thisMonth();
  const nw = useApi(`/reports/balances${qs({ from: `${m}-01`, interval: "month", exclude: scope.param })}`, [scope.param]);
  const hist = useApi(`/reports/series${qs({ from: `${monthShift(m, -12)}-01`, to: `${monthShift(m, -1)}-28`, interval: "month", exclude: scope.param })}`, [scope.param]);
  const [a, setA] = useState<Assumptions>(() => load("forecast.assumptions", DEFAULTS));
  const [events, setEvents] = useState<Event[]>(() => {
    try {
      return JSON.parse(store.get("forecast.events") ?? "[]");
    } catch {
      return [];
    }
  });
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [tab, setTab] = useState<"table" | "events">("table");
  const saveA = (n: Assumptions) => {
    setA(n);
    store.set("forecast.assumptions", JSON.stringify(n));
  };
  const saveE = (n: Event[]) => {
    setEvents(n);
    store.set("forecast.events", JSON.stringify(n));
  };
  const ps: any[] = hist.data?.periods ?? [];
  const avgNet = ps.length ? Math.round(ps.reduce((s, p) => s + p.net_cents, 0) / ps.length) : 0;
  const avgSpend = ps.length ? Math.round(ps.reduce((s, p) => s + p.expenses_cents, 0) / ps.length) : 0;
  const savings = a.monthlySavings !== null ? a.monthlySavings * 100 : avgNet;
  const spend = a.monthlyRetirementSpend !== null ? a.monthlyRetirementSpend * 100 : avgSpend;
  const start = nw.data?.net_worth_cents.at(-1) ?? 0;
  const now = { year: Number(m.slice(0, 4)), month: Number(m.slice(5, 7)) - 1 };
  const rows = useMemo(() => project(start, a, savings, spend, events, now), [start, a, savings, spend, events]);
  const retireRow = rows.find((r) => r.age === a.retireAge);
  const option = useCallback(
    (t: Theme) => ({
      grid: { left: 4, right: 14, top: 24, bottom: 0, containLabel: true },
      tooltip: { trigger: "axis", formatter: (p: any[]) => `<b>${rows[p[0].dataIndex]?.year}</b> · age ${rows[p[0].dataIndex]?.age}<br/>${money(rows[p[0].dataIndex]?.end ?? 0, true)}` },
      xAxis: { type: "category", data: rows.map((r) => String(r.year)), ...axis(t) },
      yAxis: valueAxis(t),
      series: [
        {
          name: "Net worth",
          type: "line",
          symbol: "none",
          lineStyle: { width: 2.4, color: t.ink },
          data: rows.map((r) => r.end),
          markLine: {
            symbol: "none",
            silent: true,
            label: { formatter: `Retire at ${a.retireAge}`, color: t.muted, position: "insideEndTop" },
            lineStyle: { color: t.line, type: "solid" },
            data: retireRow ? [{ xAxis: String(retireRow.year) }] : [],
          },
        },
        {
          // Redraw the part below zero in red (from the last point above zero).
          name: "Below zero",
          type: "line",
          symbol: "none",
          lineStyle: { width: 2.4, color: t.out },
          data: rows.map((r, i) => (r.end < 0 || (rows[i + 1]?.end ?? 0) < 0 ? r.end : null)),
          markLine: { symbol: "none", silent: true, label: { show: false }, lineStyle: { color: t.muted, type: "dashed" }, data: [{ yAxis: 0 }] },
        },
      ],
    }),
    [rows],
  );
  if (nw.error) return <ErrorBox error={nw.error} />;
  const end = rows.at(-1)?.end ?? 0;
  const brokeAt = rows.find((r) => r.end < 0);
  return (
    <div class="stack">
      <div class="topbar">
        <h1>Forecast</h1>
        <div class="toolbar">
          <button class="btn sm" onClick={() => setEditing(true)}>
            <span class="tiny-ico"><Icon.gear /></span> Assumptions
          </button>
          <button class="btn sm primary" onClick={() => setAdding(true)}>
            <span class="tiny-ico"><Icon.plus /></span> Event
          </button>
          <BusinessFilter />
        </div>
      </div>
      {!nw.data || !hist.data ? (
        <Loading h={460} />
      ) : (
        <>
          <Kpis
            items={[
              { label: "Net worth (end of year)", value: compact(rows[0]?.end ?? start) },
              { label: "Net worth at retirement", value: compact(retireRow?.end ?? 0) },
              { label: "Retirement age", value: String(a.retireAge) },
              { label: `Net worth at ${a.endAge}`, value: compact(end), tone: end < 0 ? "neg" : "" },
            ]}
          />
          <div class="card chart-card">
            <div class="card-head">
              <div>
                <h2>Projected net worth</h2>
                <div class="sub">
                  From {money(start, true)} today, saving {money(savings, true)}/mo until {a.retireAge}, then spending {money(spend, true)}/mo (today's dollars) with {a.returnPct}% returns.
                  {brokeAt && <span class="neg"> Money runs out around age {brokeAt.age} ({brokeAt.year}).</span>}
                </div>
              </div>
            </div>
            <Chart option={option} class="chart tall" />
          </div>
          <div class="card">
            <div class="card-head">
              <Seg value={tab} onChange={setTab} label="Detail" options={[["table", "By year"], ["events", `Events (${events.length})`]]} />
            </div>
            {tab === "table" ? (
              <div class="st-scroll">
                <table class="table fc-table">
                  <thead>
                    <tr>
                      <th>Year</th>
                      <th class="r">Age</th>
                      <th class="r">Saved</th>
                      <th class="r">Spent</th>
                      <th class="r">Growth</th>
                      <th class="r">Events</th>
                      <th class="r">Net worth</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr class={r.age === a.retireAge ? "fc-retire" : ""}>
                        <td>{r.year}</td>
                        <td class="r num">{r.age}</td>
                        <td class="r num in">{r.contributions ? compact(r.contributions) : "–"}</td>
                        <td class="r num">{r.withdrawals ? compact(-r.withdrawals) : "–"}</td>
                        <td class={`r num ${r.growth < 0 ? "neg" : ""}`}>{compact(r.growth)}</td>
                        <td class="r num">{r.events ? compact(r.events) : "–"}</td>
                        <td class={`r num ${r.end < 0 ? "neg" : ""}`}>
                          <strong>{compact(r.end)}</strong>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div class="list">
                {events.length === 0 && <div class="empty small">Add one-off events like a home purchase, inheritance or a car.</div>}
                {[...events]
                  .sort((x, y) => x.year - y.year)
                  .map((e) => (
                    <div class="item">
                      <div class="body">
                        <div class="title">{e.label}</div>
                        <div class="meta">{e.year}</div>
                      </div>
                      <span class={`num ${e.cents < 0 ? "" : "in"}`}>{money(e.cents, true)}</span>
                      <button class="btn ghost sm" onClick={() => saveE(events.filter((x) => x.id !== e.id))} aria-label={`Remove ${e.label}`}>
                        <span class="tiny-ico"><Icon.x /></span>
                      </button>
                    </div>
                  ))}
              </div>
            )}
          </div>
          <div class="muted tiny">A rough projection for planning, not financial advice. Assumptions are saved in this browser.</div>
        </>
      )}
      <Sheet open={editing} onClose={() => setEditing(false)} title="Assumptions">
        <AssumptionForm
          a={a}
          avgNet={avgNet}
          avgSpend={avgSpend}
          onSave={(n) => {
            saveA(n);
            setEditing(false);
          }}
        />
      </Sheet>
      <Sheet open={adding} onClose={() => setAdding(false)} title="Add event">
        <EventForm
          year={now.year}
          onSave={(e) => {
            saveE([...events, e]);
            setTab("events");
            setAdding(false);
          }}
        />
      </Sheet>
    </div>
  );
}

function NumField({ label, value, onInput, placeholder, hint }: { label: string; value: string; onInput: (v: string) => void; placeholder?: string; hint?: string }) {
  return (
    <div class="field">
      <label>{label}</label>
      <input class="input num" inputMode="decimal" value={value} placeholder={placeholder} onInput={(e) => onInput((e.target as HTMLInputElement).value)} />
      {hint && <span class="muted tiny">{hint}</span>}
    </div>
  );
}

function AssumptionForm({ a, avgNet, avgSpend, onSave }: { a: Assumptions; avgNet: number; avgSpend: number; onSave: (a: Assumptions) => void }) {
  const [f, setF] = useState<Record<keyof Assumptions, string>>({
    age: String(a.age),
    retireAge: String(a.retireAge),
    endAge: String(a.endAge),
    returnPct: String(a.returnPct),
    inflationPct: String(a.inflationPct),
    monthlySavings: a.monthlySavings === null ? "" : String(a.monthlySavings),
    monthlyRetirementSpend: a.monthlyRetirementSpend === null ? "" : String(a.monthlyRetirementSpend),
    monthlyRetirementIncome: String(a.monthlyRetirementIncome),
  });
  const set = (k: keyof Assumptions) => (v: string) => setF({ ...f, [k]: v });
  const num = (s: string, d: number) => (s.trim() === "" || !Number.isFinite(Number(s.replace(/[$,]/g, ""))) ? d : Number(s.replace(/[$,]/g, "")));
  const submit = () => {
    const age = Math.max(0, Math.round(num(f.age, a.age)));
    const retireAge = Math.max(age, Math.round(num(f.retireAge, a.retireAge)));
    onSave({
      age,
      retireAge,
      endAge: Math.min(120, Math.max(retireAge, Math.round(num(f.endAge, a.endAge)))),
      returnPct: num(f.returnPct, a.returnPct),
      inflationPct: num(f.inflationPct, a.inflationPct),
      monthlySavings: f.monthlySavings.trim() === "" ? null : num(f.monthlySavings, 0),
      monthlyRetirementSpend: f.monthlyRetirementSpend.trim() === "" ? null : num(f.monthlyRetirementSpend, 0),
      monthlyRetirementIncome: num(f.monthlyRetirementIncome, 0),
    });
  };
  return (
    <form
      class="stack"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div class="grid-3">
        <NumField label="Your age" value={f.age} onInput={set("age")} />
        <NumField label="Retire at" value={f.retireAge} onInput={set("retireAge")} />
        <NumField label="Plan until" value={f.endAge} onInput={set("endAge")} />
      </div>
      <div class="grid-2">
        <NumField label="Annual return %" value={f.returnPct} onInput={set("returnPct")} />
        <NumField label="Inflation %" value={f.inflationPct} onInput={set("inflationPct")} />
      </div>
      <NumField label="Monthly savings until retirement ($)" value={f.monthlySavings} onInput={set("monthlySavings")} placeholder={(avgNet / 100).toFixed(0)} hint={`Blank uses your last 12 months: ${money(avgNet, true)}/mo net cash flow.`} />
      <NumField label="Monthly spending in retirement ($, today's dollars)" value={f.monthlyRetirementSpend} onInput={set("monthlyRetirementSpend")} placeholder={(avgSpend / 100).toFixed(0)} hint={`Blank uses your last 12 months: ${money(avgSpend, true)}/mo spending.`} />
      <NumField label="Monthly retirement income ($, e.g. Social Security)" value={f.monthlyRetirementIncome} onInput={set("monthlyRetirementIncome")} />
      <button class="btn primary block" type="submit">
        Save assumptions
      </button>
    </form>
  );
}

function EventForm({ year, onSave }: { year: number; onSave: (e: Event) => void }) {
  const [label, setLabel] = useState("");
  const [y, setY] = useState(String(year + 1));
  const [amount, setAmount] = useState("");
  const [dir, setDir] = useState<"out" | "in">("out");
  const cents = Math.round(Number(amount.replace(/[$,]/g, "")) * 100);
  const ok = label.trim() && Number.isInteger(Number(y)) && Number.isFinite(cents) && cents > 0;
  return (
    <form
      class="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onSave({ id: `${Date.now()}`, label: label.trim(), year: Number(y), cents: dir === "out" ? -cents : cents });
      }}
    >
      <Seg value={dir} onChange={setDir} label="Direction" options={[["out", "Expense"], ["in", "Windfall"]]} />
      <div class="field">
        <label>What</label>
        <input class="input" value={label} placeholder="Down payment" onInput={(e) => setLabel((e.target as HTMLInputElement).value)} />
      </div>
      <div class="grid-2">
        <NumField label="Year" value={y} onInput={setY} />
        <NumField label="Amount ($)" value={amount} onInput={setAmount} placeholder="50000" />
      </div>
      <button class="btn primary block" type="submit" disabled={!ok}>
        Add event
      </button>
    </form>
  );
}
