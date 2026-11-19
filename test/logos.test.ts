import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { normaliseSimplefin } from "../src/importers/simplefin";
import { findLogo, iconLinks, isPrivateAddress, sniffImage, type LogoFetcher } from "../src/logos/fetch";
import { runCli } from "../src/cli";
import { createFetchHandler } from "../src/server";
import type { ServiceContext } from "../src/services/context";
import { accountLogo, logoCoverage, logoImage, normalizeDomain, payeeLogos, prefetchLogos, resolvePayee, setPayeeLogo } from "../src/services/logos";

/** A PNG header claiming the given dimensions (enough for sniffImage). */
function png(w: number, h = w): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

/** A fake web: URL -> response; anything else is a 404. Records every URL requested. */
function fakeWeb(pages: Record<string, () => Response>): LogoFetcher & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: URL) => {
    calls.push(url.href);
    return pages[url.href]?.() ?? new Response("nope", { status: 404 });
  }) as unknown as LogoFetcher & { calls: string[] };
  f.calls = calls;
  return f;
}
const html = (s: string) => () => new Response(s, { headers: { "content-type": "text/html" } });
const img = (b: Uint8Array<ArrayBuffer>, type = "image/png") => () => new Response(b, { headers: { "content-type": type } });

describe("payee -> logo resolution", () => {
  const r = (key: string, note: string | null = null) => resolvePayee(key, note);
  test("built-in merchants match whole words, longest first", () => {
    expect(r("amazon")).toEqual({ domain: "amazon.com" });
    expect(r("amazon prime membership")).toEqual({ domain: "amazon.com" });
    expect(r("arby s")).toEqual({ domain: "arbys.com" });
    expect(r("the home depot")).toEqual({ domain: "homedepot.com" });
    expect(r("transfer to venmo")).toEqual({ domain: "venmo.com" });
    expect(r("springfield chevron")).toEqual({ domain: "chevron.com" });
    expect(r("google fiber")).toEqual({ domain: "fiber.google.com" });
    expect(r("pineapple express")).toEqual(null);
  });
  test("anchored patterns only match the whole payee", () => {
    expect(r("eleven")).toEqual({ domain: "7-eleven.com" });
    expect(r("eleven madison")).toBeNull();
    expect(r("chase")).toEqual({ domain: "chase.com" });
  });
  test("everyday words don't pull in a brand", () => {
    for (const p of ["big apple pizza", "apple spice box lunch", "eleven salon", "john smith s plumbing", "holiday inn express", "chase johnson", "fidelity national title", "paramount theatre", "shell lake resort", "golden shell seafood", "burlington city", "michaels plumbing"]) expect(r(p)).toBeNull();
    expect(r("apple")).toEqual({ domain: "apple.com" });
    expect(r("apple com bill")).toEqual({ domain: "apple.com" });
    expect(r("chase credit crd epay")).toEqual({ domain: "chase.com" });
    expect(r("target springfield il")).toEqual({ domain: "target.com" });
    expect(r("shell oil")).toEqual({ domain: "shell.us" });
  });
  test("large banks and credit unions", () => {
    expect(r("u s bank")).toEqual({ domain: "usbank.com" });
    expect(r("m t bank mortgage")).toEqual({ domain: "mtb.com" });
    expect(r("navy federal credit union")).toEqual({ domain: "navyfederal.org" });
    expect(r("golden credit union")).toEqual({ domain: "golden1.com" });
    expect(r("america first credit union")).toEqual({ domain: "americafirst.com" });
    expect(r("mountain america cu")).toEqual({ domain: "macu.com" });
    expect(r("zions bank")).toEqual({ domain: "zionsbank.com" });
    expect(r("first citizens bank")).toEqual({ domain: "firstcitizens.com" });
    expect(r("citizens bank")).toEqual({ domain: "citizensbank.com" });
    for (const p of ["citi trends", "america first insurance", "zions pizza", "first bank of springfield", "golden corral"]) expect(r(p)).toBeNull();
    expect(accountLogo({ name: "Navy Federal Credit Union Checking", kind: "bank", logo_domain: null })).toEqual({ domain: "navyfederal.org" });
  });
  test("a payee naming its own .com", () => {
    expect(r("acme com")).toEqual({ domain: "acme.com" });
    expect(r("maplestreetbakery com springfield il")).toEqual({ domain: "maplestreetbakery.com" });
  });
  test("the bank memo is used when the payee says nothing", () => {
    expect(r("purchase", "POS PURCHASE STARBUCKS STORE 01234 SPRINGFIELD IL")).toEqual({ domain: "starbucks.com" });
    expect(r("cafe", "11/11 PANERA BREAD #601 SPRINGFIELD IL")).toEqual({ domain: "panerabread.com" });
  });
  test("money movements get glyphs", () => {
    expect(r("mobile deposit")).toEqual({ glyph: "deposit" });
    expect(r("dividend")).toEqual({ glyph: "dividend" });
    expect(r("interest charge")).toEqual({ glyph: "interest" });
    expect(r("transfer to s")).toEqual({ glyph: "transfer" });
    expect(r("acme online shop web", "AUTOMATIC WITHDRAWAL ACME ONLINE SHOP")).toBeNull();
  });
  test("an override wins, and an empty override means initials", () => {
    const o = { payee_key: "amazon", domain: "example.com", glyph: null, source: "manual" as const, updated_at: "" };
    expect(resolvePayee("amazon", null, o)).toEqual({ domain: "example.com" });
    expect(resolvePayee("amazon", null, { ...o, domain: null })).toBeNull();
  });
  test("accounts: stored domain, then name, then kind", () => {
    expect(accountLogo({ name: "Wells Fargo Everyday Checking", kind: "bank", logo_domain: null })).toEqual({ domain: "wellsfargo.com" });
    expect(accountLogo({ name: "Joint checking", kind: "bank", logo_domain: "chase.com" })).toEqual({ domain: "chase.com" });
    expect(accountLogo({ name: "2014 Ford F-150", kind: "vehicle", logo_domain: null })).toEqual({ glyph: "car" });
    expect(accountLogo({ name: "Joint checking", kind: "bank", logo_domain: null })).toBeNull();
  });
  test("normalizeDomain", () => {
    expect(normalizeDomain("https://www.Example.com/path?q=1")).toBe("example.com");
    expect(normalizeDomain("example.coop")).toBe("example.coop");
    expect(normalizeDomain("7-eleven.com.")).toBe("7-eleven.com");
    for (const bad of ["localhost", "127.0.0.1", "not a domain", "a.b", "-x.com", ""]) expect(normalizeDomain(bad)).toBeNull();
  });
  test("SimpleFIN org domains reach the account data", () => {
    const set = {
      connections: [{ conn_id: "c1", name: "Example Credit Union", org_url: "https://www.examplecu.org/" }],
      accounts: [
        { id: "a1", name: "Checking", conn_id: "c1", currency: "USD", balance: "1.00", "balance-date": 1767225600 },
        { id: "a2", name: "Savings", org: { domain: "www.examplebank.com" }, currency: "USD", balance: "1.00", "balance-date": 1767225600 },
        { id: "a3", name: "Card", org: { domain: "beta-bridge.simplefin.org" }, currency: "USD", balance: "1.00", "balance-date": 1767225600 },
      ],
    };
    expect(normaliseSimplefin(set, "UTC").map((a) => a.domain)).toEqual(["examplecu.org", "examplebank.com", null]);
  });
});

