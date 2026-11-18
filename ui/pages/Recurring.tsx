import { useState } from "preact/hooks";
import { categoryMeta, money, monthEnd, monthName, monthShift, thisMonth, today, useApi } from "../api";
import { businessStyle, go, useApp } from "../app";
import { Kpis, qs, Seg, shortDate, useStored, BusinessFilter, useScope } from "../components/report-kit";
import { Avatar, CatName, ErrorBox, Icon, Loading } from "../components/ui";

interface Item {
  key: string;
  payee: string;
  kind: "expense" | "income";
  category: string;
  entity: string | null;
  frequency: string;
  amount_cents: number;
  average_cents: number;
  variable: boolean;
  count: number;
  last_date: string;
  next_date: string;
  monthly_cents: number;
  yearly_cents: number;
  status: "active" | "late" | "inactive";
  history: Array<{ date: string; cents: number }>;
}

const FREQ: Record<string, string> = {
  weekly: "Every week",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
  bimonthly: "Every 2 months",
  quarterly: "Quarterly",
  semiannual: "Every 6 months",
  yearly: "Yearly",
};
const STEP: Record<string, number> = { weekly: 7, biweekly: 14 };

/** Every expected occurrence of `i` within [from, to]. */
function occurrences(i: Item, from: string, to: string): string[] {
  const out: string[] = [];
  const add = (d: string, n: number) => {
    const x = new Date(`${d}T00:00:00Z`);
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  };
  const months: Record<string, number> = { monthly: 1, bimonthly: 2, quarterly: 3, semiannual: 6, yearly: 12 };
  let d = i.next_date;
  for (let n = 0; n < 60 && d <= to; n++) {
    if (d >= from) out.push(d);
    if (STEP[i.frequency]) d = add(d, STEP[i.frequency]!);
    else {
      const day = Number(i.next_date.slice(8, 10));
      const m = monthShift(d.slice(0, 7), months[i.frequency] ?? 1);
      const last = Number(monthEnd(m).slice(8, 10));
      d = `${m}-${String(Math.min(day, last)).padStart(2, "0")}`;
    }
  }
  return out;
}

