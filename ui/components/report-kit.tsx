/** Building blocks shared by the report pages: ranges, KPI cards, breakdown bars, summaries, charts. */
import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { CATEGORY_GROUPS, catLabel, categoryMeta, compact, dayLabel, money, monthEnd, monthShift, monthStart, store, thisMonth, today, useApi } from "../api";
import { businessStyle, go, useApp } from "../app";
import { Chart, type Theme } from "./chart";
import { Avatar, CatName, CellMenu, Icon, Loading, MenuOption } from "./ui";

// ---- query strings & ranges -------------------------------------------------

/** `?a=1&b=2`, skipping null/undefined/empty values. */
export function qs(params: Record<string, string | number | null | undefined>): string {
  const p = Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== "");
  return p.length ? `?${p.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&")}` : "";
}

export type RangeKey = "month" | "last" | "3m" | "6m" | "ytd" | "12m" | "lastyear" | "all";
export const RANGES: Array<[RangeKey, string]> = [
  ["month", "This month"],
  ["last", "Last month"],
  ["3m", "Last 3 months"],
  ["6m", "Last 6 months"],
  ["ytd", "Year to date"],
  ["12m", "Last 12 months"],
  ["lastyear", "Last year"],
  ["all", "All time"],
];

export function rangeDates(r: RangeKey): { from: string | null; to: string | null; label: string } {
  const m = thisMonth();
  const y = Number(m.slice(0, 4));
  const label = RANGES.find(([k]) => k === r)?.[1] ?? "";
  switch (r) {
    case "month":
      return { from: monthStart(m), to: monthEnd(m), label };
    case "last":
      return { from: monthStart(monthShift(m, -1)), to: monthEnd(monthShift(m, -1)), label };
    case "3m":
      return { from: monthStart(monthShift(m, -2)), to: monthEnd(m), label };
    case "6m":
      return { from: monthStart(monthShift(m, -5)), to: monthEnd(m), label };
    case "ytd":
      return { from: `${y}-01-01`, to: today(), label };
    case "12m":
      return { from: monthStart(monthShift(m, -11)), to: monthEnd(m), label };
    case "lastyear":
      return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31`, label: String(y - 1) };
    case "all":
      return { from: null, to: null, label };
  }
}

/** A remembered per-viewer choice (localStorage), falling back to `initial`. */
export function useStored<T extends string>(key: string, initial: T, allowed?: readonly T[]): [T, (v: T) => void] {
  const saved = store.get(key) as T | null;
  const [v, setV] = useState<T>(saved && (!allowed || allowed.includes(saved)) ? saved : initial);
  return [
    v,
    (n: T) => {
      setV(n);
      store.set(key, n);
    },
  ];
}

export function RangeMenu({ value, onChange }: { value: RangeKey; onChange: (r: RangeKey) => void }) {
  return (
    <CellMenu
      tool
      label="Date range"
      width={220}
      value={
        <>
          <span class="tool-ico"><Icon.calendar /></span>
          {RANGES.find(([k]) => k === value)?.[1]}
        </>
      }
    >
      {(close) =>
        RANGES.map(([k, l], i) => (
          <MenuOption
            index={i}
            selected={k === value}
            onClick={() => {
              onChange(k);
              close();
            }}
          >
            {l}
          </MenuOption>
        ))
      }
    </CellMenu>
  );
}

/** A small segmented control. */
export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: Array<[T, ComponentChildren]>; onChange: (v: T) => void; label?: string }) {
  return (
    <div class="seg" role="group" aria-label={label}>
      {options.map(([k, l]) => (
        <button class={value === k ? "active" : ""} aria-pressed={value === k} onClick={() => onChange(k)}>
          {l}
        </button>
      ))}
    </div>
  );
}

// ---- report filters (business scope + hidden categories) ----------------------

const EXCLUDE_KEY = "reports.exclude";
const CATS_KEY = "reports.excludeCategories";
const scopeListeners = new Set<() => void>();
function readList(key: string): string[] {
  try {
    const v = JSON.parse(store.get(key) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function writeList(key: string, xs: string[]) {
  store.set(key, xs.length ? JSON.stringify([...new Set(xs)].sort()) : null);
  scopeListeners.forEach((l) => l());
}

/**
 * What the report pages include: which businesses (stored as the excluded
 * slugs, so new businesses show up by default) and which categories are hidden.
 * Shared by every report page and remembered in this browser.
 */
export function useScope() {
  const [state, setState] = useState(() => ({ exclude: readList(EXCLUDE_KEY), cats: readList(CATS_KEY) }));
  useEffect(() => {
    const on = () => setState({ exclude: readList(EXCLUDE_KEY), cats: readList(CATS_KEY) });
    scopeListeners.add(on);
    return () => {
      scopeListeners.delete(on);
    };
  }, []);
  const { exclude, cats } = state;
  const param = exclude.length ? exclude.join(",") : null;
  const catParam = cats.length ? cats.join(",") : null;
  return {
    exclude,
    excludeCategories: cats,
    /** The `exclude` query parameter (businesses only), or null. */
    param,
    /** Query parameters for both filters, to spread into qs(). */
    q: { exclude: param, exclude_categories: catParam },
    /** Changes whenever either filter changes (for fetch dependencies). */
    key: `${param ?? ""}|${catParam ?? ""}`,
    set: (xs: string[]) => writeList(EXCLUDE_KEY, xs),
    setCategories: (xs: string[]) => writeList(CATS_KEY, xs),
    clear: () => {
      store.set(EXCLUDE_KEY, null);
      writeList(CATS_KEY, []);
    },
    keep: (e: string | null) => e === null || !exclude.includes(e),
    keepCategory: (a: string) => !cats.some((c) => a === c || a.startsWith(`${c}:`)),
  };
}

/** Clear + Filters (categories) + Business, as in Monarch's report toolbar. */
export function ReportFilters({ categories = true }: { categories?: boolean }) {
  const scope = useScope();
  const active = scope.exclude.length > 0 || (categories && scope.excludeCategories.length > 0);
  return (
    <div class="scope">
      {active && (
        <button class="linkbtn" onClick={() => (categories ? scope.clear() : scope.set([]))}>
          Clear
        </button>
      )}
      {categories && <CategoryFilter />}
      <BusinessFilter />
    </div>
  );
}

/** Monarch-style "Business" filter: tick the profiles a report includes. */
export function BusinessFilter() {
  const { entities } = useApp();
  const scope = useScope();
  const off = new Set(scope.exclude.filter((s) => entities.some((e) => e.slug === s)));
  const on = entities.filter((e) => !off.has(e.slug));
  const label = off.size === 0 ? "All businesses" : on.length === 1 ? on[0]!.name : on.length === 0 ? "None selected" : off.size === 1 ? `Excluding ${entities.find((e) => off.has(e.slug))!.name}` : `${on.length} of ${entities.length}`;
  const toggle = (slug: string) => scope.set(off.has(slug) ? [...off].filter((s) => s !== slug) : [...off, slug]);
  if (entities.length < 2) return null;
  return (
    <CellMenu
      tool
      label="Businesses in this report"
      width={300}
      value={
        <>
          <span class="tool-ico"><Icon.folder /></span>
          {label}
          {off.size > 0 && <span class="scope-dot" aria-label="filtered" />}
        </>
      }
    >
      {() => (
        <>
          <div class="menu-head spread">
            <strong>Include in reports</strong>
            <span class="row" style={{ gap: 4 }}>
              <button class="chip" onClick={() => scope.set([])}>All</button>
              <button class="chip" onClick={() => scope.set(entities.filter((e) => e.type !== "personal").map((e) => e.slug))}>Personal</button>
            </span>
          </div>
          {entities.map((e, i) => {
            const checked = !off.has(e.slug);
            const color = businessStyle(e.slug, e.color).color!;
            return (
              <button class={`menu-opt scope-opt${checked ? " checked" : ""}`} style={{ animationDelay: `${i * 18}ms` }} role="menuitemcheckbox" aria-checked={checked} onClick={() => toggle(e.slug)}>
                <span class="scope-box" style={checked ? { background: color, borderColor: color } : {}}>
                  {checked && <Icon.check />}
                </span>
                <span class="business-icon compact" style={businessStyle(e.slug, e.color)}>
                  {e.type === "personal" ? "👤" : <Icon.folder />}
                </span>
                <span class="scope-name">{e.name}</span>
                <span class="muted tiny">{e.type === "personal" ? "Personal" : "Business"}</span>
              </button>
            );
          })}
          <div class="menu-note">Unticked profiles are left out of totals, charts and transactions, so one business can't skew the numbers.</div>
        </>
      )}
    </CellMenu>
  );
}

/** "Filters": hide categories (transfers, taxes, a one-off purchase…) from report totals. */
export function CategoryFilter() {
  const { categories } = useApp();
  const scope = useScope();
  const [q, setQ] = useState("");
  const off = new Set(scope.excludeCategories);
  const n = scope.excludeCategories.length;
  const all = [...categories].sort((a, b) => catLabel(a).localeCompare(catLabel(b)));
  const shown = q ? all.filter((c) => catLabel(c).toLowerCase().includes(q.toLowerCase()) || categoryMeta(c).group.toLowerCase().includes(q.toLowerCase())) : all;
  const groups = CATEGORY_GROUPS.map((g) => ({ g, cats: shown.filter((c) => categoryMeta(c).group === g) })).filter((x) => x.cats.length > 0);
  const setOff = (xs: Iterable<string>) => scope.setCategories([...xs]);
  const toggle = (c: string) => {
    const next = new Set(off);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    setOff(next);
  };
  const toggleGroup = (cats: string[]) => {
    const next = new Set(off);
    const allOff = cats.every((c) => next.has(c));
    for (const c of cats) allOff ? next.delete(c) : next.add(c);
    setOff(next);
  };
  return (
    <CellMenu
      tool
      label="Hide categories"
      width={340}
      value={
        <>
          <span class="tool-ico"><Icon.filter /></span>
          Filters
          {n > 0 && <span class="count-badge">{n}</span>}
        </>
      }
    >
      {() => (
        <>
          <div class="search">
            <Icon.search />
            <input class="input" placeholder="Search categories" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label="Search categories" />
          </div>
          <div class="menu-head">
            <strong>Show categories</strong>
            <span class="muted tiny">Untick a category to leave it out of totals, charts and recurring.</span>
          </div>
          {groups.length === 0 && <div class="empty small">No categories match</div>}
          {groups.map(({ g, cats }) => {
            const offCount = cats.filter((c) => off.has(c)).length;
            return (
              <div class="cat-filter-group">
                <button class={`menu-opt scope-opt group${offCount < cats.length ? " checked" : ""}`} role="menuitemcheckbox" aria-checked={offCount === 0 ? "true" : offCount === cats.length ? "false" : "mixed"} onClick={() => toggleGroup(cats)}>
                  <span class={`scope-box${offCount === 0 ? " on" : offCount < cats.length ? " mixed" : ""}`}>{offCount === 0 ? <Icon.check /> : offCount < cats.length ? "–" : null}</span>
                  <strong class="scope-name">{g}</strong>
                  <span class="muted tiny">{cats.length - offCount}/{cats.length}</span>
                </button>
                {cats.map((c) => (
                  <button class={`menu-opt scope-opt sub${off.has(c) ? "" : " checked"}`} role="menuitemcheckbox" aria-checked={!off.has(c)} onClick={() => toggle(c)}>
                    <span class={`scope-box${off.has(c) ? "" : " on"}`}>{!off.has(c) && <Icon.check />}</span>
                    <span class="scope-name">
                      <CatName account={c} />
                    </span>
                  </button>
                ))}
              </div>
            );
          })}
          {n > 0 && (
            <div class="menu-note spread">
              <span>{n} hidden</span>
              <button class="linkbtn" style={{ padding: 0, fontSize: 13 }} onClick={() => setOff([])}>
                Show all
              </button>
            </div>
          )}
        </>
      )}
    </CellMenu>
  );
}

// ---- period labels -----------------------------------------------------------

export type Interval = "day" | "week" | "month" | "quarter" | "year";
export function periodLabel(start: string, interval: Interval | "total", long = false): string {
  const d = new Date(`${start}T00:00:00Z`);
  const o = (x: Intl.DateTimeFormatOptions) => d.toLocaleDateString("en-US", { ...x, timeZone: "UTC" });
  switch (interval) {
    case "day":
    case "week":
      return o({ month: "short", day: "numeric", ...(long ? { year: "numeric" } : {}) });
    case "month":
      return long ? o({ month: "long", year: "numeric" }) : o({ month: "short" });
    case "quarter":
      return `Q${Math.floor(d.getUTCMonth() / 3) + 1}${long ? " " : " '"}${long ? d.getUTCFullYear() : String(d.getUTCFullYear()).slice(2)}`;
    case "year":
    case "total":
      return String(d.getUTCFullYear());
  }
}
export const shortDate = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—");
export const signed = (cents: number) => `${cents > 0 ? "+" : ""}${money(cents)}`;
export const pct = (n: number | null | undefined, digits = 1) => (n === null || n === undefined || !Number.isFinite(n) ? "—" : `${n.toFixed(digits)}%`);

// ---- KPI & summary cards -------------------------------------------------------

export function Kpis({ items }: { items: Array<{ label: string; value: ComponentChildren; tone?: "in" | "out" | "neg" | "" }> }) {
  return (
    <div class="kpis">
      {items.map((k) => (
        <div class="card kpi">
          <div class={`kpi-value num ${k.tone ?? ""}`}>{k.value}</div>
          <div class="kpi-label">{k.label}</div>
        </div>
      ))}
    </div>
  );
}

export function Summary({ title = "Summary", rows, footer, sub }: { title?: string; rows: Array<[string, ComponentChildren, string?]>; footer?: ComponentChildren; sub?: ComponentChildren }) {
  return (
    <div class="card summary">
      <div class="summary-head">
        <h2>{title}</h2>
      </div>
      {sub && <div class="summary-sub">{sub}</div>}
      <dl>
        {rows.map(([k, v, tone]) => (
          <>
            <dt>{k}</dt>
            <dd class={`num ${tone ?? ""}`}>{v}</dd>
          </>
        ))}
      </dl>
      {footer && <div class="summary-foot">{footer}</div>}
    </div>
  );
}

export function downloadCsv(name: string, rows: Array<Array<string | number | null>>) {
  const esc = (v: string | number | null) => {
    const s = v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const blob = new Blob([rows.map((r) => r.map(esc).join(",")).join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
export const csvMoney = (cents: number) => (cents / 100).toFixed(2);

// ---- breakdown bars ---------------------------------------------------------

export type By = "category" | "group" | "merchant";
export const BY_OPTIONS: Array<[By, string]> = [
  ["category", "Category"],
  ["group", "Group"],
  ["merchant", "Merchant"],
];
const GROUP_EMOJI: Record<string, string> = {
  Income: "💰",
  "Food & Dining": "🍽️",
  Housing: "🏡",
  "Bills & Utilities": "💡",
  "Auto & Transport": "🚗",
  "Travel & Lifestyle": "✈️",
  Shopping: "🛍️",
  Children: "👶",
  Education: "🏫",
  "Health & Wellness": "💊",
  "Gifts & Donations": "🎁",
  Financial: "🏦",
  Business: "💼",
  Other: "🏷️",
  Transfers: "🔄",
};

export interface Slice {
  key: string;
  label: ComponentChildren;
  text: string;
  cents: number;
  count?: number;
  account?: string;
  merchant?: boolean;
}

/** Turn an overview kind into slices by category, group or merchant. */
export function slices(kind: { categories: Array<{ account: string; cents: number; count: number }>; merchants: Array<{ name: string; cents: number; count: number; category: string | null }> }, by: By): Slice[] {
  if (by === "merchant")
    return kind.merchants.map((m) => ({
      key: m.name,
      text: m.name,
      merchant: true,
      cents: m.cents,
      count: m.count,
      label: (
        <span class="catname">
          <span class="merchant-dot" aria-hidden>{m.category ? categoryMeta(m.category).emoji : "🏷️"}</span>
          <span class="catname-text">{m.name}</span>
        </span>
      ),
    }));
  if (by === "group") {
    const g = new Map<string, number>();
    for (const c of kind.categories) {
      const k = categoryMeta(c.account).group;
      g.set(k, (g.get(k) ?? 0) + c.cents);
    }
    return [...g]
      .sort((a, b) => b[1] - a[1])
      .map(([k, cents]) => ({
        key: k,
        text: k,
        cents,
        label: (
          <span class="catname">
            <span class="cat-emoji" aria-hidden>{GROUP_EMOJI[k] ?? "🏷️"}</span>
            <span class="catname-text">{k}</span>
          </span>
        ),
      }));
  }
  return kind.categories.map((c) => ({ key: c.account, account: c.account, text: catLabel(c.account), cents: c.cents, count: c.count, label: <CatName account={c.account} /> }));
}

/** Monarch-style filled bars: each row's tint width is its share of the largest row. */
export function BarList({ items, tone, limit = 12, onPick }: { items: Slice[]; tone: "in" | "out"; limit?: number; onPick?: (s: Slice) => void }) {
  const [all, setAll] = useState(false);
  if (items.length === 0) return <div class="empty small">Nothing in this period</div>;
  const total = items.reduce((s, i) => s + Math.max(0, i.cents), 0) || 1;
  const max = Math.max(1, ...items.map((i) => i.cents));
  const shown = all ? items : items.slice(0, limit);
  return (
    <div class="barlist">
      {shown.map((i) => (
        <button class={`barrow ${tone}`} onClick={() => onPick?.(i)} disabled={!onPick} title={i.text}>
          <span class="barfill" style={{ width: `${Math.max(1.5, (Math.max(0, i.cents) / max) * 100)}%` }} />
          <span class="barlabel">{i.label}</span>
          <span class="barvalue num">
            {money(i.cents)} <span class="muted">({((i.cents / total) * 100).toFixed(1)}%)</span>
          </span>
        </button>
      ))}
      {items.length > limit && (
        <button class="linkbtn" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}

/** Open Activity filtered to a category or merchant. */
export function openSlice(s: Slice) {
  if (s.account) go(`/transactions?account=${encodeURIComponent(s.account)}`);
  else if (s.merchant) go(`/transactions?q=${encodeURIComponent(s.text)}`);
}

// ---- charts -----------------------------------------------------------------

export const axis = (t: Theme) => ({
  axisLine: { lineStyle: { color: t.line } },
  axisTick: { show: false },
  axisLabel: { color: t.muted, fontSize: 11.5 },
});
export const valueAxis = (t: Theme) => ({
  type: "value" as const,
  splitLine: { lineStyle: { color: t.line, type: "dashed" as const } },
  axisLabel: { color: t.muted, fontSize: 11.5, formatter: (v: number) => compact(v) },
});

export interface FlowPeriod {
  start: string;
  end: string;
  income_cents: number;
  expenses_cents: number;
  net_cents: number;
}

/** Income up, expenses down, net as a line; click a bar to select its period. */
export function FlowBars({ periods, interval, selected, onSelect, height = "chart tall" }: { periods: FlowPeriod[]; interval: Interval; selected?: number | null; onSelect?: (i: number) => void; height?: string }) {
  const option = useCallback(
    (t: Theme) => {
      const fade = (i: number, c: string) => (selected === null || selected === undefined || selected === i ? c : `${c}55`);
      return {
        grid: { left: 4, right: 10, top: periods.some((p, i) => i > 0 && p.start.slice(0, 4) !== periods[i - 1]!.start.slice(0, 4)) && interval !== "year" ? 30 : 16, bottom: 0, containLabel: true },
        tooltip: {
          trigger: "axis",
          axisPointer: { type: "shadow", shadowStyle: { color: `${t.muted}14` } },
          formatter: (ps: any[]) => {
            const p = periods[ps[0]?.dataIndex ?? 0];
            if (!p) return "";
            const rate = p.income_cents > 0 ? Math.max(0, p.net_cents / p.income_cents) * 100 : 0;
            const row = (dot: string, k: string, v: string) => `<div style="display:flex;justify-content:space-between;gap:24px"><span><span style="display:inline-block;width:8px;height:8px;border-radius:4px;background:${dot};margin-right:6px"></span>${k}</span><b>${v}</b></div>`;
            return `<div style="font-weight:700;margin-bottom:6px">${periodLabel(p.start, interval, true)}</div>${row(t.in, "Income", money(p.income_cents))}${row(t.out, "Expenses", money(p.expenses_cents))}${row(t.ink, "Net income", money(p.net_cents))}${row(t.muted, "Savings rate", `${rate.toFixed(0)}%`)}`;
          },
        },
        xAxis: { type: "category", data: periods.map((p) => periodLabel(p.start, interval)), ...axis(t) },
        yAxis: valueAxis(t),
        series: [
          { name: "Income", type: "bar", stack: "flow", barMaxWidth: 42, data: periods.map((p, i) => ({ value: p.income_cents, itemStyle: { color: fade(i, t.in), borderRadius: [5, 5, 0, 0] } })) },
          { name: "Expenses", type: "bar", stack: "flow", barMaxWidth: 42, data: periods.map((p, i) => ({ value: -p.expenses_cents, itemStyle: { color: fade(i, t.out), borderRadius: [0, 0, 5, 5] } })) },
          {
            name: "Net",
            type: "line",
            data: periods.map((p) => p.net_cents),
            symbol: "circle",
            symbolSize: 5,
            lineStyle: { width: 2.2, color: t.ink },
            itemStyle: { color: t.ink },
            z: 5,
            // Year dividers like Monarch's "← 2025 | 2026 →".
            markLine:
              interval === "year"
                ? undefined
                : {
                    silent: true,
                    symbol: "none",
                    lineStyle: { color: t.line, type: "solid", width: 1 },
                    label: { position: "end", color: t.muted, fontSize: 11, formatter: (m: any) => `← ${Number(m.name) - 1}   ${m.name} →` },
                    data: periods.flatMap((p, i) => (i > 0 && p.start.slice(0, 4) !== periods[i - 1]!.start.slice(0, 4) ? [{ xAxis: i - 0.5, name: p.start.slice(0, 4) }] : [])),
                  },
          },
        ],
      };
    },
    [periods, interval, selected],
  );
  return <Chart option={option} class={height} onClick={onSelect ? (p) => p.dataIndex !== undefined && onSelect(p.dataIndex) : undefined} />;
}

/** Sankey of income categories -> income -> expense categories (plus savings or deficit). */
export function FlowSankey({ from, to }: { from: string | null; to: string | null }) {
  const scope = useScope();
  const { data, loading } = useApi(`/reports/cashflow${qs({ from: from ?? "1900-01-01", to: to ?? today(), depth: 3, ...scope.q })}`, [scope.key, from, to]);
  const option = useCallback(
    (t: Theme) => {
      const color = (kind: string, i: number) => (kind === "income" ? t.in : kind === "hub" ? t.accent : kind === "savings" ? t.accent : kind === "deficit" ? t.out : t.palette[(i % (t.palette.length - 1)) + 1]);
      return {
        tooltip: { trigger: "item", valueFormatter: (v: number) => money(v) },
        series: [
          {
            type: "sankey",
            left: 4,
            right: 150,
            top: 10,
            bottom: 10,
            nodeWidth: 12,
            nodeGap: 9,
            draggable: false,
            emphasis: { focus: "adjacency" },
            lineStyle: { color: "gradient", curveness: 0.5, opacity: t.dark ? 0.35 : 0.28 },
            label: { color: t.ink, fontSize: 12, formatter: (p: any) => `${p.data.label}  ${compact(p.value)}` },
            data: (data?.nodes ?? []).map((n: any, i: number) => ({ name: n.id, label: n.kind === "income" || n.kind === "expense" ? `${categoryMeta(n.id).emoji} ${n.label.split(" / ").pop()}` : n.label, itemStyle: { color: color(n.kind, i), borderWidth: 0 } })),
            links: (data?.links ?? []).map((l: any) => ({ source: l.source, target: l.target, value: l.value_cents })),
          },
        ],
      };
    },
    [data],
  );
  if (loading || !data) return <Loading h={380} />;
  if (data.links.length === 0) return <div class="empty">No income or spending in this period</div>;
  return <Chart option={option} class="chart xtall" />;
}

/** Donut with a Monarch-style legend grid beside it. */
export function Donut({ items, total, label }: { items: Slice[]; total: number; label: string }) {
  const top = items.slice(0, 11);
  const rest = items.slice(11).reduce((s, i) => s + i.cents, 0);
  const data = rest > 0 ? [...top, { key: "Other", text: "Other", cents: rest, label: "Other" } as Slice] : top;
  const option = useCallback(
    (t: Theme) => ({
      tooltip: { trigger: "item", valueFormatter: (v: number) => money(v) },
      series: [
        {
          type: "pie",
          radius: ["68%", "92%"],
          padAngle: 1,
          itemStyle: { borderRadius: 4, borderColor: t.surface, borderWidth: 1 },
          label: { show: false },
          data: data.map((s) => ({ name: s.text, value: Math.max(0, s.cents) })),
        },
      ],
    }),
    [items],
  );
  const theme = ["--c0", "--c1", "--c2", "--c3", "--c4", "--c5", "--c6", "--c7"];
  if (items.length === 0) return <div class="empty">Nothing in this period</div>;
  return (
    <div class="donut-wrap">
      <div class="donut">
        <Chart option={option} class="chart donut-chart" />
        <div class="donut-center">
          <div class="num donut-total">{money(total)}</div>
          <div class="muted small">{label}</div>
        </div>
      </div>
      <div class="legend-grid">
        {data.map((s, i) => (
          <div class="legend-item">
            <span class="legend-dot" style={{ background: i < 9 ? `var(${theme[i % theme.length]}, #888)` : "var(--muted)" }} />
            <div>
              <div class="legend-name">{s.label}</div>
              <div class="num legend-amt">
                {money(s.cents)} <span class="muted">({total ? ((s.cents / total) * 100).toFixed(1) : 0}%)</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Stacked bars of the top categories per period. */
export function StackBars({ periods, interval, stack, tone }: { periods: FlowPeriod[]; interval: Interval; stack: { keys: string[]; values: number[][] }; tone: "in" | "out" }) {
  const option = useCallback(
    (t: Theme) => ({
      grid: { left: 4, right: 10, top: 40, bottom: 0, containLabel: true },
      legend: { top: 0, left: 0, itemWidth: 10, itemHeight: 10, icon: "circle", textStyle: { color: t.muted } },
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: (v: number) => money(v) },
      xAxis: { type: "category", data: periods.map((p) => periodLabel(p.start, interval)), ...axis(t) },
      yAxis: valueAxis(t),
      series: stack.keys.map((k, i) => ({
        name: k === "Other" ? "Other" : `${categoryMeta(k).emoji} ${k.split(":").pop()}`,
        type: "bar",
        stack: "s",
        barMaxWidth: 42,
        data: stack.values[i],
        itemStyle: { borderRadius: i === stack.keys.length - 1 ? [5, 5, 0, 0] : 0, color: k === "Other" ? t.muted : undefined },
      })),
      color: tone === "in" ? [t.in, ...t.palette.slice(1)] : t.palette,
    }),
    [periods, stack],
  );
  return <Chart option={option} class="chart tall" />;
}

/** Tiny line for account rows. */
export function Spark({ values, tone }: { values: number[]; tone?: "in" | "out" | undefined }) {
  if (values.length < 2) return <svg class="spark" />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(1)},${(28 - ((v - min) / span) * 24).toFixed(1)}`).join(" ");
  const up = values.at(-1)! >= values[0]!;
  return (
    <svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden>
      <polyline points={pts} fill="none" stroke={`var(--${tone ?? (up ? "in" : "out")})`} stroke-width="1.8" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
    </svg>
  );
}

// ---- transactions in a period -------------------------------------------------

/** Recent transactions of one kind in [from, to], grouped by day like Activity. */
export function PeriodTransactions({ from, to, kind }: { from: string | null; to: string | null; kind: "income" | "expense" }) {
  const { keep, keepCategory } = useScope();
  const [limit, setLimit] = useState(60);
  const { data, loading } = useApi(`/transactions${qs({ from, to, limit: 1000 })}`, [from, to]);
  if (loading || !data) return <Loading h={300} />;
  const re = kind === "income" ? /^Income:/ : /^Expenses:/;
  const rows = (data.transactions as any[])
    .map((t) => {
      const ps = t.postings.filter((p: any) => re.test(p.account) && keep(p.entity) && keepCategory(p.account));
      return ps.length ? { t, cat: ps[0].account as string, cents: ps.reduce((s: number, p: any) => s + p.amount_cents, 0) * (kind === "income" ? -1 : 1) } : null;
    })
    .filter((x): x is { t: any; cat: string; cents: number } => x !== null);
  if (rows.length === 0) return <div class="empty">No {kind === "income" ? "income" : "spending"} in this period</div>;
  const days: Array<[string, typeof rows]> = [];
  for (const r of rows.slice(0, limit)) {
    const last = days.at(-1);
    if (last && last[0] === r.t.date) last[1].push(r);
    else days.push([r.t.date, [r]]);
  }
  return (
    <div class="ptx">
      {days.map(([d, rs]) => (
        <>
          <div class="ptx-day">
            <span>{dayLabel(d)}</span>
            <span class="num">{money(rs.reduce((s, r) => s + r.cents, 0))}</span>
          </div>
          {rs.map((r) => (
            <button class="ptx-row" onClick={() => go(`/transactions?id=${r.t.wmma_id}`)}>
              <span class="ptx-payee">
                <Avatar name={r.t.payee} />
                <span>{r.t.payee}</span>
              </span>
              <span class="ptx-cat hide-sm">
                <CatName account={r.cat} />
              </span>
              <span class={`num ptx-amt ${kind === "income" ? "in" : ""}`}>{kind === "income" ? `+${money(r.cents)}` : money(r.cents)}</span>
              <span class="muted" style={{ display: "inline-flex" }}>
                <Icon.chevron />
              </span>
            </button>
          ))}
        </>
      ))}
      {rows.length > limit && (
        <button class="linkbtn" onClick={() => setLimit(limit + 100)}>
          Show more ({rows.length - limit} left)
        </button>
      )}
    </div>
  );
}