describe("logo fetching", () => {
  test("sniffImage measures by content, not by Content-Type", () => {
    expect(sniffImage(png(180))).toEqual({ type: "image/png", size: 180 });
    expect(sniffImage(png(300, 120))).toEqual({ type: "image/png", size: 120 });
    const ico = new Uint8Array(22 + 16);
    ico.set([0, 0, 1, 0, 2, 0]);
    ico.set([16, 16], 6);
    ico.set([0, 0], 22); // 0 means 256
    expect(sniffImage(ico)).toEqual({ type: "image/x-icon", size: 256 });
    expect(sniffImage(new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toEqual({ type: "image/svg+xml", size: 512 });
    expect(sniffImage(new TextEncoder().encode("<!doctype html><html>blocked</html>"))).toBeNull();
  });
  test("icon links: touch icons, sized icons and the manifest; mask icons skipped", () => {
    const { icons, manifest } = iconLinks(
      `<link rel="icon" href="/f32.png" sizes="32x32"><link rel='apple-touch-icon' href="https://cdn.example.com/t.png">
       <link rel="mask-icon" href="/mask.svg"><link href="/site.webmanifest" rel="manifest"><link rel="stylesheet" href="/x.css">`,
      new URL("https://example.com/home"),
    );
    expect(icons.map((i) => [i.url.href, i.declared])).toEqual([
      ["https://example.com/f32.png", 32],
      ["https://cdn.example.com/t.png", 180],
    ]);
    expect(manifest?.href).toBe("https://example.com/site.webmanifest");
  });
  test("private, loopback and tailnet addresses are refused", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.20.0.1", "100.101.102.103", "169.254.169.254", "::1", "fd7a:115c:a1e0::1", "::ffff:10.0.0.1"]) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111"]) expect(isPrivateAddress(ip)).toBe(false);
  });
  test("IPv6 spellings of private IPv4 addresses are refused", () => {
    // The URL parser rewrites [::ffff:127.0.0.1] to ::ffff:7f00:1 before the guard sees it.
    const host = (u: string) => new URL(u).hostname.replace(/^\[|\]$/g, "");
    expect(isPrivateAddress(host("http://[::ffff:127.0.0.1]/"))).toBe(true);
    expect(isPrivateAddress(host("http://[::ffff:169.254.169.254]/"))).toBe(true);
    for (const ip of ["::ffff:7f00:1", "::ffff:a00:1", "::ffff:6440:1", "0:0:0:0:0:ffff:7f00:1", "::7f00:1", "::", "2002:7f00:1::", "2002:a9fe:a9fe::1", "fec0::1", "fe80::1%eth0", "ff02::1", "64:ff9b::808:808", "2001::1", "2001:db8::1", "198.18.0.1", "not-an-ip", "1::2::3"]) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ["::ffff:8.8.8.8", "::ffff:808:808", "2002:808:808::1", "2a00:1450:4001:80b::200e"]) expect(isPrivateAddress(ip)).toBe(false);
  });
  test("prefers the largest icon from the site, following redirects", async () => {
    const web = fakeWeb({
      "https://shop.com/": () => new Response(null, { status: 301, headers: { location: "https://www.shop.com/" } }),
      "https://www.shop.com/": html(`<link rel="icon" href="/f.png" sizes="32x32"><link rel="manifest" href="/m.json">`),
      "https://www.shop.com/m.json": () => Response.json({ icons: [{ src: "/i512.png", sizes: "512x512" }, { src: "/mono.png", sizes: "1024x1024", purpose: "monochrome" }] }),
      "https://www.shop.com/i512.png": img(png(512)),
      "https://www.shop.com/f.png": img(png(32)),
    });
    const logo = await findLogo("shop.com", web);
    expect(logo?.size).toBe(512);
    expect(logo?.origin).toBe("https://www.shop.com/i512.png");
    expect(web.calls).not.toContain("https://www.shop.com/mono.png");
  });
  test("falls back to the favicon services when the site blocks us", async () => {
    const web = fakeWeb({
      "https://icons.duckduckgo.com/ip3/blocked.com.ico": img(png(64)),
    });
    const logo = await findLogo("blocked.com", web);
    expect(logo).toMatchObject({ size: 64, origin: "duckduckgo" });
    expect(web.calls.some((u) => u.startsWith("https://t3.gstatic.com/faviconV2"))).toBe(true);
  });
  test("the Apple touch icon wins over larger icons", async () => {
    const web = fakeWeb({
      "https://cafe.com/": html(`<link rel="icon" href="/big.png" sizes="512x512"><link rel="apple-touch-icon" sizes="152x152" href="/touch-152.png">`),
      "https://cafe.com/big.png": img(png(512)),
      "https://cafe.com/touch-152.png": img(png(152)),
    });
    expect(await findLogo("cafe.com", web)).toMatchObject({ size: 152, origin: "https://cafe.com/touch-152.png" });
    expect(web.calls).not.toContain("https://cafe.com/big.png");
  });
  test("an undeclared or tiny touch icon: conventional paths, then larger icons", async () => {
    // Homepage blocked, but the precomposed icon is served on www.
    const blocked = fakeWeb({ "https://www.shop.com/apple-touch-icon-precomposed.png": img(png(180)) });
    expect(await findLogo("shop.com", blocked)).toMatchObject({ size: 180, origin: "https://www.shop.com/apple-touch-icon-precomposed.png" });
    // A 57px touch icon loses to a 256px icon.
    const tiny = fakeWeb({
      "https://old.com/": html(`<link rel="apple-touch-icon" href="/t57.png"><link rel="icon" sizes="256x256" href="/i256.png">`),
      "https://old.com/t57.png": img(png(57)),
      "https://old.com/i256.png": img(png(256)),
    });
    expect(await findLogo("old.com", tiny)).toMatchObject({ size: 256 });
  });
  test("an HTML error page served as an image is not a logo", async () => {
    const web = fakeWeb({ "https://nologo.com/favicon.ico": html("<html>nope</html>") });
    expect(await findLogo("nologo.com", web)).toBeNull();
  });
});

