import { Icon } from "../components/ui";

export function More() {
  const links = [
    { href: "#/accounts", icon: Icon.bank, title: "Accounts & businesses", sub: "Balances, business and personal profiles, assets" },
    { href: "#/imports", icon: Icon.upload, title: "Imports", sub: "YNAB, QFX, CSV, SimpleFIN, REI Hub" },
    { href: "#/settings", icon: Icon.gear, title: "Settings", sub: "Jev key, appearance" },
  ];
  return (
    <div class="stack">
      <div class="topbar">
        <h1>More</h1>
      </div>
      <div class="card" style={{ padding: "4px 14px" }}>
        <div class="list">
          {links.map((l) => (
            <a class="item tap" href={l.href}>
              <div class="avatar" style={{ color: "var(--accent)" }}>
                <span style={{ width: 22, height: 22, display: "inline-flex" }}>
                  <l.icon />
                </span>
              </div>
              <div class="body">
                <div class="title">{l.title}</div>
                <div class="meta">{l.sub}</div>
              </div>
              <span class="muted" style={{ display: "inline-flex" }}>
                <Icon.chevron />
              </span>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
