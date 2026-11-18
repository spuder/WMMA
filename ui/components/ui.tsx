import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { catLabel, hue, initials } from "../api";

const P = { fill: "none", stroke: "currentColor", "stroke-width": 1.9, "stroke-linecap": "round", "stroke-linejoin": "round" } as const;
export const Icon = {
  home: () => <svg viewBox="0 0 24 24" {...P}><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" /></svg>,
  list: () => <svg viewBox="0 0 24 24" {...P}><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></svg>,
  swipe: () => <svg viewBox="0 0 24 24" {...P}><rect x="5" y="3" width="14" height="18" rx="3" /><path d="m9.5 12 2 2 3.5-4" /></svg>,
  chart: () => <svg viewBox="0 0 24 24" {...P}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>,
  more: () => <svg viewBox="0 0 24 24" {...P}><circle cx="5" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="19" cy="12" r="1.3" /></svg>,
  bank: () => <svg viewBox="0 0 24 24" {...P}><path d="M3 10h18L12 4zM5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18" /></svg>,
  upload: () => <svg viewBox="0 0 24 24" {...P}><path d="M12 16V4M7 9l5-5 5 5M4 20h16" /></svg>,
  gear: () => <svg viewBox="0 0 24 24" {...P}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>,
  check: () => <svg viewBox="0 0 24 24" {...P} stroke-width="2.6"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>,
  x: () => <svg viewBox="0 0 24 24" {...P} stroke-width="2.6"><path d="M6 6l12 12M18 6 6 18" /></svg>,
  search: () => <svg viewBox="0 0 24 24" {...P}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>,
  chevron: () => <svg viewBox="0 0 24 24" {...P} width="16" height="16"><path d="m9 6 6 6-6 6" /></svg>,
  down: () => <svg viewBox="0 0 24 24" {...P} width="14" height="14"><path d="m6 9 6 6 6-6" /></svg>,
  logo: () => (
    <svg viewBox="0 0 32 32" width="28" height="28">
      <rect width="32" height="32" rx="9" fill="var(--accent)" />
      <path d="M8 21l4-9 4 6 4-8 4 11" fill="none" stroke="var(--accent-ink)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  ),
};

export function Avatar({ name }: { name: string }) {
  const h = hue(name);
  return (
    <div class="avatar hued" style={{ "--h": String(h) }} aria-hidden>
      {initials(name)}
    </div>
  );
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: string; children: ComponentChildren }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open]);
  if (!open) return null;
  return (
    <>
      <div class="scrim" onClick={onClose} />
      <div class="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div class="grab" />
        {title && (
          <div class="spread" style={{ marginBottom: 8 }}>
            <strong style={{ fontSize: 17 }}>{title}</strong>
            <button class="btn ghost" onClick={onClose} aria-label="Close" style={{ height: 34, padding: "0 8px" }}>
              <span style={{ width: 20, height: 20, display: "inline-flex" }}>
                <Icon.x />
              </span>
            </button>
          </div>
        )}
        <div class="sheet-body">{children}</div>
      </div>
    </>
  );
}

let toastSetter: ((m: string | null) => void) | null = null;
export function toast(m: string) {
  toastSetter?.(m);
}
export function Toaster() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    toastSetter = setMsg;
    return () => {
      toastSetter = null;
    };
  }, []);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 3200);
    return () => clearTimeout(t);
  }, [msg]);
  return msg ? (
    <div class="toast" role="status">
      {msg}
    </div>
  ) : null;
}

export function Loading({ h = 120 }: { h?: number }) {
  return <div class="skeleton" style={{ height: h }} />;
}

export function ErrorBox({ error }: { error: string }) {
  return <div class="error">{error === "missing Tailscale identity" ? "Open WMMA through Tailscale (no identity on this request)." : error}</div>;
}

/** Searchable category picker; `suggested` floats Jev's picks to the top with probabilities. */
export function CategoryPicker({
  categories,
  suggested = [],
  onPick,
  direction,
}: {
  categories: string[];
  suggested?: Array<{ account: string; probability: number }>;
  onPick: (account: string) => void;
  direction?: "in" | "out";
}) {
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const ql = q.toLowerCase();
    const list = categories
      .filter((c) => !direction || (direction === "out" ? c.startsWith("Expenses:") : true))
      .filter((c) => !ql || c.toLowerCase().includes(ql) || catLabel(c).toLowerCase().includes(ql));
    const g = new Map<string, string[]>();
    for (const c of list) {
      const [top, second] = c.split(":");
      const key = `${top === "Income" ? "Income" : "Expenses"}${second && c.split(":").length > 2 ? ` · ${second.replace(/([a-z])([A-Z])/g, "$1 $2")}` : ""}`;
      g.set(key, [...(g.get(key) ?? []), c]);
    }
    return [...g].sort((a, b) => a[0].localeCompare(b[0]));
  }, [categories, q, direction]);
  return (
    <div class="stack" style={{ gap: 10 }}>
      <div class="search">
        <Icon.search />
        <input class="input" placeholder="Search categories" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} autoFocus={matchMedia("(min-width: 700px)").matches} />
      </div>
      {suggested.length > 0 && !q && (
        <div>
          <div class="upper catgroup">Suggested</div>
          {suggested.map((s) => (
            <button class="catbtn" onClick={() => onPick(s.account)}>
              <span>{catLabel(s.account)}</span>
              <span class="p">{Math.round(s.probability * 100)}%</span>
            </button>
          ))}
        </div>
      )}
      <div class="catlist">
        {groups.map(([g, list]) => (
          <div>
            <div class="upper catgroup">{g}</div>
            {list.map((c) => (
              <button class="catbtn" onClick={() => onPick(c)}>
                <span>{catLabel(c)}</span>
                <span class="muted" style={{ display: "inline-flex" }}>
                  <Icon.chevron />
                </span>
              </button>
            ))}
          </div>
        ))}
        {groups.length === 0 && <div class="empty">No matching categories</div>}
      </div>
    </div>
  );
}
