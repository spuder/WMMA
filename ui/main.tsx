import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api, store, useApi } from "./api";
import { App, type Entity, useRoute } from "./app";
import { Icon, Toaster } from "./components/ui";
import { Accounts } from "./pages/Accounts";
import { Dashboard } from "./pages/Dashboard";
import { Imports } from "./pages/Imports";
import { More } from "./pages/More";
import { Reports } from "./pages/Reports";
import { Review } from "./pages/Review";
import { Settings } from "./pages/Settings";
import { Transactions } from "./pages/Transactions";

const NAV = [
  { path: "/", label: "Home", icon: Icon.home },
  { path: "/transactions", label: "Activity", icon: Icon.list },
  { path: "/review", label: "Review", icon: Icon.swipe },
  { path: "/reports", label: "Reports", icon: Icon.chart },
  { path: "/more", label: "More", icon: Icon.more, mobileOnly: true },
  { path: "/accounts", label: "Accounts", icon: Icon.bank, desktopOnly: true },
  { path: "/imports", label: "Imports", icon: Icon.upload, desktopOnly: true },
  { path: "/settings", label: "Settings", icon: Icon.gear, desktopOnly: true },
];

function Shell() {
  const [path, query] = useRoute();
  const [entity, setEntityState] = useState<string | null>(store.get("entity"));
  const ents = useApi<{ entities: Entity[] }>("/entities");
  const [reviewCount, setReviewCount] = useState(0);
  const [categories, setCategories] = useState<string[]>([]);
  const refreshReview = () =>
    api<{ items: unknown[] }>("/review")
      .then((r) => setReviewCount(r.items.length))
      .catch(() => {});
  useEffect(() => {
    refreshReview();
    api<{ categories: string[] }>("/categories")
      .then((r) => setCategories(r.categories))
      .catch(() => {});
  }, []);
  const entities = ents.data?.entities ?? [];
  useEffect(() => {
    // Forget a remembered entity that no longer exists (or was archived).
    if (entity && ents.data && !entities.some((e) => e.slug === entity)) setEntity(null);
  }, [ents.data]);
  const setEntity = (s: string | null) => {
    setEntityState(s);
    store.set("entity", s);
  };

  const page = (() => {
    switch (path) {
      case "/":
        return <Dashboard />;
      case "/transactions":
        return <Transactions query={query} />;
      case "/review":
        return <Review />;
      case "/reports":
        return <Reports query={query} />;
      case "/accounts":
        return <Accounts />;
      case "/imports":
        return <Imports />;
      case "/settings":
        return <Settings />;
      case "/more":
        return <More />;
      default:
        return <div class="empty">Not found</div>;
    }
  })();

  const active = (p: string) => (p === "/" ? path === "/" : path.startsWith(p) || (p === "/more" && ["/accounts", "/imports", "/settings"].includes(path)));

  return (
    <App.Provider value={{ entity, setEntity, entities, reviewCount, refreshReview, categories, reloadEntities: ents.reload }}>
      <div class="app">
        <nav class="sidebar" aria-label="Main">
          <div class="brand">
            <Icon.logo /> WMMA
          </div>
          {NAV.filter((n) => !n.mobileOnly).map((n) => (
            <a href={`#${n.path}`} class={`navlink${active(n.path) ? " active" : ""}`}>
              <n.icon />
              {n.label}
              {n.path === "/review" && reviewCount > 0 && <span class="badge">{reviewCount}</span>}
            </a>
          ))}
          <div style={{ marginTop: "auto" }} class="muted tiny">
            Where My Money At
          </div>
        </nav>
        <main class="main">
          <div class="page">{page}</div>
        </main>
        <nav class="bottomnav" aria-label="Main">
          {NAV.filter((n) => !n.desktopOnly).map((n) => (
            <a href={`#${n.path}`} class={`navlink${active(n.path) ? " active" : ""}`}>
              <n.icon />
              {n.label}
              {n.path === "/review" && reviewCount > 0 && <span class="badge">{reviewCount > 99 ? "99+" : reviewCount}</span>}
            </a>
          ))}
        </nav>
        <Toaster />
      </div>
    </App.Provider>
  );
}

const theme = store.get("theme");
if (theme === "light" || theme === "dark") document.documentElement.dataset["theme"] = theme;
render(<Shell />, document.getElementById("app")!);
