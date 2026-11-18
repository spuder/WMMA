/**
 * DEVELOPMENT ONLY. Stands in for Tailscale Serve on your own machine: listens
 * on 127.0.0.1 and forwards to WMMA, adding the Tailscale-User-Login header.
 * Never run this where anyone else can reach it.
 *
 *   WMMA_DEV_USER=you@example.com bun scripts/dev-proxy.ts   # http://127.0.0.1:8080
 */
const user = process.env.WMMA_DEV_USER;
if (!user) {
  console.error("set WMMA_DEV_USER to a login listed in WMMA_ALLOWED_USERS");
  process.exit(2);
}
const target = `http://127.0.0.1:${process.env.WMMA_PORT || "3000"}`;
const port = Number(process.env.DEV_PROXY_PORT || 8080);
const hostname = process.env.DEV_PROXY_HOST || "127.0.0.1";
const name = process.env.WMMA_DEV_NAME || user;
Bun.serve({
  hostname,
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const headers = new Headers(req.headers);
    headers.delete("Tailscale-User-Login");
    headers.set("Tailscale-User-Login", user);
    headers.set("Tailscale-User-Name", name);
    return fetch(target + url.pathname + url.search, { method: req.method, headers, body: req.body, redirect: "manual" });
  },
});
console.log(`dev proxy: http://${hostname}:${port} -> ${target} as ${user}`);

export {};
