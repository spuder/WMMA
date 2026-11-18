import { createContext } from "preact";
import { useContext, useEffect, useState } from "preact/hooks";
import { Icon, Sheet } from "./components/ui";

export interface Entity {
  slug: string;
  name: string;
  type: string;
  status: string;
}

interface AppState {
  entity: string | null; // null = all
  setEntity: (s: string | null) => void;
  entities: Entity[];
  reviewCount: number;
  refreshReview: () => void;
  categories: string[];
  reloadEntities: () => void;
}

export const App = createContext<AppState>(null as never);
export const useApp = () => useContext(App);

export function useRoute(): [string, URLSearchParams] {
  const parse = (): [string, URLSearchParams] => {
    const h = location.hash.replace(/^#/, "") || "/";
    const [path, qs] = h.split("?");
    return [path || "/", new URLSearchParams(qs ?? "")];
  };
  const [r, setR] = useState(parse);
  useEffect(() => {
    const on = () => {
      setR(parse());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return r;
}

export const go = (path: string) => {
  location.hash = path;
};

export function EntitySwitcher() {
  const { entity, setEntity, entities } = useApp();
  const [open, setOpen] = useState(false);
  const current = entities.find((e) => e.slug === entity);
  return (
    <>
      <button class="entity-pill" onClick={() => setOpen(true)} aria-label="Choose entity">
        <span class="dot" style={current ? { background: businessStyle(current.slug).color } : { background: "var(--muted)" }} />
        <span>{current?.name ?? "All finances"}</span>
        <Icon.down />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Show">
        <div class="muted small" style={{ margin: "0 4px 8px" }}>Choose a business or personal profile to filter this view.</div>
        <div class="list">
          {[{ slug: null as string | null, name: "All finances", type: "combined" }, ...entities].map((e) => (
            <button
              class="catbtn"
              onClick={() => {
                setEntity(e.slug);
                setOpen(false);
              }}
            >
              <span class="row" style={{ gap: 9 }}>
                <span class="business-icon" style={e.slug ? businessStyle(e.slug) : {}}>{e.type === "personal" ? "👤" : e.type === "combined" ? "🌈" : "💼"}</span>
                <span>{e.name} <span class="muted small">· {e.type === "personal" ? "Personal" : e.type === "combined" ? "Everything" : "Business"}</span></span>
              </span>
              {entity === e.slug && (
                <span style={{ color: "var(--accent)", width: 20, height: 20, display: "inline-flex" }}>
                  <Icon.check />
                </span>
              )}
            </button>
          ))}
        </div>
      </Sheet>
    </>
  );
}

const BUSINESS_COLORS = ["#0ea5e9", "#d946ef", "#8b5cf6", "#f97316", "#16a34a", "#e11d48", "#ca8a04"];
export function businessStyle(slug: string): Record<string, string> {
  let hash = 0;
  for (const c of slug) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  const color = BUSINESS_COLORS[(hash >>> 0) % BUSINESS_COLORS.length]!;
  return { color, background: `${color}20`, borderColor: `${color}55` };
}

export function transactionEntity(t: { tags: Record<string, string>; postings: Array<{ entity: string | null }> }): string | null {
  return t.tags.entity ?? t.postings.find((p) => p.entity)?.entity ?? null;
}

