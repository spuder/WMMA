import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { CATEGORY_GROUPS, catLabel, categoryMeta, hue, initials } from "../api";

const P = { fill: "none", stroke: "currentColor", "stroke-width": 1.9, "stroke-linecap": "round", "stroke-linejoin": "round" } as const;
export const Icon = {
  home: () => <svg viewBox="0 0 24 24" {...P}><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" /></svg>,
  list: () => <svg viewBox="0 0 24 24" {...P}><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></svg>,
  swipe: () => <svg viewBox="0 0 24 24" {...P}><rect x="5" y="3" width="14" height="18" rx="3" /><path d="m9.5 12 2 2 3.5-4" /></svg>,
  chart: () => <svg viewBox="0 0 24 24" {...P}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>,
  more: () => <svg viewBox="0 0 24 24" {...P}><circle cx="5" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="19" cy="12" r="1.3" /></svg>,
  bank: () => <svg viewBox="0 0 24 24" {...P}><path d="M3 10h18L12 4zM5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18" /></svg>,
  folder: () => <svg viewBox="0 0 24 24" {...P}><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" /><path d="M3 9h18" /></svg>,
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

export function Sheet({ open, onClose, title, children, side = false }: { open: boolean; onClose: () => void; title?: string; children: ComponentChildren; side?: boolean }) {
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
      <div class={`sheet${side ? " side" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
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
  return <div class="skeleton" style={{ height: h }} role="status" aria-label="Loading" />;
}

export function ErrorBox({ error }: { error: string }) {
  return <div class="error">{error === "missing Tailscale identity" ? "Open WMMA through Tailscale (no identity on this request)." : error}</div>;
}

/** Searchable category picker; `suggested` floats Jev's picks to the top with probabilities. */
/**
 * An inline cell that opens an animated dropdown in place (table rows on wide
 * screens). It flips upward or right-aligns when it would run off the viewport.
 */
export function CellMenu({
  label,
  value,
  children,
  width = 320,
  flash = false,
}: {
  label: string;
  value: ComponentChildren;
  children: (close: () => void) => ComponentChildren;
  width?: number;
  flash?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({ up: false, right: false });
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const toggle = () => {
    if (!open && ref.current) {
      const r = ref.current.getBoundingClientRect();
      const below = window.innerHeight - r.bottom;
      setPlace({ up: below < 400 && r.top > below, right: r.left + width > window.innerWidth - 16 });
    }
    setOpen((o) => !o);
  };
  return (
    <div class={`cellmenu${open ? " open" : ""}`} ref={ref} onClick={(e) => e.stopPropagation()}>
      <button class={`cellmenu-btn${flash ? " flash" : ""}`} aria-haspopup="dialog" aria-expanded={open} aria-label={label} onClick={toggle}>
        <span class="cellmenu-value">{value}</span>
        <Icon.down />
      </button>
      {open && (
        <div class={`cellmenu-pop${place.up ? " up" : ""}${place.right ? " right" : ""}`} style={{ width }} role="dialog" aria-label={label}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** One choice inside a CellMenu; options cascade in. */
export function MenuOption({ selected = false, index = 0, onClick, children }: { selected?: boolean; index?: number; onClick: () => void; children: ComponentChildren }) {
  return (
    <button class={`menu-opt${selected ? " on" : ""}`} style={{ animationDelay: `${Math.min(index, 12) * 18}ms` }} onClick={onClick}>
      {children}
      {selected && (
        <span class="menu-check">
          <Icon.check />
        </span>
      )}
    </button>
  );
}

/** A category with its emoji, e.g. "🍏 Food / Groceries". */
export function CatName({ account, label }: { account: string; label?: string }) {
  return (
    <span class="catname">
      <span class="cat-emoji" aria-hidden="true">
        {categoryMeta(account).emoji}
      </span>
      <span class="catname-text">{label ?? catLabel(account)}</span>
    </span>
  );
}

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
      .filter((c) => !ql || c.toLowerCase().includes(ql) || catLabel(c).toLowerCase().includes(ql) || categoryMeta(c).group.toLowerCase().includes(ql));
    const g = new Map<string, string[]>();
    for (const c of list) {
      const key = categoryMeta(c).group;
      g.set(key, [...(g.get(key) ?? []), c]);
    }
    const order = (k: string) => CATEGORY_GROUPS.indexOf(k as (typeof CATEGORY_GROUPS)[number]);
    return [...g]
      .map(([k, cs]) => [k, cs.sort((a, b) => catLabel(a).localeCompare(catLabel(b)))] as [string, string[]])
      .sort((a, b) => order(a[0]) - order(b[0]));
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
              <CatName account={s.account} />
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
                <CatName account={c} />
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
