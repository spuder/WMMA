/**
 * Swipe game for the review queue (SPEC §9): one card per transaction with
 * Jev's top pick. Swipe right = accept. Swipe left = decide later (the card
 * goes to the back of the deck). The middle button picks another category.
 * Newest transactions come first, so the milestones (today, this week, …)
 * clear one after another; accepts feed the 3-swipe rule learning on the server.
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, catLabel, dayLabel, leaf, money, useApi } from "../api";
import { Avatar, CategoryPicker, CatName, ErrorBox, Icon, Loading, Sheet, toast } from "../components/ui";
import { businessStyle, EntitySwitcher, go, useApp } from "../app";

interface Item {
  wmma_id: string;
  jev_choices: Array<{ account: string; probability: number }>;
  date: string;
  payee: string;
  amount_cents: number;
  account: string;
  entity: string | null;
  reason: string | null;
}

const THRESHOLD = 96;
/** Most transactions sent to Jev per "Ask Jev" tap, so one request stays reasonably short. */
const JEV_BATCH = 100;

/** Rolling windows, so each milestone contains the one before it. */
const MILESTONES = [
  { id: "today", label: "Today", days: 0, badge: "☀️" },
  { id: "week", label: "This week", days: 6, badge: "⭐" },
  { id: "2weeks", label: "2 weeks", days: 13, badge: "🌟" },
  { id: "month", label: "This month", days: 29, badge: "🏅" },
  { id: "quarter", label: "This quarter", days: 89, badge: "🥇" },
  { id: "year", label: "This year", days: 364, badge: "🏆" },
  { id: "all", label: "Everything", days: Infinity, badge: "👑" },
] as const;
type Milestone = (typeof MILESTONES)[number];

/** Local calendar date n days ago (not UTC: "today" must mean the user's today). */
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const within = (m: Milestone, date: string) => m.days === Infinity || date >= daysAgo(m.days);

/** Cards set aside with "later" stay at the back of the deck across reloads (this browser only). */
const LATER_KEY = "wmma.review.later";
const loadLater = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(LATER_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(-2000) : [];
  } catch {
    return [];
  }
};
const saveLater = (ids: string[]) => {
  try {
    localStorage.setItem(LATER_KEY, JSON.stringify(ids));
  } catch {
    // private mode etc.: later order just won't survive a reload
  }
};

