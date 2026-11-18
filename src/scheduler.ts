/**
 * Minimal in-process cron: standard 5-field expressions (minute hour
 * day-of-month month day-of-week) with *, lists, ranges and steps, evaluated
 * in an IANA timezone. Checked once a minute.
 */

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
] as const;

export type CronSpec = [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];

export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron expression needs 5 fields, got ${JSON.stringify(expr)}`);
  return parts.map((part, i) => {
    const { name, min, max } = FIELDS[i]!;
    const out = new Set<number>();
    for (const item of part.split(",")) {
      const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
      if (!m) throw new Error(`invalid cron ${name} field ${JSON.stringify(part)}`);
      const lo = m[1] === "*" ? min : Number(m[2]);
      const hi = m[1] === "*" ? max : m[3] !== undefined ? Number(m[3]) : m[4] ? max : lo;
      const step = m[4] ? Number(m[4]) : 1;
      if (lo < min || hi > max || lo > hi || step < 1) throw new Error(`cron ${name} out of range: ${JSON.stringify(item)}`);
      for (let v = lo; v <= hi; v += step) out.add(i === 4 && v === 7 ? 0 : v);
    }
    return out;
  }) as CronSpec;
}

function partsIn(date: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    minute: "numeric",
    hour: "numeric",
    day: "numeric",
    month: "numeric",
    weekday: "short",
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p["weekday"]!);
  return [Number(p["minute"]), Number(p["hour"]), Number(p["day"]), Number(p["month"]), dow] as const;
}

export function cronMatches(spec: CronSpec, date: Date, tz: string): boolean {
  const [mi, h, dom, mon, dow] = partsIn(date, tz);
  if (!spec[0].has(mi) || !spec[1].has(h) || !spec[3].has(mon)) return false;
  // Standard cron: if both day fields are restricted, either may match.
  const domAll = spec[2].size === 31;
  const dowAll = spec[4].size === 7;
  if (domAll || dowAll) return spec[2].has(dom) && spec[4].has(dow);
  return spec[2].has(dom) || spec[4].has(dow);
}

/** Run `fn` whenever `expr` matches. Returns a stop function. */
export function schedule(expr: string, tz: string, fn: () => Promise<unknown>, log = console.error): () => void {
  const spec = parseCron(expr);
  let lastMinute = -1;
  let running = false;
  const tick = () => {
    const now = new Date();
    const minute = Math.floor(now.getTime() / 60_000);
    if (minute === lastMinute || !cronMatches(spec, now, tz)) return;
    lastMinute = minute;
    if (running) return;
    running = true;
    fn()
      .catch((e) => log(`[scheduler] ${expr}: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => (running = false));
  };
  const timer = setInterval(tick, 15_000);
  return () => clearInterval(timer);
}
