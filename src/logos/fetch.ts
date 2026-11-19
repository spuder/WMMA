/**
 * Find a merchant's logo from its own website, with public favicon services as fallbacks.
 * Only the domain leaves the server; nothing about transactions is sent anywhere.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Fetch one URL without following redirects. Injectable for tests. */
export type LogoFetcher = (url: URL, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export interface LogoImage {
  bytes: Uint8Array;
  contentType: string;
  /** Smaller of width and height in pixels (SVG counts as 512). */
  size: number;
  /** Where it came from, for debugging. */
  origin: string;
}

/** Smaller than this is treated as no logo at all (the UI shows small icons unscaled). */
export const MIN_SIZE = 16;
/** Stop looking once a logo this large is found. */
const GOOD_SIZE = 128;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 WMMA-logos";

// ---- network guard ---------------------------------------------------------

function privateV4(ip: string): boolean {
  const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b < 128) || // CGNAT, including Tailscale
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b < 32) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** An IPv6 address as 16 bytes, accepting every textual form (::, embedded dotted IPv4, zone ids). */
function v6Bytes(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, "");
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (dotted) {
    const q = dotted.slice(1).map(Number);
    if (q.some((n) => n > 255)) return null;
    s = s.slice(0, dotted.index) + ((q[0]! << 8) | q[1]!).toString(16) + ":" + ((q[2]! << 8) | q[3]!).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (h: string) => (h ? h.split(":") : []);
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    out.push(n >> 8, n & 255);
  }
  return out;
}

/**
 * Loopback, private, link-local, CGNAT (Tailscale), multicast, documentation and other
 * non-public addresses, in any textual form. IPv6 forms that carry an IPv4 address
 * (mapped, compatible, NAT64, 6to4) are judged by that address; unparseable input counts as private.
 */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return privateV4(ip);
  const b = v6Bytes(ip);
  if (!b) return true;
  const v4 = (at: number) => privateV4(b.slice(at, at + 4).join("."));
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4(12); // ::ffff:a.b.c.d
  if (zero(0, 12)) return true; // ::, ::1 and deprecated ::a.b.c.d
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return true; // NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return v4(2); // 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true; // Teredo
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // documentation
  if (b[0] === 0x01 && b[1] === 0x00 && zero(2, 8)) return true; // discard-only
  if ((b[0]! & 0xfe) === 0xfc) return true; // unique local fc00::/7
  if (b[0] === 0xfe && (b[1]! & 0xc0) !== 0) return true; // link-local fe80::/10, site-local fec0::/10
  return b[0] === 0xff; // multicast
}

const DNS_TIMEOUT = 5000;

async function resolveHost(host: string): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`DNS lookup for ${host} timed out`)), DNS_TIMEOUT);
  });
  try {
    return (await Promise.race([lookup(host, { all: true }), timeout])).map((a) => a.address);
  } finally {
    clearTimeout(timer);
  }
}

/** The default fetcher: public http(s) hosts on standard ports only. */
export const guardedFetch: LogoFetcher = async (url, init) => {
  init.signal.throwIfAborted();
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`refusing ${url.protocol} URL`);
  if (url.port && url.port !== "80" && url.port !== "443") throw new Error("refusing non-standard port");
  if (url.username || url.password) throw new Error("refusing URL with credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [host] : await resolveHost(host);
  if (addrs.length === 0 || addrs.some(isPrivateAddress)) throw new Error(`refusing private address for ${host}`);
  return fetch(url, { ...init, redirect: "manual" });
};

/** GET with manual redirects (each hop re-checked by the fetcher) and a body size cap. */
async function get(fetcher: LogoFetcher, start: string | URL, maxBytes: number, deadline?: AbortSignal): Promise<{ url: URL; type: string; body: Uint8Array } | null> {
  let url = new URL(start);
  for (let hop = 0; hop < 5; hop++) {
    let res: Response;
    try {
      res = await fetcher(url, { headers: { "user-agent": UA, accept: "text/html,image/*,application/json;q=0.9,*/*;q=0.5" }, signal: deadline ? AbortSignal.any([AbortSignal.timeout(8000), deadline]) : AbortSignal.timeout(8000) });
    } catch {
      return null;
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel();
      if (!loc) return null;
      url = new URL(loc, url);
      continue;
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      return null;
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > maxBytes) {
      await res.body.cancel();
      return null;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > maxBytes) return null;
        chunks.push(chunk);
      }
    } catch {
      return null;
    }
    const body = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      body.set(c, at);
      at += c.byteLength;
    }
    return { url, type: (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase(), body };
  }
  return null;
}

