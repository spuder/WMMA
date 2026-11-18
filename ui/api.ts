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
export const leaf = (account: string) => humanize(account.split(":").pop() ?? account);
export const catLabel = (account: string) => account.split(":").slice(1).map(humanize).join(" / ") || account;
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