export function Recurring() {
  const { entities } = useApp();
  const scope = useScope();
  const { data, error } = useApi(`/reports/recurring${qs({ exclude: scope.param })}`, [scope.param]);
  const [kind, setKind] = useStored<"expense" | "income" | "all">("recurring.kind", "expense", ["expense", "income", "all"]);
  const [view, setView] = useStored<"list" | "calendar">("recurring.view", "list", ["list", "calendar"]);
  const [month, setMonth] = useState(thisMonth());
  if (error) return <ErrorBox error={error} />;
  const items: Item[] = data?.items ?? [];
  const shown = items.filter((i) => kind === "all" || i.kind === kind);
  const live = shown.filter((i) => i.status !== "inactive");
  const t = today();
  const end = monthEnd(thisMonth());
  const dueRest = items.filter((i) => i.kind === "expense" && i.status !== "inactive").flatMap((i) => occurrences(i, t, end).map(() => i.average_cents)).reduce((a, b) => a + b, 0);
  const ent = (slug: string | null) => entities.find((e) => e.slug === slug);
  return (
    <div class="stack">
      <div class="topbar">
        <h1>Recurring</h1>
        <div class="toolbar">
          <Seg value={view} onChange={setView} label="View" options={[["list", "List"], ["calendar", "Calendar"]]} />
          <BusinessFilter />
        </div>
      </div>
      {!data ? (
        <Loading h={420} />
      ) : (
        <>
          <Kpis
            items={[
              { label: "Recurring expenses / month", value: money(data.monthly_expense_cents), tone: "neg" },
              { label: "Recurring income / month", value: money(data.monthly_income_cents), tone: "in" },
              { label: "Still due this month", value: money(dueRest) },
              { label: "Yearly subscriptions & bills", value: money(data.monthly_expense_cents * 12) },
            ]}
          />
          <div class="spread wrap">
            <Seg value={kind} onChange={setKind} label="Kind" options={[["expense", "Expenses"], ["income", "Income"], ["all", "All"]]} />
            <span class="muted small">Detected from repeating payees with a steady schedule and similar amounts.</span>
          </div>
          {view === "calendar" ? (
            <Calendar items={live} month={month} setMonth={setMonth} />
          ) : (
            <div class="card" style={{ paddingTop: 6 }}>
              {shown.length === 0 && <div class="empty">No recurring {kind === "income" ? "income" : "charges"} found yet. They appear after a payee repeats on a schedule (3 months for monthly bills).</div>}
              {shown.length > 0 && (
                <div class="rec-head hide-sm">
                  <span>Merchant</span>
                  <span>Frequency</span>
                  <span>Category</span>
                  <span>Next</span>
                  <span class="r">Amount</span>
                  <span class="r">Per year</span>
                </div>
              )}
              {shown.map((i) => {
                const e = ent(i.entity);
                const soon = i.next_date <= monthEnd(thisMonth());
                return (
                  <button class={`rec-row ${i.status}`} onClick={() => go(`/transactions?q=${encodeURIComponent(i.payee)}`)}>
                    <span class="rec-payee">
                      <Avatar name={i.payee} />
                      <span>
                        <strong>{i.payee}</strong>
                        <span class="meta">
                          {i.count} payments · last {shortDate(i.last_date)}
                          {e && (
                            <span class="business-tag" style={businessStyle(e.slug, e.color)}>
                              {e.name}
                            </span>
                          )}
                        </span>
                      </span>
                    </span>
                    <span class="muted small">{FREQ[i.frequency]}</span>
                    <span class="hide-sm">
                      <CatName account={i.category} />
                    </span>
                    <span class="small">
                      {i.status === "inactive" ? <span class="pill zero">Stopped?</span> : i.status === "late" ? <span class="pill warn">Late · {shortDate(i.next_date)}</span> : <span class={soon ? "" : "muted"}>{shortDate(i.next_date)}</span>}
                    </span>
                    <span class={`r num rec-amt ${i.kind === "income" ? "in" : ""}`}>
                      {i.variable && <span class="muted" title="Amount varies; showing the recent average">~</span>}
                      {money(i.average_cents)}
                    </span>
                    <span class="r num muted hide-sm">{money(i.yearly_cents, true)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Calendar({ items, month, setMonth }: { items: Item[]; month: string; setMonth: (m: string) => void }) {
  const first = new Date(`${month}-01T00:00:00Z`);
  const lead = (first.getUTCDay() + 6) % 7;
  const days = Number(monthEnd(month).slice(8, 10));
  const byDay = new Map<string, Item[]>();
  for (const i of items) for (const d of occurrences(i, `${month}-01`, monthEnd(month))) byDay.set(d, [...(byDay.get(d) ?? []), i]);
  // Past days of the current month show what was actually paid.
  for (const i of items) for (const h of i.history) if (h.date.startsWith(month) && h.date < today()) byDay.set(h.date, [...(byDay.get(h.date) ?? []).filter((x) => x.key !== i.key), { ...i, average_cents: h.cents, status: "active" }]);
  const total = [...byDay.values()].flat().filter((i) => i.kind === "expense").reduce((s, i) => s + i.average_cents, 0);
  const t = today();
  return (
    <div class="card">
      <div class="card-head">
        <div class="month-nav">
          <button class="icon-btn" onClick={() => setMonth(monthShift(month, -1))} aria-label="Previous month">
            <span class="flip"><Icon.chevron /></span>
          </button>
          <strong>{monthName(month, { month: "long", year: "numeric" })}</strong>
          <button class="icon-btn" onClick={() => setMonth(monthShift(month, 1))} aria-label="Next month">
            <Icon.chevron />
          </button>
        </div>
        <span class="muted small num">{money(total)} in recurring charges</span>
      </div>
      <div class="cal">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div class="cal-dow">{d}</div>
        ))}
        {Array.from({ length: lead }, () => (
          <div class="cal-day blank" />
        ))}
        {Array.from({ length: days }, (_, k) => {
          const d = `${month}-${String(k + 1).padStart(2, "0")}`;
          const its = byDay.get(d) ?? [];
          return (
            <div class={`cal-day${d === t ? " today" : ""}${d < t ? " past" : ""}`}>
              <span class="cal-n">{k + 1}</span>
              {its.slice(0, 3).map((i) => (
                <span class={`cal-chip ${i.kind}`} title={`${i.payee} · ${money(i.average_cents)}`}>
                  <span aria-hidden>{categoryMeta(i.category).emoji}</span>
                  <span class="cal-chip-name">{i.payee}</span>
                  <span class="num">{money(i.average_cents, true)}</span>
                </span>
              ))}
              {its.length > 3 && <span class="muted tiny">+{its.length - 3} more</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
