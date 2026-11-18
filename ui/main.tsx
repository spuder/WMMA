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
  { path: "/accounts", label: "Accounts", icon: Icon.bank },
  { path: "/imports", label: "Imports", icon: Icon.upload, desktopOnly: true },
  { path: "/settings", label: "Settings", icon: Icon.gear, desktopOnly: true },
];

function Shell() {
  const me = useApi<{ user: string; name: string | null }>("/status");
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

  if (me.loading) return <div class="auth-state">Connecting to WMMA…</div>;
  if (me.error) {
    const unrecognized = me.error.startsWith("Tailscale user ") && me.error.endsWith(" is not allowed");
    return (
      <main class="auth-state">
        <section class="card auth-card stack">
          <h1>{unrecognized ? "Tailscale user not recognized" : "Tailscale login required"}</h1>
          <p>{unrecognized ? `${me.error.slice("Tailscale user ".length, -" is not allowed".length)} is not authorized to use WMMA.` : "WMMA could not identify your Tailscale account. Connect to your tailnet and reload this page."}</p>
          <ol>
            <li>Install and open <a href="https://tailscale.com/download" target="_blank" rel="noreferrer">Tailscale</a> on this device.</li>
            <li>Sign in to the <strong>snowy-vibes</strong> tailnet and make sure Tailscale is connected.</li>
            <li>Reload this page. If your account is still not recognized, ask the WMMA administrator to add your Tailscale login to the allowed users.</li>
          </ol>
          <button class="btn" onClick={() => location.reload()}>Try again</button>
        </section>
      </main>
    );
  }

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
          <div class="identity" title={me.data?.user}>
            <span class="identity-dot" />
            <span><strong>{me.data?.name || me.data?.user}</strong><small>Signed in with Tailscale</small></span>
          </div>
        </nav>
        <div class="identity identity-mobile" title={me.data?.user}>
          <span class="identity-dot" />
          <span><strong>{me.data?.name || me.data?.user}</strong><small>Signed in with Tailscale</small></span>
        </div>
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
