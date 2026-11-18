/**
 * Tailscale identity auth. Tailscale Serve sets these headers on proxied
 * requests (and strips client-supplied copies). They are only trustworthy
 * because the app listens on localhost behind Serve (SPEC §2).
 */

export const LOGIN_HEADER = "Tailscale-User-Login";
export const NAME_HEADER = "Tailscale-User-Name";

export interface Identity {
  login: string;
  name: string | null;
}

export type AuthResult = { ok: true; identity: Identity } | { ok: false; response: Response };

function deny(status: 401 | 403, error: string): AuthResult {
  return { ok: false, response: Response.json({ error }, { status }) };
}

export function authenticate(req: Request, allowedUsers: ReadonlySet<string>): AuthResult {
  const login = req.headers.get(LOGIN_HEADER)?.trim().toLowerCase();
  if (!login) return deny(401, "missing Tailscale identity");
  if (!allowedUsers.has(login)) return deny(403, `Tailscale user ${login} is not allowed`);
  return { ok: true, identity: { login, name: req.headers.get(NAME_HEADER) } };
}
