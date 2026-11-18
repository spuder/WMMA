/** API client. Tailscale Serve adds the identity headers; the browser just calls /api/v1. */
import { useEffect, useState } from "preact/hooks";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: init.method ?? (init.body !== undefined || init.form ? "POST" : "GET"),
    headers: init.body !== undefined ? { "content-type": "application/json" } : {},
    body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : null),
    credentials: "same-origin",
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON error page
  }
  if (!res.ok) throw new ApiError(data?.error ?? `HTTP ${res.status}`, res.status);
  return data as T;
}

/** Fetch on mount and whenever `deps` change. */
export function useApi<T = any>(path: string | null, deps: unknown[] = []): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    api<T>(path)
      .then((data) => live && setState({ data, error: null, loading: false }))
      .catch((e: Error) => live && setState({ data: null, error: e.message, loading: false }));
    return () => {
      live = false;
    };
  }, [path, tick, ...deps]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
export const money = (cents: number, whole = false) => (whole ? usd0 : usd).format(cents / 100);
export const compact = (cents: number) => {
  const v = Math.abs(cents / 100);
  const s = v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${Math.round(v / 1e3)}k` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v.toFixed(0);
  return `${cents < 0 ? "-" : ""}$${s}`;
};

/** "Expenses:Food:Groceries" -> "Groceries"; with group -> "Food / Groceries" */
/** Monarch's names for the common income categories (the accounts keep their names). */
const DISPLAY_NAMES: Record<string, string> = {
  "Income:Salary": "Paychecks",
  "Income:Other": "Other Income",
  "Income:Dividends": "Dividends & Capital Gains",
  "Income:BusinessIncome": "Business Income",
  "Income:Uncategorized": "Uncategorized Income",
};
export const leaf = (account: string) => DISPLAY_NAMES[account] ?? humanize(account.split(":").pop() ?? account);
export const catLabel = (account: string) => DISPLAY_NAMES[account] ?? (account.split(":").slice(1).map(humanize).join(" / ") || account);
export const humanize = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");

export const today = () => new Date().toISOString().slice(0, 10);
export const thisMonth = () => today().slice(0, 7);
export function monthShift(m: string, n: number): string {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, mo - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
export const monthStart = (m: string) => `${m}-01`;
export function monthEnd(m: string): string {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
}
export const monthName = (m: string, opts: Intl.DateTimeFormatOptions = { month: "short" }) =>
  new Date(`${m}-15T00:00:00Z`).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
export const dayLabel = (d: string) => {
  const t = today();
  const y = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  if (d === t) return "Today";
  if (d === y) return "Yesterday";
  return new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC", ...(d.slice(0, 4) !== t.slice(0, 4) ? { year: "numeric" } : {}) });
};

export function initials(s: string): string {
  const w = s.replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/);
  return ((w[0]?.[0] ?? "?") + (w[1]?.[0] ?? "")).toUpperCase();
}

/** Stable pastel-ish hue per string for avatars. */
export function hue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

export const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(`wmma.${k}`);
    } catch {
      return null;
    }
  },
  set(k: string, v: string | null) {
    try {
      if (v === null) localStorage.removeItem(`wmma.${k}`);
      else localStorage.setItem(`wmma.${k}`, v);
    } catch {
      // private mode
    }
  },
};

// ---- Category icons & groups ------------------------------------------------

/** Picker group order; categories land in a group via CATEGORY_RULES. */
export const CATEGORY_GROUPS = [
  "Income",
  "Food & Dining",
  "Housing",
  "Bills & Utilities",
  "Auto & Transport",
  "Travel & Lifestyle",
  "Shopping",
  "Children",
  "Education",
  "Health & Wellness",
  "Gifts & Donations",
  "Financial",
  "Business",
  "Other",
  "Transfers",
] as const;
export type CategoryGroup = (typeof CATEGORY_GROUPS)[number];

/** First match wins, tested against the humanized, lower-cased account path. */
const CATEGORY_RULES: Array<[top: "Income" | "Expenses" | "*", pattern: RegExp, emoji: string, group: CategoryGroup]> = [
  ["*", /uncategori[sz]ed/, "❓", "Other"],
  ["*", /credit card payment/, "💳", "Transfers"],
  ["*", /transfer/, "🔄", "Transfers"],
  ["Income", /salary|paycheck|payroll|wages/, "💵", "Income"],
  ["Income", /dividend|capital gain/, "📈", "Income"],
  ["Income", /interest/, "💸", "Income"],
  ["Income", /\brent/, "🏠", "Income"],
  ["Income", /refund|reimburse/, "↩️", "Income"],
  ["Income", /business income/, "💰", "Income"],
  ["Income", /gross receipts|business|sales/, "💼", "Income"],
  ["Income", /./, "💰", "Income"],
  ["Expenses", /grocer/, "🍏", "Food & Dining"],
  ["Expenses", /coffee/, "☕", "Food & Dining"],
  ["Expenses", /dining|restaurant|bars/, "🍽️", "Food & Dining"],
  ["Expenses", /food/, "🍔", "Food & Dining"],
  ["Expenses", /insurance/, "☂️", "Financial"],
  ["Expenses", /rent property|office rent/, "🏢", "Business"],
  ["Expenses", /mortgage/, "🏡", "Housing"],
  ["Expenses", /electric|power/, "⚡", "Bills & Utilities"],
  ["Expenses", /water/, "💧", "Bills & Utilities"],
  ["Expenses", /garbage|trash/, "🗑️", "Bills & Utilities"],
  ["Expenses", /internet|cable/, "🌐", "Bills & Utilities"],
  ["Expenses", /phone|mobile/, "📱", "Bills & Utilities"],
  ["Expenses", /utilit/, "💡", "Bills & Utilities"],
  ["Expenses", /subscription|streaming/, "🔁", "Bills & Utilities"],
  ["Expenses", /\brent\b/, "🏠", "Housing"],
  ["Expenses", /repair|maintenance|home improvement/, "🔨", "Housing"],
  ["Expenses", /housing|home/, "🏡", "Housing"],
  ["Expenses", /fuel|gasoline/, "⛽", "Auto & Transport"],
  ["Expenses", /parking|toll/, "🅿️", "Auto & Transport"],
  ["Expenses", /taxi|ride ?share|uber|lyft/, "🚕", "Auto & Transport"],
  ["Expenses", /transit|\btrain\b|\bbus\b/, "🚆", "Auto & Transport"],
  ["Expenses", /\bauto\b|\bcars?\b|vehicle|transport/, "🚗", "Auto & Transport"],
  ["Expenses", /travel|vacation|airfare|hotel|lodging/, "✈️", "Travel & Lifestyle"],
  ["Expenses", /entertainment|recreation|movies|games/, "🎬", "Travel & Lifestyle"],
  ["Expenses", /\bpets?\b/, "🐶", "Travel & Lifestyle"],
  ["Expenses", /fun money|personal care|hobb/, "😜", "Travel & Lifestyle"],
  ["Expenses", /clothing|apparel/, "👕", "Shopping"],
  ["Expenses", /electronics|computer|software/, "💻", "Shopping"],
  ["Expenses", /furniture|housewares/, "🪑", "Shopping"],
  ["Expenses", /shopping/, "🛍️", "Shopping"],
  ["Expenses", /child ?care|daycare|babysit/, "👶", "Children"],
  ["Expenses", /\bchild|\bkids\b/, "⚽", "Children"],
  ["Expenses", /student loan/, "🎓", "Education"],
  ["Expenses", /education|tuition|school|books/, "🏫", "Education"],
  ["Expenses", /\bdent(ist|al)/, "🦷", "Health & Wellness"],
  ["Expenses", /fitness|gym/, "💪", "Health & Wellness"],
  ["Expenses", /health|medical|doctor|pharmacy/, "💊", "Health & Wellness"],
  ["Expenses", /charit|donation/, "🎗️", "Gifts & Donations"],
  ["Expenses", /gift/, "🎁", "Gifts & Donations"],
  ["Expenses", /advertis|marketing|promotion/, "📣", "Business"],
  ["Expenses", /cost of goods|inventory/, "📦", "Business"],
  ["Expenses", /postage|shipping/, "📮", "Business"],
  ["Expenses", /depreciation|depletion|amorti/, "📉", "Business"],
  ["Expenses", /bad debt/, "🧾", "Business"],
  ["Expenses", /employee benefit|health plan/, "🩺", "Business"],
  ["Expenses", /officer|owner comp/, "👔", "Business"],
  ["Expenses", /wages|payroll|contract labor|contractor/, "👷", "Business"],
  ["Expenses", /pension|retirement|401k/, "🏖️", "Business"],
  ["Expenses", /office|supplies/, "📎", "Business"],
  ["Expenses", /legal|professional|accounting/, "⚖️", "Business"],
  ["Expenses", /business|commission/, "💼", "Business"],
  ["Expenses", /tax/, "🏛️", "Financial"],
  ["Expenses", /cash|atm/, "🏧", "Financial"],
  ["Expenses", /loan/, "💰", "Financial"],
  ["Expenses", /fee|bank charge/, "🏦", "Financial"],
  ["Expenses", /interest/, "💳", "Financial"],
  ["Expenses", /misc|other/, "💲", "Other"],
];

const categoryMetaCache = new Map<string, { emoji: string; group: CategoryGroup }>();

/** Emoji and picker group for a category account such as "Expenses:Food:Groceries". */
export function categoryMeta(account: string): { emoji: string; group: CategoryGroup } {
  const cached = categoryMetaCache.get(account);
  if (cached) return cached;
  const [top = ""] = account.split(":");
  const path = account.split(":").map(humanize).join(" ").toLowerCase();
  const hit = CATEGORY_RULES.find(([t, re]) => (t === "*" || t === top) && re.test(path));
  const meta = hit
    ? { emoji: hit[2], group: hit[3] }
    : top === "Income"
      ? { emoji: "💰", group: "Income" as const }
      : top === "Equity"
        ? { emoji: "⚖️", group: "Transfers" as const }
        : { emoji: "🏷️", group: "Other" as const };
  categoryMetaCache.set(account, meta);
  return meta;
}
export const catEmoji = (account: string) => categoryMeta(account).emoji;