export function Review() {
  const { entity, entities, categories, refreshReview } = useApp();
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Dates of everything sorted this session (including rule auto-sorts), for milestone progress. */
  const [sorted, setSorted] = useState<string[]>([]);
  const [learned, setLearned] = useState(0);
  const [later, setLater] = useState<string[]>(loadLater);
  const [streak, setStreak] = useState(0);
  const [celebrate, setCelebrate] = useState<{ title: string; badge: string; key: number } | null>(null);
  const [picker, setPicker] = useState(false);
  const [editingEntity, setEditingEntity] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState<{ dx: number; dy: number; active: boolean }>({ dx: 0, dy: 0, active: false });
  const [fly, setFly] = useState<"left" | "right" | "up" | null>(null);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  // The latest drag distance; read on release so a fast flick isn't lost to a pending render.
  const dxRef = useRef(0);

  const loadItems = () =>
    api<{ items: Item[] }>("/review?order=newest&limit=2000")
      .then((r) => setItems(r.items))
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void loadItems();
  }, []);
  const settings = useApi<{ jev: { configured: boolean } }>("/settings");
  const [asking, setAsking] = useState(false);
  /** Items that never got a Jev answer: queued before a key was set, or while Jev was down / out of credits. */
  const noSuggestion = (items ?? []).filter((i) => i.jev_choices.length === 0).length;
  const askJev = async () => {
    setAsking(true);
    try {
      const r = await api<{ considered: number; byRule: number; byJev: number; queued: number; errors: string[]; remaining?: number }>("/categorize", {
        body: { retry: true, limit: JEV_BATCH },
      });
      const done = r.byRule + r.byJev;
      if (r.errors.length) toast(`${r.errors[0]}${done ? ` · ${done} categorized before that` : ""}`);
      else toast([done ? `${done} categorized` : null, r.queued ? `${r.queued} now have suggestions` : null].filter(Boolean).join(" · ") || "Jev had nothing new to add");
      await loadItems();
      refreshReview();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setAsking(false);
    }
  };

  // Newest first; cards set aside for later go to the back, in the order they were set aside.
  const queue = useMemo(() => {
    const laterRank = new Map(later.map((id, i) => [id, i]));
    return (items ?? [])
      .filter((i) => !entity || i.entity === entity)
      .sort((a, b) => {
        const la = laterRank.get(a.wmma_id) ?? -1;
        const lb = laterRank.get(b.wmma_id) ?? -1;
        if (la !== lb) return la - lb;
        return b.date.localeCompare(a.date) || b.wmma_id.localeCompare(a.wmma_id);
      });
  }, [items, entity, later]);
  const card = queue[0];
  const top = card?.jev_choices[0];
  const entityName = (slug: string | null) => entities.find((e) => e.slug === slug)?.name ?? slug ?? "—";

  const tiers = useMemo(
    () =>
      MILESTONES.map((m) => {
        const left = queue.filter((i) => within(m, i.date)).length;
        const done = sorted.filter((d) => within(m, d)).length;
        return { ...m, left, done, total: left + done, cleared: left === 0 };
      }),
    [queue, sorted],
  );
  const current = tiers.find((t) => !t.cleared) ?? tiers[tiers.length - 1]!;

  // Celebrate each milestone the moment it's cleared during this session.
  const clearedBefore = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!items) return;
    const now = new Set(tiers.filter((t) => t.cleared && t.total > 0).map((t) => t.id));
    if (clearedBefore.current) {
      const fresh = tiers.filter((t) => now.has(t.id) && !clearedBefore.current!.has(t.id) && t.done > 0);
      const biggest = fresh[fresh.length - 1];
      if (biggest) {
        const key = Date.now();
        setCelebrate({ title: biggest.id === "all" ? "Inbox zero" : `${biggest.label} cleared`, badge: biggest.badge, key });
        navigator.vibrate?.([30, 40, 60, 40, 90]);
        setTimeout(() => setCelebrate((c) => (c?.key === key ? null : c)), 2600);
      }
    }
    clearedBefore.current = now;
  }, [tiers, items]);

  const changeEntity = async (item: Item, nextEntity: string) => {
    setBusy(true);
    try {
      await api(`/review/${item.wmma_id}`, { method: "PATCH", body: { entity: nextEntity } });
      setItems((xs) => (xs ?? []).map((x) => x.wmma_id === item.wmma_id ? { ...x, entity: nextEntity } : x));
      setEditingEntity(null);
      toast(`Assigned to ${entityName(nextEntity)}`);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const loadNote = (item: Item) => {
    if (item.wmma_id in notes) return;
    api<{ note: string | null }>(`/transactions/${item.wmma_id}`)
      .then((t) => setNotes((n) => (item.wmma_id in n ? n : { ...n, [item.wmma_id]: t.note })))
      .catch(() => setNotes((n) => (item.wmma_id in n ? n : { ...n, [item.wmma_id]: null })));
  };
  useEffect(() => {
    if (card) loadNote(card);
  }, [card?.wmma_id]);

  const saveNote = async (item: Item, note: string) => {
    const next = note.trim() || null;
    if ((notes[item.wmma_id] ?? null) === next) return;
    try {
      const t = await api<{ note: string | null }>(`/transactions/${item.wmma_id}`, { method: "PATCH", body: { memo: next } });
      setNotes((n) => ({ ...n, [item.wmma_id]: t.note }));
      toast(next ? "Note saved" : "Note cleared");
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const updateLater = (fn: (ids: string[]) => string[]) =>
    setLater((ids) => {
      const next = fn(ids);
      saveLater(next);
      return next;
    });

  async function resolve(item: Item, account: string, direction: "right" | "up") {
    setBusy(true);
    setFly(direction);
    try {
      const r = await api<{ ruleCreated: { match: { payeeKey?: string } } | null; autoResolved: string[] }>(`/review/${item.wmma_id}`, { body: { account } });
      await new Promise((res) => setTimeout(res, 220));
      const gone = new Set([item.wmma_id, ...r.autoResolved]);
      const goneDates = (items ?? []).filter((x) => gone.has(x.wmma_id)).map((x) => x.date);
      setItems((xs) => (xs ?? []).filter((x) => !gone.has(x.wmma_id)));
      setSorted((d) => [...d, ...goneDates]);
      setStreak((n) => n + 1);
      updateLater((ids) => ids.filter((id) => !gone.has(id)));
      if (r.ruleCreated) {
        setLearned((n) => n + 1);
        const extra = r.autoResolved.length ? ` · ${r.autoResolved.length} more sorted` : "";
        toast(`Learned: “${r.ruleCreated.match.payeeKey}” → ${leaf(account)}${extra}`);
      }
      refreshReview();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setFly(null);
      setDrag({ dx: 0, dy: 0, active: false });
      setBusy(false);
    }
  }

  const accept = () => card && top && !busy && resolve(card, top.account, "right");
  const choose = () => card && !busy && setPicker(true);
  /** Swipe left: send the card to the back of the deck to decide later. */
  const deferCard = async () => {
    if (!card || busy) return;
    setBusy(true);
    setFly("left");
    setStreak(0);
    await new Promise((res) => setTimeout(res, 220));
    updateLater((ids) => [...ids.filter((id) => id !== card.wmma_id), card.wmma_id]);
    setFly(null);
    setDrag({ dx: 0, dy: 0, active: false });
    setBusy(false);
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (picker || ["INPUT", "SELECT", "TEXTAREA"].includes((e.target as HTMLElement)?.tagName)) return;
      if (e.key === "ArrowRight") accept();
      else if (e.key === "ArrowLeft" || e.key.toLowerCase() === "s") deferCard();
      else if (e.key === "ArrowDown" || e.key.toLowerCase() === "c" || e.key === "/") {
        e.preventDefault();
        choose();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  const onDown = (e: PointerEvent) => {
    if (busy) return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    dxRef.current = 0;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setDrag({ dx: 0, dy: 0, active: true });
  };
  const onMove = (e: PointerEvent) => {
    if (!start.current || start.current.id !== e.pointerId) return;
    dxRef.current = e.clientX - start.current.x;
    setDrag({ dx: dxRef.current, dy: (e.clientY - start.current.y) * 0.25, active: true });
  };
  const onUp = (e: PointerEvent) => {
    if (!start.current) return;
    const dx = e.type === "pointercancel" ? 0 : e.clientX - start.current.x || dxRef.current;
    start.current = null;
    if (dx > THRESHOLD && top) accept();
    else if (dx < -THRESHOLD) deferCard();
    else setDrag({ dx: 0, dy: 0, active: false });
  };

  const transform =
    fly === "up"
      ? `translate(0, -120%) scale(0.9)`
      : fly
        ? `translate(${fly === "right" ? 130 : -130}%, ${drag.dy}px) rotate(${fly === "right" ? 18 : -18}deg)`
        : `translate(${drag.dx}px, ${drag.dy}px) rotate(${drag.dx / 18}deg)`;
  const yes = Math.max(0, Math.min(1, drag.dx / THRESHOLD));
  const no = Math.max(0, Math.min(1, -drag.dx / THRESHOLD));
  const laterCount = queue.filter((i) => later.includes(i.wmma_id)).length;
  const sessionDone = sorted.length;

  return (
    <div class="stack">
      <div class="topbar">
        <h1>Review</h1>
        <EntitySwitcher />
      </div>
      {error && <ErrorBox error={error} />}
      {!items && !error && <Loading h={420} />}
      {items && noSuggestion > 0 && settings.data && (
        <div class="card flat row" style={{ gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <strong>{noSuggestion} without a suggestion</strong>
            <div class="muted small">
              {settings.data.jev.configured
                ? "These were queued before Jev was set up, or while it was unavailable or out of credits."
                : "Add a Jev API key in Settings to get category suggestions for these."}
            </div>
          </div>
          {settings.data.jev.configured ? (
            <button class="btn" disabled={asking} onClick={askJev}>
              {asking ? "Asking Jev…" : noSuggestion > JEV_BATCH ? `Ask Jev (next ${JEV_BATCH})` : "Ask Jev"}
            </button>
          ) : (
            <button class="btn ghost" onClick={() => go("/settings")}>
              Settings
            </button>
          )}
        </div>
      )}
      {items && (card || sessionDone > 0) && <Quest tiers={tiers} current={current} streak={streak} sessionDone={sessionDone} later={laterCount} />}
      {items && !card && (
        <div class="card done">
          <div class="emoji">🏆</div>
          <h2 style={{ fontSize: 22, margin: "10px 0 6px" }}>All caught up</h2>
          <p class="muted" style={{ margin: 0 }}>
            {sessionDone > 0 ? `${sessionDone} sorted${learned ? ` · ${learned} new rule${learned > 1 ? "s" : ""} learned` : ""}.` : "Nothing waiting for a category."}
          </p>
          <div class="row" style={{ justifyContent: "center", marginTop: 18 }}>
            <button class="btn primary" onClick={() => go("/")}>
              Back home
            </button>
          </div>
        </div>
      )}
      {card && (
        <div class="swipe-wrap">
          <div class="deck">
            {queue.slice(1, 3).reverse().map((it, i, arr) => (
              <div class={`swipe-card ${i === arr.length - 1 ? "behind" : "behind2"}`} key={it.wmma_id} aria-hidden>
                <CardBody item={it} entityName={entityName} entities={entities} jevConfigured={settings.data?.jev.configured} />
              </div>
            ))}
            <div
              key={card.wmma_id}
              class={`swipe-card${drag.active && !fly ? " dragging" : ""}`}
              style={{ transform, opacity: fly ? 0 : 1 }}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
              role="group"
              aria-label={`${card.payee}, ${money(card.amount_cents)}`}
            >
              <div class="stamp yes" style={{ opacity: yes }}>
                ACCEPT
              </div>
              <div class="stamp later" style={{ opacity: no }}>
                LATER
              </div>
              {later.includes(card.wmma_id) && <div class="later-tag">⏳ Saved for later</div>}
              <CardBody
                jevConfigured={settings.data?.jev.configured}
                item={card}
                entityName={entityName}
                entities={entities}
                editingEntity={editingEntity === card.wmma_id}
                onEditEntity={() => setEditingEntity((current) => current === card.wmma_id ? null : card.wmma_id)}
                onChangeEntity={(nextEntity) => changeEntity(card, nextEntity)}
                onPickSuggestion={(account) => !busy && resolve(card, account, account === top?.account ? "right" : "up")}
                busy={busy}
                note={notes[card.wmma_id]}
                onSaveNote={(note) => saveNote(card, note)}
              />
            </div>
          </div>

          <div class="swipe-actions">
            <button class="round later" onClick={deferCard} aria-label="Decide later" disabled={busy}>
              <Icon.clock />
              <span>Later</span>
            </button>
            <button class="round pick" onClick={choose} aria-label="Choose another category" disabled={busy}>
              <Icon.list />
              <span>Other</span>
            </button>
            <button class="round yes" onClick={accept} aria-label={top ? `Accept ${catLabel(top.account)}` : "No suggestion to accept"} disabled={busy || !top}>
              <Icon.check />
              <span>Accept</span>
            </button>
          </div>
          <div class="muted tiny hide-sm">
            <span class="kbd">←</span> later · <span class="kbd">↓</span> other category · <span class="kbd">→</span> accept
          </div>
        </div>
      )}

      {celebrate && <Celebration key={celebrate.key} title={celebrate.title} badge={celebrate.badge} next={current.cleared ? null : current} />}

      <Sheet open={picker} onClose={() => setPicker(false)} title={card ? `Categorize ${card.payee}` : "Categorize"}>
        {card && (
          <CategoryPicker
            categories={categories}
            suggested={card.jev_choices}
            direction={card.amount_cents < 0 ? "out" : "in"}
            onPick={(a) => {
              setPicker(false);
              resolve(card, a, "up");
            }}
          />
        )}
      </Sheet>
    </div>
  );
}

type Tier = Milestone & { left: number; done: number; total: number; cleared: boolean };

/**
 * The game layer, kept to a slim strip: how many to go for the current
 * milestone, a progress bar, then the milestone trail (cleared ones become badges).
 */
function Quest({ tiers, current, streak, sessionDone, later }: { tiers: Tier[]; current: Tier; streak: number; sessionDone: number; later: number }) {
  const pct = current.total ? Math.round((current.done / current.total) * 100) : 100;
  const trail = tiers.filter((t) => t.id !== "all" || t.total > 0);
  const stripRef = useRef<HTMLDivElement>(null);
  // Keep the current milestone in view as the trail scrolls on small screens.
  useEffect(() => {
    stripRef.current?.querySelector(".ms-now")?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }, [current.id]);
  return (
    <div class="quest card">
      <div class="quest-row">
        {current.cleared ? (
          <div class="quest-title">👑 Inbox zero</div>
        ) : (
          <div class="quest-title">
            <span key={current.left} class="quest-left num">{current.left}</span> to clear · <strong>{current.label}</strong>
          </div>
        )}
        <div class="quest-meta">
          <span class="quest-bar-label num" title={`${current.label}: ${current.done} of ${current.total} sorted`}>
            {current.done}/{current.total}
          </span>
          <span title="Sorted this session">⚡{sessionDone}</span>
          {streak >= 3 && <span key={streak} class="streak" title="In a row">🔥{streak}</span>}
          {later > 0 && <span title="Saved for later">⏳{later}</span>}
        </div>
      </div>
      <div class="milestones" ref={stripRef}>
        {trail.map((t) => (
          <span
            class={`ms${t.cleared ? " ms-cleared" : ""}${t.id === current.id && !t.cleared ? " ms-now" : ""}`}
            title={`${t.label} · ${t.days === Infinity ? "every transaction" : t.days === 0 ? "dated today" : `last ${t.days + 1} days`}${t.cleared ? " · cleared" : ` · ${t.left} to go`}`}
          >
            <span class="ms-emoji" aria-hidden="true">{t.badge}</span>
            {t.id === current.id && !t.cleared && <span class="ms-label">{t.label}</span>}
            <span class="ms-count num">{t.cleared ? "✓" : t.left}</span>
          </span>
        ))}
      </div>
      <div class="quest-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${current.label}: ${current.left} to go`}>
        <div key={current.id} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const CONFETTI_COLORS = ["#16a874", "#3b82f6", "#a855f7", "#f59e0b", "#ec4899", "#14b8a6", "#facc15"];

/** Full-screen milestone celebration: confetti rain, a badge that bursts in, and what's next. */
function Celebration({ title, badge, next }: { title: string; badge: string; next: Tier | null }) {
  const pieces = useMemo(
    () =>
      Array.from({ length: 70 }, (_, i) => ({
        left: Math.random() * 100,
        delay: Math.random() * 0.5,
        dur: 1.6 + Math.random() * 1.1,
        rot: Math.random() * 720 - 360,
        drift: Math.random() * 160 - 80,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length]!,
        round: i % 3 === 0,
      })),
    [],
  );
  return (
    <div class="celebrate" aria-live="polite">
      <div class="confetti" aria-hidden="true">
        {pieces.map((p) => (
          <i
            class={p.round ? "round-bit" : ""}
            style={{ left: `${p.left}%`, background: p.color, animationDelay: `${p.delay}s`, animationDuration: `${p.dur}s`, "--rot": `${p.rot}deg`, "--drift": `${p.drift}px` }}
          />
        ))}
      </div>
      <div class="celebrate-card">
        <div class="celebrate-badge" aria-hidden="true">
          <span class="rays" />
          <span class="badge-emoji">{badge}</span>
        </div>
        <strong>{title}!</strong>
        <span>{next ? `Next: ${next.label} · ${next.left} to go` : "Everything is sorted 🙌"}</span>
      </div>
    </div>
  );
}

/** One color per Jev rank, so the headline pick and its chip always match. */
const JEV_COLORS = ["#16a874", "#3b82f6", "#a855f7", "#f59e0b", "#ec4899", "#14b8a6"];
const jevColor = (rank: number) => JEV_COLORS[rank % JEV_COLORS.length]!;

/** Why a card has no suggestion, judged by whether Jev is set up now, not when the item was queued. */
function noSuggestionHint(reason: string | null, jevConfigured: boolean | undefined): string {
  if (jevConfigured === false) return "Add a Jev key in Settings for suggestions.";
  if (reason === "low confidence") return "Jev couldn't decide.";
  if (jevConfigured) return "Jev hasn't looked at this one yet: tap Ask Jev above.";
  return "No suggestion yet.";
}

function CardBody({
  item,
  entityName,
  entities = [],
  editingEntity = false,
  onEditEntity,
  onChangeEntity,
  onPickSuggestion,
  busy = false,
  note,
  onSaveNote,
  jevConfigured,
}: {
  jevConfigured?: boolean | undefined;
  item: Item;
  entityName: (s: string | null) => string;
  entities?: Array<{ slug: string; name: string; type: string; color?: string | null }>;
  editingEntity?: boolean;
  onEditEntity?: () => void;
  onChangeEntity?: (entity: string) => void;
  onPickSuggestion?: (account: string) => void;
  busy?: boolean;
  note?: string | null | undefined;
  onSaveNote?: (note: string) => void;
}) {
  const top = item.jev_choices[0];
  const inflow = item.amount_cents > 0;
  return (
    <>
      <div class="upper">{dayLabel(item.date)}</div>
      <div class={`amt ${inflow ? "in" : ""}`}>
        {inflow ? "+" : ""}
        {money(item.amount_cents)}
      </div>
      <div class="payee review-payee">
        <Avatar name={item.payee} />
        <span>{item.payee}</span>
      </div>
      <dl class="facts">
        <dt>Account</dt>
        <dd>{leaf(item.account)}</dd>
        <dt>Business / personal</dt>
        <dd>
          {editingEntity ? (
            <select class="review-entity-select" value={item.entity ?? ""} onPointerDown={(e) => e.stopPropagation()} onChange={(e) => onChangeEntity?.((e.target as HTMLSelectElement).value)}>
              {entities.map((entity) => <option value={entity.slug}>{entity.name}</option>)}
            </select>
          ) : (
            <button class="review-entity" onPointerDown={(e) => e.stopPropagation()} onClick={onEditEntity}>
              {(() => {
                const entity = entities.find((x) => x.slug === item.entity);
                return <><span class="business-icon compact" style={item.entity ? businessStyle(item.entity, entity?.color) : {}}>{entity?.type === "personal" ? "👤" : <Icon.folder />}</span>{entityName(item.entity)}<Icon.chevron /></>;
              })()}
            </button>
          )}
        </dd>
        {onSaveNote && (
          <>
            <dt>Note</dt>
            <dd>
              <input
                key={`${item.wmma_id}:${note ?? ""}`}
                class="review-note"
                placeholder={note === undefined ? "Loading…" : "Add a note"}
                defaultValue={note ?? ""}
                disabled={note === undefined}
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                onBlur={(e) => onSaveNote((e.target as HTMLInputElement).value)}
              />
            </dd>
          </>
        )}
      </dl>
      {top ? (
        <div class="suggestion" style={{ background: `${jevColor(0)}20`, borderColor: `${jevColor(0)}55` }}>
          <div class="upper" style={{ color: jevColor(0) }}>
            Jev suggests
          </div>
          <div class="cat"><CatName account={top.account} /></div>
          <div class="conf" style={{ background: `${jevColor(0)}35` }} aria-label={`${Math.round(top.probability * 100)}% confident`}>
            <div style={{ width: `${Math.round(top.probability * 100)}%`, background: jevColor(0) }} />
          </div>
          <div class="tiny muted" style={{ marginTop: 6 }}>
            {Math.round(top.probability * 100)}% confident
          </div>
          {onPickSuggestion && item.jev_choices.length > 1 && (
            <div class="jev-options" onPointerDown={(e) => e.stopPropagation()}>
              <span class="jev-or upper">Or</span>
              {item.jev_choices.slice(1, 6).map((choice, i) => (
                <button key={choice.account} disabled={busy} style={{ color: jevColor(i + 1), borderColor: `${jevColor(i + 1)}88`, background: `${jevColor(i + 1)}14` }} onClick={() => onPickSuggestion(choice.account)}>
                  <CatName account={choice.account} />
                  <span class="pct">{Math.round(choice.probability * 100)}%</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div class="suggestion none">
          <div class="upper">No suggestion</div>
          <div class="small muted" style={{ marginTop: 4 }}>
            {noSuggestionHint(item.reason, jevConfigured)} Tap Other to choose one.
          </div>
        </div>
      )}
    </>
  );
}