// ---- image sniffing --------------------------------------------------------

const be16 = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const le16 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const be32 = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + ((b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!);
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

/** Identify an image by its bytes (never trusting Content-Type) and measure it. */
export function sniffImage(b: Uint8Array): { type: string; size: number } | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG" && b.length >= 24) return { type: "image/png", size: Math.min(be32(b, 16), be32(b, 20)) };
  if (ascii(b, 0, 4) === "GIF8" && b.length >= 10) return { type: "image/gif", size: Math.min(le16(b, 6), le16(b, 8)) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length && b[i] === 0xff) {
      const m = b[i + 1]!;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { type: "image/jpeg", size: Math.min(be16(b, i + 5), be16(b, i + 7)) };
      i += 2 + be16(b, i + 2);
    }
    return null;
  }
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP" && b.length >= 30) {
    const chunk = ascii(b, 12, 4);
    if (chunk === "VP8 ") return { type: "image/webp", size: Math.min(le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff) };
    if (chunk === "VP8L") {
      const w = 1 + (((b[22]! & 0x3f) << 8) | b[21]!);
      const h = 1 + (((b[24]! & 0x0f) << 10) | (b[23]! << 2) | ((b[22]! & 0xc0) >> 6));
      return { type: "image/webp", size: Math.min(w, h) };
    }
    if (chunk === "VP8X") return { type: "image/webp", size: Math.min(1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16))) };
    return null;
  }
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) {
    const n = le16(b, 4);
    let size = 0;
    for (let k = 0; k < n && 6 + 16 * k + 16 <= b.length; k++) {
      const w = b[6 + 16 * k] || 256;
      const h = b[7 + 16 * k] || 256;
      size = Math.max(size, Math.min(w, h));
    }
    return n > 0 && size > 0 ? { type: "image/x-icon", size } : null;
  }
  const head = new TextDecoder().decode(b.subarray(0, 4096)).replace(/^﻿/, "").trimStart();
  if (/^(<\?xml|<!--|<!doctype svg|<svg)/i.test(head) && /<svg[\s>]/i.test(head)) return { type: "image/svg+xml", size: 512 };
  return null;
}

// ---- icon discovery --------------------------------------------------------

interface Candidate {
  url: URL;
  /** Declared size; used only to decide what to try first. */
  declared: number;
  /** Declared with rel="apple-touch-icon". */
  apple?: boolean;
}

