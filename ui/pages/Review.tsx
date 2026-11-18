/**
 * Swipe game for the review queue (SPEC §9): one card per transaction with
 * Jev's top pick. Swipe right = accept. Swipe left = pick another category.
 * Accepts feed the 3-swipe rule learning on the server.
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, catLabel, dayLabel, leaf, money } from "../api";
import { CategoryPicker, ErrorBox, Icon, Loading, Sheet, toast } from "../components/ui";
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

export function Review() {
  const { entity, entities, categories, refreshReview } = useApp();
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(0);
  const [learned, setLearned] = useState(0);
  const [picker, setPicker] = useState(false);
  const [editingEntity, setEditingEntity] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState<{ dx: number; dy: number; active: boolean }>({ dx: 0, dy: 0, active: false });
  const [fly, setFly] = useState<"left" | "right" | null>(null);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  // The latest drag distance; read on release so a fast flick isn't lost to a pending render.
  const dxRef = useRef(0);

  useEffect(() => {
    api<{ items: Item[] }>("/review")
      .then((r) => setItems(r.items))
      .catch((e: Error) => setError(e.message));
  }, []);

  const queue = useMemo(() => (items ?? []).filter((i) => !entity || i.entity === entity), [items, entity]);
  const total = done + queue.length;
  const card = queue[0];
  const top = card?.jev_choices[0];
  const entityName = (slug: string | null) => entities.find((e) => e.slug === slug)?.name ?? slug ?? "—";

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

  async function resolve(item: Item, account: string, direction: "left" | "right") {
    setBusy(true);
    setFly(direction);
    try {
      const r = await api<{ ruleCreated: { match: { payeeKey?: string } } | null; autoResolved: string[] }>(`/review/${item.wmma_id}`, { body: { account } });
      await new Promise((res) => setTimeout(res, 220));
      const gone = new Set([item.wmma_id, ...r.autoResolved]);
      setItems((xs) => (xs ?? []).filter((x) => !gone.has(x.wmma_id)));
      setDone((d) => d + gone.size);
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
  const other = () => card && !busy && setPicker(true);
  const skip = () => {
    if (!card || busy) return;
    setItems((xs) => (xs ? [...xs.filter((x) => x.wmma_id !== card.wmma_id), card] : xs));
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (picker || ["INPUT", "SELECT", "TEXTAREA"].includes((e.target as HTMLElement)?.tagName)) return;
      if (e.key === "ArrowRight") accept();
      else if (e.key === "ArrowLeft") other();
      else if (e.key.toLowerCase() === "s") skip();
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
    else if (dx < -THRESHOLD) {
      setDrag({ dx: 0, dy: 0, active: false });
      other();
    } else setDrag({ dx: 0, dy: 0, active: false });
  };

  const transform = fly
    ? `translate(${fly === "right" ? 130 : -130}%, ${drag.dy}px) rotate(${fly === "right" ? 18 : -18}deg)`
    : `translate(${drag.dx}px, ${drag.dy}px) rotate(${drag.dx / 18}deg)`;
  const yes = Math.max(0, Math.min(1, drag.dx / THRESHOLD));
  const no = Math.max(0, Math.min(1, -drag.dx / THRESHOLD));

  return (
    <div class="stack">
      <div class="topbar">
        <h1>Review</h1>
        <EntitySwitcher />
      </div>
      {error && <ErrorBox error={error} />}
      {!items && !error && <Loading h={420} />}
      {items && !card && (
        <div class="card done">
          <div class="emoji">🎉</div>
          <h2 style={{ fontSize: 22, margin: "10px 0 6px" }}>All caught up</h2>
          <p class="muted" style={{ margin: 0 }}>
            {done > 0 ? `${done} sorted${learned ? ` · ${learned} new rule${learned > 1 ? "s" : ""} learned` : ""}.` : "Nothing waiting for a category."}
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
          <div class="progress stack" style={{ gap: 6 }}>
            <div class="spread small">
              <span class="muted">
                {done} of {total} sorted
              </span>
              <button class="btn ghost small" style={{ height: 28, padding: "0 6px" }} onClick={skip}>
                Later
              </button>
            </div>
            <div class="bar">
              <div style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
            </div>
          </div>

          <div class="deck">
            {queue.slice(1, 3).reverse().map((it, i, arr) => (
              <div class={`swipe-card ${i === arr.length - 1 ? "behind" : "behind2"}`} key={it.wmma_id} aria-hidden>
                <CardBody item={it} entityName={entityName} entities={entities} />
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
              <div class="stamp no" style={{ opacity: no }}>
                OTHER
              </div>
              <CardBody
                item={card}
                entityName={entityName}
                entities={entities}
                editingEntity={editingEntity === card.wmma_id}
                onEditEntity={() => setEditingEntity((current) => current === card.wmma_id ? null : card.wmma_id)}
                onChangeEntity={(nextEntity) => changeEntity(card, nextEntity)}
                onPickSuggestion={(account) => !busy && resolve(card, account, account === top?.account ? "right" : "left")}
                busy={busy}
                note={notes[card.wmma_id]}
                onSaveNote={(note) => saveNote(card, note)}
              />
            </div>
          </div>

          <div class="swipe-actions">
            <button class="round no" onClick={other} aria-label="Choose another category" disabled={busy}>
              <Icon.x />
            </button>
            <button class="round yes" onClick={accept} aria-label={top ? `Accept ${catLabel(top.account)}` : "No suggestion to accept"} disabled={busy || !top}>
              <Icon.check />
            </button>
          </div>
          <div class="muted tiny hide-sm">
            <span class="kbd">←</span> other · <span class="kbd">→</span> accept · <span class="kbd">S</span> later
          </div>
        </div>
      )}

      <Sheet open={picker} onClose={() => setPicker(false)} title={card ? `Categorize ${card.payee}` : "Categorize"}>
        {card && (
          <CategoryPicker
            categories={categories}
            suggested={card.jev_choices}
            direction={card.amount_cents < 0 ? "out" : "in"}
            onPick={(a) => {
              setPicker(false);
              resolve(card, a, "left");
            }}
          />
        )}
      </Sheet>
    </div>
  );
}

/** One color per Jev rank, so the headline pick and its chip always match. */
const JEV_COLORS = ["#16a874", "#3b82f6", "#a855f7", "#f59e0b", "#ec4899", "#14b8a6"];
const jevColor = (rank: number) => JEV_COLORS[rank % JEV_COLORS.length]!;

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
}: {
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
      <div class="payee">{item.payee}</div>
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
          <div class="cat">{catLabel(top.account)}</div>
          <div class="conf" style={{ background: `${jevColor(0)}35` }} aria-label={`${Math.round(top.probability * 100)}% confident`}>
            <div style={{ width: `${Math.round(top.probability * 100)}%`, background: jevColor(0) }} />
          </div>
          <div class="spread tiny muted" style={{ marginTop: 6 }}>
            <span>{Math.round(top.probability * 100)}% confident</span>
            {item.jev_choices[1] && <span>then {leaf(item.jev_choices[1].account)}</span>}
          </div>
          {onPickSuggestion && <div class="jev-options">
            {item.jev_choices.slice(0, 6).map((choice, index) => (
              <button key={choice.account} disabled={busy} style={{ color: jevColor(index), borderColor: `${jevColor(index)}88`, background: `${jevColor(index)}14` }} onPointerDown={(e) => e.stopPropagation()} onClick={() => onPickSuggestion(choice.account)}>
                {catLabel(choice.account)} <span>{Math.round(choice.probability * 100)}%</span>
              </button>
            ))}
          </div>}
        </div>
      ) : (
        <div class="suggestion none">
          <div class="upper">No suggestion</div>
          <div class="small muted" style={{ marginTop: 4 }}>
            {item.reason === "jev not configured" ? "Add a Jev key in Settings for suggestions." : "Jev couldn't decide."} Swipe left to choose.
          </div>
        </div>
      )}
    </>
  );
}
