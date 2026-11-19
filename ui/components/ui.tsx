import type { ComponentChildren } from "preact";
import { createPortal } from "preact/compat";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { CATEGORY_GROUPS, catLabel, categoryMeta, hue, initials } from "../api";
import { fuzzyMatch } from "../fuzzy";
import { GLYPH_EMOJI, logoUrl, usePayeeLogo, type Logo } from "../logos";

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
  clock: () => <svg viewBox="0 0 24 24" {...P}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>,
  bars: () => <svg viewBox="0 0 24 24" {...P}><path d="M5 20v-6M10 20V8M15 20v-9M20 20V5" /></svg>,
  pie: () => <svg viewBox="0 0 24 24" {...P}><path d="M12 3a9 9 0 1 0 9 9h-9z" /><path d="M15 3.5A9 9 0 0 1 20.5 9H15z" /></svg>,
  map: () => <svg viewBox="0 0 24 24" {...P}><path d="m3 6 6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14" /></svg>,
  calendar: () => <svg viewBox="0 0 24 24" {...P}><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>,
  trend: () => <svg viewBox="0 0 24 24" {...P}><path d="m3 17 6-6 4 4 8-8M15 7h6v6" /></svg>,
  layers: () => <svg viewBox="0 0 24 24" {...P}><path d="m12 3 9 5-9 5-9-5zM3 13l9 5 9-5" /></svg>,
  compass: () => <svg viewBox="0 0 24 24" {...P}><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5z" /></svg>,
  download: () => <svg viewBox="0 0 24 24" {...P}><path d="M12 4v11M7 10l5 5 5-5M4 20h16" /></svg>,
  filter: () => <svg viewBox="0 0 24 24" {...P}><path d="M4 6h16M7 12h10M10 18h4" /></svg>,
  refresh: () => <svg viewBox="0 0 24 24" {...P}><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4" /></svg>,
  plus: () => <svg viewBox="0 0 24 24" {...P} stroke-width="2.2"><path d="M12 5v14M5 12h14" /></svg>,
  logo: () => (
    <svg viewBox="0 0 32 32" width="28" height="28">
      <rect width="32" height="32" rx="9" fill="var(--accent)" />
      <path d="M8 21l4-9 4 6 4-8 4 11" fill="none" stroke="var(--accent-ink)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  ),
};

/**
 * A payee's or account's logo, falling back to coloured initials. Without `logo`, the
 * payee's logo is looked up by name; pass `logo` (or null) for accounts.
 */