describe("logo service and routes", () => {
  const me = "alice@example.com";
  function env(descriptions: string[], web: LogoFetcher) {
    const audit: unknown[] = [];
    const ctx = {
      config: { allowedUsers: new Set([me]) },
      db: openDb(":memory:"),
      audit: { append: async (e: unknown) => void audit.push(e) },
      hledger: { transactions: async () => descriptions.map((d) => ({ tdescription: d })) },
      logoFetcher: web,
    } as unknown as ServiceContext;
    const call = (method: string, path: string, body?: unknown) =>
      createFetchHandler(ctx)(new Request(`http://x/api/v1${path}`, { method, headers: { "Tailscale-User-Login": me }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    return { ctx, call, audit };
  }

  test("images are fetched once, cached, and served with a locked-down CSP", async () => {
    const web = fakeWeb({ "https://chevron.com/": html(`<link rel="apple-touch-icon" href="/t.png">`), "https://chevron.com/t.png": img(png(180)) });
    const { call } = env([], web);
    const res = await call("GET", "/logos/img/chevron.com");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    const n = web.calls.length;
    expect((await call("GET", "/logos/img/www.chevron.com")).status).toBe(200);
    expect(web.calls.length).toBe(n);
    expect((await call("GET", "/logos/img/nothing-here.com")).status).toBe(404);
    expect((await call("GET", "/logos/img/localhost")).status).toBe(400);
  });

  test("turning fetching off stops outbound requests", async () => {
    const web = fakeWeb({});
    const { ctx, call } = env([], web);
    ctx.db.query("INSERT INTO settings (key, value) VALUES ('ui.logos_fetch', 'off')").run();
    expect((await call("GET", "/logos/img/example.com")).status).toBe(404);
    expect(web.calls).toEqual([]);
    expect((await call("POST", "/logos/prefetch")).status).toBe(409);
  });

  test("payee map, overrides and coverage", async () => {
    const web = fakeWeb({ "https://chevron.com/": html(`<link rel="apple-touch-icon" href="/t.png">`), "https://chevron.com/t.png": img(png(180)) });
    const { ctx, call, audit } = env(["Chevron | 10/01 CHEVRON #12", "Chevron", "Mobile Deposit", "Maple Street Bakery | SQ *MAPLE STREET"], web);
    expect(await payeeLogos(ctx)).toEqual({ chevron: { domain: "chevron.com" }, "mobile deposit": { glyph: "deposit" }, "maple street bakery": null });

    let cov = await logoCoverage(ctx);
    expect(cov.transactions).toEqual({ total: 4, covered: 1 });
    expect(cov.missing.map((m) => [m.key, m.status])).toEqual([
      ["chevron", "pending"],
      ["maple street bakery", "none"],
    ]);

    const pre = await (await call("POST", "/logos/prefetch")).json();
    expect(pre).toMatchObject({ domains: 1, fetched: 1, found: 1 });
    expect(pre.coverage.transactions).toEqual({ total: 4, covered: 3 });

    expect((await call("PUT", "/logos/payees/MAPLE%20STREET%20BAKERY", { domain: "https://maplestreetbakery.com/menu" })).status).toBe(200);
    expect((await payeeLogos(ctx))["maple street bakery"]).toEqual({ domain: "maplestreetbakery.com" });
    expect((await call("PUT", "/logos/payees/Chevron", { domain: null })).status).toBe(200);
    expect((await payeeLogos(ctx))["chevron"]).toBeNull();
    expect((await call("DELETE", "/logos/payees/Chevron")).status).toBe(200);
    expect((await payeeLogos(ctx))["chevron"]).toEqual({ domain: "chevron.com" });
    expect((await call("PUT", "/logos/payees/Chevron", { domain: "not a domain" })).status).toBe(400);
    expect((await call("PUT", "/logos/payees/Chevron", { glyph: "rocket" })).status).toBe(400);
    expect(audit.filter((a: any) => a.operation === "logo.payee.set")).toHaveLength(3);

    // Setting a domain starts fetching it straight away (this joins that fetch); this fake web has nothing there.
    await logoImage(ctx, "maplestreetbakery.com");
    cov = await logoCoverage(ctx);
    expect(cov.missing.find((m) => m.key === "maple street bakery")?.status).toBe("not_found");
    // ...so the UI's map marks it missing (initials, no image request) but keeps the website.
    const map = (await (await call("GET", "/logos")).json()).payees;
    expect(map["maple street bakery"]).toEqual({ domain: "maplestreetbakery.com", missing: true });
    expect(map["mobile deposit"]).toEqual({ glyph: "deposit" });
  });

  test("an account's logo domain can be set and cleared", async () => {
    const { ctx, call } = env([], fakeWeb({}));
    ctx.db.query("INSERT INTO entities (slug, name, type, created_at) VALUES ('personal', 'Personal', 'personal', '')").run();
    ctx.db.query("INSERT INTO accounts (slug, name, hledger_account, kind, default_entity, created_at) VALUES ('chk', 'Joint checking', 'Assets:Checking:Joint', 'bank', 'personal', '')").run();
    const logo = () => (ctx.db.query("SELECT logo_domain FROM accounts WHERE slug = 'chk'").get() as { logo_domain: string | null }).logo_domain;
    expect((await call("PATCH", "/accounts/chk", { logoDomain: "https://www.chase.com/" })).status).toBe(200);
    expect(logo()).toBe("chase.com");
    expect((await call("PATCH", "/accounts/chk", { logoDomain: "nope" })).status).toBe(400);
    expect(logo()).toBe("chase.com");
    expect((await call("PATCH", "/accounts/chk", { logoDomain: null })).status).toBe(200);
    expect(logo()).toBeNull();
  });

  test("the payee map versions image URLs by content", async () => {
    const { ctx, call } = env(["Chevron"], fakeWeb({ "https://chevron.com/": html(`<link rel="apple-touch-icon" href="/t.png">`), "https://chevron.com/t.png": img(png(180)) }));
    expect((await (await call("GET", "/logos")).json()).payees.chevron).toEqual({ domain: "chevron.com" });
    await prefetchLogos(ctx);
    const first = (await (await call("GET", "/logos")).json()).payees.chevron;
    expect(first).toEqual({ domain: "chevron.com", v: expect.any(String) });
    ctx.logoFetcher = fakeWeb({ "https://chevron.com/": html(`<link rel="apple-touch-icon" href="/t.png">`), "https://chevron.com/t.png": img(png(192)) });
    await prefetchLogos(ctx, { force: true });
    const second = (await (await call("GET", "/logos")).json()).payees.chevron;
    expect(second.v).not.toBe(first.v);
  });

  test("logos are kept indefinitely; a miss is retried only when asked, at most every 10 minutes", async () => {
    const { ctx, call } = env([], fakeWeb({}));
    expect((await call("GET", "/logos/img/shop.com")).status).toBe(404);
    // The site gains a logo, but nothing asks again on its own.
    const web = fakeWeb({ "https://shop.com/apple-touch-icon.png": img(png(180)) });
    ctx.logoFetcher = web;
    expect((await call("GET", "/logos/img/shop.com")).status).toBe(404);
    expect(await prefetchLogos(ctx)).toMatchObject({ fetched: 0 });
    expect(web.calls).toEqual([]);
    // Opening a transaction retries, but not again within 10 minutes of the last look.
    expect(await (await call("POST", "/logos/img/shop.com/retry")).json()).toEqual({ domain: "shop.com", found: false, retried: false });
    ctx.db.query("UPDATE logo_cache SET fetched_at = ? WHERE domain = 'shop.com'").run(new Date(Date.now() - 11 * 60_000).toISOString());
    expect(await (await call("POST", "/logos/img/shop.com/retry")).json()).toEqual({ domain: "shop.com", found: true, retried: true });
    expect((await call("GET", "/logos/img/shop.com")).status).toBe(200);
    // A logo already found is never refetched by a retry, however old it is.
    ctx.db.query("UPDATE logo_cache SET fetched_at = '2000-01-01T00:00:00.000Z'").run();
    const n = web.calls.length;
    expect(await (await call("POST", "/logos/img/shop.com/retry")).json()).toMatchObject({ found: true, retried: false });
    expect((await call("GET", "/logos/img/shop.com")).status).toBe(200);
    expect(web.calls.length).toBe(n);
  });

  test("wmma logos import sets payee and account websites through the API", async () => {
    const { ctx } = env(["Maple Street Bakery | SQ *MAPLE STREET"], fakeWeb({}));
    ctx.db.query("INSERT INTO entities (slug, name, type, created_at) VALUES ('personal', 'Personal', 'personal', '')").run();
    ctx.db.query("INSERT INTO accounts (slug, name, hledger_account, kind, default_entity, created_at) VALUES ('chk', 'Joint checking', 'Assets:Checking:Joint', 'bank', 'personal', '')").run();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createFetchHandler(ctx) });
    const file = `${require("node:os").tmpdir()}/wmma-logos-${process.pid}.json`;
    await Bun.write(file, JSON.stringify({ payees: { "Maple Street Bakery": "maplestreetbakery.com", Other: "not a domain" }, accounts: { chk: "examplecu.org" } }));
    const env0 = { port: process.env.WMMA_PORT, users: process.env.WMMA_ALLOWED_USERS };
    process.env.WMMA_PORT = String(server.port);
    process.env.WMMA_ALLOWED_USERS = me;
    try {
      expect(await runCli("logos", ["import", file])).toBe(1); // one bad entry
    } finally {
      server.stop(true);
      process.env.WMMA_PORT = env0.port;
      process.env.WMMA_ALLOWED_USERS = env0.users;
      if (env0.port === undefined) delete process.env.WMMA_PORT;
      if (env0.users === undefined) delete process.env.WMMA_ALLOWED_USERS;
      require("node:fs").rmSync(file, { force: true });
    }
    expect((await payeeLogos(ctx))["maple street bakery"]).toEqual({ domain: "maplestreetbakery.com" });
    expect((ctx.db.query("SELECT logo_domain FROM accounts WHERE slug = 'chk'").get() as { logo_domain: string }).logo_domain).toBe("examplecu.org");
  });

  test("a failed refresh keeps the logo already cached", async () => {
    const web = fakeWeb({ "https://shop.com/": html(`<link rel="apple-touch-icon" href="/t.png">`), "https://shop.com/t.png": img(png(180)) });
    const { ctx } = env([], web);
    expect(await logoImage(ctx, "shop.com")).not.toBeNull();
    ctx.logoFetcher = fakeWeb({});
    expect(await logoImage(ctx, "shop.com", { force: true })).not.toBeNull();
    await setPayeeLogo(ctx, me, "Shop", { glyph: "cash" });
    expect((await payeeLogos(ctx))["shop"]).toBeUndefined(); // not in the journal
  });
});
