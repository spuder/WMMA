/**
 * Money: integer cents behind a branded type. All money math lives here.
 * Floats are never used to represent or compute amounts (SPEC §2).
 * V1 is USD only.
 */

declare const MoneyBrand: unique symbol;
export type Money = number & { readonly [MoneyBrand]: true };

export class MoneyError extends Error {
  override name = "MoneyError";
}

function check(n: number): Money {
  if (!Number.isSafeInteger(n)) throw new MoneyError(`not a safe integer number of cents: ${n}`);
  // Normalise -0 to 0 so equality and formatting behave.
  return (n === 0 ? 0 : n) as Money;
}

export const ZERO: Money = 0 as Money;

/** Construct from an integer number of cents. */
export function cents(n: number): Money {
  return check(n);
}

/** Integer cents of a Money value, for storage (e.g. SQLite INTEGER columns). */
export function toCents(m: Money): number {
  return m;
}

const DECIMAL_RE = /^(-)?\$?(-)?(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d+))?$/;

/**
 * Parse a decimal string at an input boundary: "12", "1,234.56", "-4.5",
 * "$-4.50", "-$4.50", "(4.50)" (accounting negative), "+3.00".
 * Throws if the value has non-zero precision beyond cents.
 */
export function parse(input: string): Money {
  let s = input.trim().replace(/\s+/g, "");
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("+")) s = s.slice(1);
  const m = DECIMAL_RE.exec(s);
  if (!m || (m[3] === undefined && m[4] === undefined)) {
    throw new MoneyError(`invalid amount: ${JSON.stringify(input)}`);
  }
  const signs = (m[1] ? 1 : 0) + (m[2] ? 1 : 0);
  if (signs > 1) throw new MoneyError(`invalid amount: ${JSON.stringify(input)}`);
  if (signs === 1) {
    if (negative) throw new MoneyError(`invalid amount: ${JSON.stringify(input)}`);
    negative = true;
  }
  const whole = (m[3] ?? "0").replaceAll(",", "");
  const frac = m[4] ?? "";
  if (/[1-9]/.test(frac.slice(2))) {
    throw new MoneyError(`amount has sub-cent precision: ${JSON.stringify(input)}`);
  }
  const c = BigInt(whole) * 100n + BigInt(frac.slice(0, 2).padEnd(2, "0"));
  if (c > BigInt(Number.MAX_SAFE_INTEGER)) throw new MoneyError(`amount too large: ${JSON.stringify(input)}`);
  return check(negative ? -Number(c) : Number(c));
}

/**
 * Convert an hledger JSON quantity ({decimalMantissa, decimalPlaces}) to Money
 * without touching its floatingPoint field.
 */
export function fromHledgerQuantity(q: { decimalMantissa: number; decimalPlaces: number }): Money {
  const { decimalMantissa: mant, decimalPlaces: places } = q;
  if (!Number.isSafeInteger(mant) || !Number.isInteger(places) || places < 0) {
    throw new MoneyError(`invalid hledger quantity: ${JSON.stringify(q)}`);
  }
  if (places <= 2) return check(mant * 10 ** (2 - places));
  const div = 10n ** BigInt(places - 2);
  const big = BigInt(mant);
  if (big % div !== 0n) throw new MoneyError(`hledger quantity has sub-cent precision: ${JSON.stringify(q)}`);
  return check(Number(big / div));
}

export function add(a: Money, b: Money): Money {
  return check(a + b);
}

export function sub(a: Money, b: Money): Money {
  return check(a - b);
}

export function neg(a: Money): Money {
  return check(-a);
}

export function abs(a: Money): Money {
  return check(Math.abs(a));
}

/** Multiply by an integer factor (e.g. a count). */
export function times(a: Money, factor: number): Money {
  if (!Number.isInteger(factor)) throw new MoneyError(`factor must be an integer: ${factor}`);
  return check(a * factor);
}

export function sum(values: Iterable<Money>): Money {
  let total = 0;
  for (const v of values) total = check(total + v);
  return check(total);
}

export function isZero(a: Money): boolean {
  return a === 0;
}

export function isNegative(a: Money): boolean {
  return a < 0;
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function equals(a: Money, b: Money): boolean {
  return a === b;
}

/**
 * Split an amount by integer weights using the largest-remainder method.
 * The parts always sum exactly to the original amount.
 */
export function allocate(total: Money, weights: readonly number[]): Money[] {
  if (weights.length === 0) throw new MoneyError("allocate needs at least one weight");
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) {
    throw new MoneyError("weights must be non-negative integers");
  }
  const wsum = weights.reduce((a, b) => a + b, 0);
  if (wsum === 0) throw new MoneyError("weights must not all be zero");
  const sign = total < 0 ? -1n : 1n;
  const t = BigInt(Math.abs(total));
  const W = BigInt(wsum);
  const parts = weights.map((w) => (t * BigInt(w)) / W);
  const rems = weights.map((w, i) => ({ i, r: (t * BigInt(w)) % W }));
  let left = t - parts.reduce((a, b) => a + b, 0n);
  rems.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (let k = 0; left > 0n; k++, left--) {
    const idx = rems[k % rems.length]!.i;
    parts[idx] = parts[idx]! + 1n;
  }
  return parts.map((p) => check(Number(p * sign)));
}

function digits(m: Money): { sign: string; whole: string; frac: string } {
  const a = Math.abs(m);
  return {
    sign: m < 0 ? "-" : "",
    whole: Math.floor(a / 100).toString(),
    frac: (a % 100).toString().padStart(2, "0"),
  };
}

/** Human display: "$1,234.56", "-$4.50". */
export function format(m: Money): string {
  const { sign, whole, frac } = digits(m);
  return `${sign}$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
}

/** hledger journal amount: "$1234.56", "$-4.50" (no digit grouping, so it parses unambiguously). */
export function toJournal(m: Money): string {
  const { sign, whole, frac } = digits(m);
  return `$${sign}${whole}.${frac}`;
}