export function Avatar({ name, logo, onClick, label }: { name: string; logo?: Logo; onClick?: () => void; label?: string }) {
  const byPayee = usePayeeLogo(logo === undefined ? name : null);
  const l = logo === undefined ? byPayee : logo;
  // A site known to have no icon keeps its website but shows initials.
  const domain = l && "domain" in l && !l.missing ? l.domain : null;
  // Icons under 48px are shown at their own size rather than blown up and blurry.
  const src = domain && l && "domain" in l ? logoUrl(domain, l.v) : null;
  const [img, setImg] = useState<{ src: string; state: "ok" | "small" | "error" } | null>(null);
  const state = img && img.src === src ? img.state : "loading";
  // Clickable avatars are buttons; plain ones are decoration.
  const Tag = onClick ? "button" : "div";
  const a11y = onClick ? { type: "button" as const, onClick, "aria-label": label ?? name, title: label } : { "aria-hidden": true };
  if (l && "glyph" in l && GLYPH_EMOJI[l.glyph]) {
    return (
      <Tag class={`avatar glyph${onClick ? " clickable" : ""}`} {...a11y}>
        {GLYPH_EMOJI[l.glyph]}
      </Tag>
    );
  }
  const shown = src !== null && (state === "ok" || state === "small");
  return (
    <Tag class={`${shown ? `avatar logo${state === "small" ? " small" : ""}` : "avatar hued"}${onClick ? " clickable" : ""}`} style={shown ? undefined : { "--h": String(hue(name)) }} {...a11y}>
      {!shown && initials(name)}
      {src && state !== "error" && (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          class={shown ? undefined : "pending"}
          onLoad={(e) => setImg({ src, state: (e.currentTarget as HTMLImageElement).naturalWidth < 48 ? "small" : "ok" })}
          onError={() => setImg({ src, state: "error" })}
        />
      )}
    </Tag>
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
  // Portal to <body>: an ancestor with backdrop-filter/transform (e.g. .topbar) would otherwise become the
  // containing block for the fixed-position sheet, centering and clipping it inside that ancestor.
  return createPortal(
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
    </>,
    document.body,
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
  tool = false,
}: {
  label: string;
  value: ComponentChildren;
  children: (close: () => void) => ComponentChildren;
  width?: number;
  flash?: boolean;
  /** Toolbar look: always bordered, sized like a button. */
  tool?: boolean;
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
      // Right-align only when opening rightward would overflow and leftward fits; toolbar menus on the left must not slide under the sidebar.
      const minLeft = (document.querySelector(".sidebar")?.getBoundingClientRect().right ?? 0) + 16;
      setPlace({ up: below < 400 && r.top > below, right: r.left + width > window.innerWidth - 16 && r.right - width >= minLeft });
    }
    setOpen((o) => !o);
  };
  return (
    <div class={`cellmenu${open ? " open" : ""}${tool ? " tool" : ""}`} ref={ref} onClick={(e) => e.stopPropagation()}>
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
export function CatName({ account, label }: { account: string; label?: ComponentChildren }) {
  return (
    <span class="catname">
      <span class="cat-emoji" aria-hidden="true">
        {categoryMeta(account).emoji}
      </span>
      <span class="catname-text">{label ?? catLabel(account)}</span>
    </span>
  );
}

/** Mouse or trackpad (desktop): focus search fields straight away. Touch devices skip it so the on-screen keyboard doesn't pop up. */
const finePointer = () => matchMedia("(pointer: fine)").matches;

/** Text with fuzzy-matched characters highlighted. */
function Highlight({ text, indices }: { text: string; indices: number[] }) {
  if (!indices.length) return <>{text}</>;
  const set = new Set(indices);
  const out: ComponentChildren[] = [];
  let run = "";
  let on = false;
  for (let i = 0; i <= text.length; i++) {
    const hit = set.has(i);
    if (i === text.length || hit !== on) {
      if (run) out.push(on ? <mark class="fz">{run}</mark> : run);
      run = "";
      on = hit;
    }
    if (i < text.length) run += text[i];
  }
  return <>{out}</>;
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
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Desktop: start typing immediately.
  useEffect(() => {
    if (finePointer()) input.current?.focus({ preventScroll: true });
  }, []);

  const pool = useMemo(() => categories.filter((c) => !direction || (direction === "out" ? c.startsWith("Expenses:") : true)), [categories, direction]);

  /** Ranked fuzzy matches on the label (highlighted) or, more weakly, the group and full path. */
  const results = useMemo(() => {
    if (!q.trim()) return [];
    return pool
      .map((c) => {
        const label = catLabel(c);
        const onLabel = fuzzyMatch(q, label);
        const onGroup = fuzzyMatch(q, categoryMeta(c).group);
        const onPath = fuzzyMatch(q, c);
        const score = Math.max(onLabel?.score ?? -Infinity, (onGroup?.score ?? -Infinity) * 0.6, (onPath?.score ?? -Infinity) * 0.5);
        return score === -Infinity ? null : { c, label, score, indices: onLabel?.indices ?? [] };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  }, [pool, q]);

  const groups = useMemo(() => {
    const g = new Map<string, string[]>();
    for (const c of pool) {
      const key = categoryMeta(c).group;
      g.set(key, [...(g.get(key) ?? []), c]);
    }
    const order = (k: string) => CATEGORY_GROUPS.indexOf(k as (typeof CATEGORY_GROUPS)[number]);
    return [...g]
      .map(([k, cs]) => [k, cs.sort((a, b) => catLabel(a).localeCompare(catLabel(b)))] as [string, string[]])
      .sort((a, b) => order(a[0]) - order(b[0]));
  }, [pool]);

  // Keyboard order: matches while searching, otherwise suggestions then every group.
  const ordered = q.trim() ? results.map((r) => r.c) : [...suggested.map((s) => s.account), ...groups.flatMap(([, cs]) => cs)];
  useEffect(() => setActive(q.trim() ? 0 : -1), [q]);
  useEffect(() => {
    listRef.current?.querySelector(".catbtn.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = ordered.length;
      if (!n) return;
      setActive((a) => (e.key === "ArrowDown" ? (a + 1) % n : a <= 0 ? n - 1 : a - 1));
    } else if (e.key === "Enter") {
      const pick = ordered[active < 0 ? 0 : active];
      if (pick && (q.trim() || active >= 0)) {
        e.preventDefault();
        onPick(pick);
      }
    }
  };
  let idx = 0;
  const btn = (c: string, body: ComponentChildren, trailing: ComponentChildren) => {
    const i = idx++;
    return (
      <button class={`catbtn${i === active ? " active" : ""}`} onClick={() => onPick(c)} onMouseMove={() => active !== i && setActive(i)}>
        {body}
        {trailing}
      </button>
    );
  };

  return (
    <div class="stack catpicker" style={{ gap: 10 }} ref={listRef}>
      <div class="search">
        <Icon.search />
        <input
          ref={input}
          class="input"
          placeholder="Type to search categories"
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          onKeyDown={onKey}
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          autoComplete="off"
          spellcheck={false}
        />
      </div>
      {q.trim() ? (
        <div class="catlist">
          {results.length > 0 && <div class="upper catgroup">{results.length === 1 ? "1 match" : `${results.length} matches`} · Enter to choose</div>}
          {results.map((r) =>
            btn(
              r.c,
              <CatName account={r.c} label={<Highlight text={r.label} indices={r.indices} />} />,
              <span class="muted tiny cathint">{categoryMeta(r.c).group}</span>,
            ),
          )}
          {results.length === 0 && <div class="empty">No categories match “{q.trim()}”</div>}
        </div>
      ) : (
        <>
          {suggested.length > 0 && (
            <div>
              <div class="upper catgroup">Suggested</div>
              {suggested.map((s) => btn(s.account, <CatName account={s.account} />, <span class="p">{Math.round(s.probability * 100)}%</span>))}
            </div>
          )}
          <div class="catlist">
            {groups.map(([g, list]) => (
              <div>
                <div class="upper catgroup">{g}</div>
                {list.map((c) =>
                  btn(
                    c,
                    <CatName account={c} />,
                    <span class="muted" style={{ display: "inline-flex" }}>
                      <Icon.chevron />
                    </span>,
                  ),
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
