/** Merchant/bank logos: one payee -> logo map shared by every Avatar on the page. */
import { useEffect, useState } from "preact/hooks";
import { api } from "./api";

/**
 * As the server sends it: `v` versions the image URL, and `missing` means the site has no
 * usable icon (initials, but the website is still known).
 */
export type Logo = { domain: string; v?: string; missing?: boolean } | { glyph: string } | null;

/** Same normalisation as the server's payeeKey(): "ARBY'S #12" -> "arby s". */
export const payeeKey = (payee: string) =>
  payee
    .toLowerCase()
    .replace(/[^a-z\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** `v` changes whenever the image does, so browsers never show a stale cached copy. */
export const logoUrl = (domain: string, v?: string) => `/api/v1/logos/img/${encodeURIComponent(domain)}${v ? `?v=${encodeURIComponent(v)}` : ""}`;

export const GLYPH_EMOJI: Record<string, string> = {
  transfer: "🔄",
  deposit: "📥",
  payroll: "💵",
  interest: "🏦",
  dividend: "📈",
  cashback: "💰",
  tax: "🏛️",
  fee: "🧾",
  cash: "🏧",
  car: "🚗",
  home: "🏠",
  asset: "📦",
};

let map: Record<string, Logo> | null = null;
let pending: Promise<void> | null = null;
let latest = 0;
const listeners = new Set<() => void>();

/** (Re)load the payee map; every mounted Avatar re-renders when it arrives. */
export function loadLogos(force = false): Promise<void> {
  if (!pending || force) {
    const seq = ++latest;
    pending = api<{ payees: Record<string, Logo> }>("/logos")
      .then((r) => {
        // An older request that lands late mustn't overwrite a newer map.
        if (seq !== latest) return;
        map = r.payees;
        for (const l of listeners) l();
      })
      .catch(() => {
        // Logos are decoration: initials stay, and the next Avatar to mount tries again.
        if (seq === latest) pending = null;
      });
  }
  return pending;
}

/** Look again for a logo on a site that had none (opening a transaction calls this). */
export async function retryLogo(domain: string): Promise<void> {
  const r = await api<{ found: boolean; retried: boolean }>(`/logos/img/${encodeURIComponent(domain)}/retry`, { method: "POST" });
  if (r.retried && r.found) await loadLogos(true);
}

/** The logo for a payee; undefined until the map has loaded. */
export function usePayeeLogo(payee: string | null): Logo | undefined {
  const [, rerender] = useState(0);
  useEffect(() => {
    if (payee === null) return;
    const l = () => rerender((n) => n + 1);
    listeners.add(l);
    if (!map) void loadLogos();
    return () => {
      listeners.delete(l);
    };
  }, [payee === null]);
  if (payee === null || !map) return undefined;
  return map[payeeKey(payee)] ?? null;
}
