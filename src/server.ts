import { authenticate, type Identity } from "./auth/tailscale";
import type { Config } from "./config";
import type { HledgerWebClient } from "./hledger/web";

export interface AppDeps {
  config: Config;
  hledger: HledgerWebClient;
}

type Handler = (req: Request, identity: Identity, deps: AppDeps) => Response | Promise<Response>;

const routes: Record<string, Handler> = {
  "GET /api/v1/status": async (_req, identity, { config, hledger }) => {
    let hledgerVersion: string | null = null;
    try {
      hledgerVersion = await hledger.version();
    } catch {
      // reported as null
    }
    return Response.json({ user: identity.login, hledgerWeb: hledgerVersion, timezone: config.tz });
  },
};

export function createFetchHandler(deps: AppDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    // Bun leaves req.url relative when the client sends no Host header
    // (e.g. a bare HTTP/1.0 request), so parse against a placeholder base.
    const url = new URL(req.url, "http://localhost");
    // Unauthenticated liveness probe for Docker's healthcheck; reveals nothing.
    if (url.pathname === "/healthz") return new Response("ok\n");

    const auth = authenticate(req, deps.config.allowedUsers);
    if (!auth.ok) return auth.response;

    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return Response.json({ error: "not found" }, { status: 404 });
    try {
      return await handler(req, auth.identity, deps);
    } catch (e) {
      console.error(e);
      return Response.json({ error: "internal error" }, { status: 500 });
    }
  };
}
