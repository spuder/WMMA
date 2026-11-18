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
        <span class="dot" style={current ? {} : { background: "var(--muted)" }} />
        <span>{current?.name ?? "All entities"}</span>
        <Icon.down />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Show">
        <div class="list">
          {[{ slug: null as string | null, name: "All entities", type: "combined" }, ...entities].map((e) => (
            <button
              class="catbtn"
              onClick={() => {
                setEntity(e.slug);
                setOpen(false);
              }}
            >
              <span>
                {e.name} <span class="muted small">· {e.type.replace(/_/g, " ")}</span>
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