const attrs = (tag: string): Record<string, string> =>
  Object.fromEntries([...tag.matchAll(/([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)].map((m) => [m[1]!.toLowerCase(), (m[3] ?? m[4] ?? m[5] ?? "").trim()]));

const declaredSize = (sizes: string | undefined, href: string): number => {
  if (/\.svg(\?|$)/i.test(href) || sizes === "any") return 512;
  const nums = [...(sizes ?? "").matchAll(/(\d+)x(\d+)/gi)].map((m) => Math.min(Number(m[1]), Number(m[2])));
  return nums.length ? Math.max(...nums) : 0;
};

const decodeEntities = (s: string) => s.replace(/&amp;/g, "&").replace(/&#x2f;/gi, "/").replace(/&#47;/g, "/");

/** Icon links and the manifest URL from a page's HTML. */
export function iconLinks(html: string, base: URL): { icons: Candidate[]; manifest: URL | null } {
  const icons: Candidate[] = [];
  let manifest: URL | null = null;
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const rel = (a["rel"] ?? "").toLowerCase().split(/\s+/);
    const href = decodeEntities(a["href"] ?? "");
    if (!href || href.startsWith("data:")) continue;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (rel.includes("manifest")) manifest ??= url;
    else if (rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed")) icons.push({ url, declared: declaredSize(a["sizes"], href) || 180, apple: true });
    else if (rel.includes("icon") && !rel.includes("mask-icon")) icons.push({ url, declared: declaredSize(a["sizes"], href) || 16 });
  }
  return { icons, manifest };
}

/** Icons listed in a web app manifest, skipping monochrome ones. */
export function manifestIcons(json: unknown, base: URL): Candidate[] {
  const icons = (json as { icons?: unknown })?.icons;
  if (!Array.isArray(icons)) return [];
  const out: Candidate[] = [];
  for (const i of icons as Array<Record<string, unknown>>) {
    if (typeof i?.src !== "string" || i.src.startsWith("data:")) continue;
    if (typeof i.purpose === "string" && /monochrome/.test(i.purpose)) continue;
    try {
      out.push({ url: new URL(i.src, base), declared: declaredSize(typeof i.sizes === "string" ? i.sizes : undefined, i.src) || 48 });
    } catch {
      // bad src
    }
  }
  return out;
}

async function image(fetcher: LogoFetcher, url: URL | string, origin: string, deadline?: AbortSignal): Promise<LogoImage | null> {
  const r = await get(fetcher, url, 512 * 1024, deadline);
  if (!r) return null;
  const info = sniffImage(r.body);
  return info ? { bytes: r.body, contentType: info.type, size: info.size, origin } : null;
}

/** The best logo for a domain, or null if nothing at least MIN_SIZE was found. */
/**
 * However many URLs a site makes us try, stop trying its own icons after this long. The
 * favicon services after it get their own per-request timeouts, so a slow or blocking site
 * still ends up with a logo (worst case about 20s + 3 x 8s).
 */
const SITE_DEADLINE = 20_000;

/**
 * The best logo for a site. Apple touch icons come first: they're the square, full-color
 * icon a site designs for phone home screens, and usually its best-looking logo. Then the
 * site's other icons (largest declared first), then public favicon services.
 */
export async function findLogo(domain: string, fetcher: LogoFetcher = guardedFetch, deadline: AbortSignal = AbortSignal.timeout(SITE_DEADLINE)): Promise<LogoImage | null> {
  let best: LogoImage | null = null;
  const consider = (img: LogoImage | null) => {
    if (img && img.size >= MIN_SIZE && (!best || img.size > best.size)) best = img;
    return best !== null && (best as LogoImage).size >= GOOD_SIZE;
  };
  const tried = new Set<string>();
  const attempt = async (url: URL) => {
    if (tried.has(url.href) || tried.size >= 10) return false;
    tried.add(url.href);
    return consider(await image(fetcher, url, url.href, deadline));
  };

  const bare = domain.replace(/^www\./, "");
  let page = await get(fetcher, `https://${bare}/`, 2 * 1024 * 1024, deadline);
  page ??= await get(fetcher, `https://www.${bare}/`, 2 * 1024 * 1024, deadline);
  const icons: Candidate[] = [];
  if (page) {
    const links = iconLinks(new TextDecoder().decode(page.body), page.url);
    icons.push(...links.icons);
    if (links.manifest) {
      const m = await get(fetcher, links.manifest, 256 * 1024, deadline);
      if (m) {
        try {
          icons.push(...manifestIcons(JSON.parse(new TextDecoder().decode(m.body)), m.url));
        } catch {
          // not JSON
        }
      }
    }
  }
  icons.sort((a, b) => b.declared - a.declared);

  // 1. Apple touch icons: declared ones, then the conventional paths (which sites that
  //    block page loads often still serve).
  const appleUrls = icons.filter((c) => c.apple).map((c) => c.url);
  for (const base of page ? [page.url] : [new URL(`https://www.${bare}/`), new URL(`https://${bare}/`)]) {
    for (const f of ["/apple-touch-icon.png", "/apple-touch-icon-precomposed.png"]) appleUrls.push(new URL(f, base));
  }
  for (const url of appleUrls) if (await attempt(url)) return best;

  // 2. The site's other icons.
  for (const c of icons) if (!c.apple && (await attempt(c.url))) return best;

  // 3. Public favicon services, which also cover sites that block non-browser clients.
  const google = `https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${bare}&size=256`;
  if (consider(await image(fetcher, google, "google"))) return best;
  if (consider(await image(fetcher, `https://icons.duckduckgo.com/ip3/${bare}.ico`, "duckduckgo"))) return best;

  // 4. The classic location.
  if (!best) consider(await image(fetcher, `https://${bare}/favicon.ico`, "favicon.ico"));
  return best;
}
