/**
 * Five-field cron expressions (SPEC H1). Implemented here rather than pulled
 * in as a dependency: the grammar is small and the edge cases (day-of-month vs
 * day-of-week, Sunday as 0 or 7, steps on ranges) are exactly what the tests
 * need to pin down.
 *
 *   ┌ minute (0-59)  ┌ hour (0-23)  ┌ day of month (1-31)  ┌ month (1-12, jan-dec)  ┌ day of week (0-7, sun-sat; 0 and 7 are Sunday)
 *   *  *  *  *  *
 *
 * Items: `*`, `n`, `a-b`, `*\/s`, `a-b/s`, `a/s` (a to the field max), comma lists.
 * Macros: @yearly @annually @monthly @weekly @daily @midnight @hourly.
 * Day matching follows Vixie cron: when both day fields are restricted, a day
 * matches if EITHER matches; when one is `*`, only the other one counts.
 *
 * Times are evaluated in UTC by default (EAG S16: "schedule in UTC"); a
 * schedule may opt into the machine's local time.
 */

export interface CronSpec {
  source: string;
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

export type CronTz = 'UTC' | 'local';

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export class CronError extends Error {}

interface FieldDef {
  name: string;
  min: number;
  max: number;
  names?: string[];
  /** offset added to a name's index (months are 1-based) */
  nameBase?: number;
}
const FIELDS: FieldDef[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS, nameBase: 1 },
  { name: 'day of week', min: 0, max: 7, names: DAYS, nameBase: 0 },
];

function value(tok: string, f: FieldDef): number {
  const lower = tok.toLowerCase();
  if (f.names) {
    const i = f.names.indexOf(lower);
    if (i >= 0) return i + (f.nameBase ?? 0);
  }
  if (!/^\d+$/.test(tok)) throw new CronError(`${f.name}: "${tok}" is not a number${f.names ? ` or a name (${f.names.join(', ')})` : ''}`);
  const n = Number(tok);
  if (n < f.min || n > f.max) throw new CronError(`${f.name}: ${n} is outside ${f.min}-${f.max}`);
  return n;
}

function parseField(text: string, f: FieldDef): { set: Set<number>; restricted: boolean } {
  const set = new Set<number>();
  if (!text) throw new CronError(`${f.name}: empty field`);
  for (const part of text.split(',')) {
    if (!part) throw new CronError(`${f.name}: empty list item in "${text}"`);
    const [range, stepText, extra] = part.split('/');
    if (extra !== undefined) throw new CronError(`${f.name}: too many "/" in "${part}"`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) === 0) throw new CronError(`${f.name}: step "${stepText}" must be a positive number`);
      step = Number(stepText);
    }
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = f.min;
      hi = f.max === 7 ? 6 : f.max; // `*` in day-of-week is 0-6 (7 is only an alias)
    } else if (range.includes('-')) {
      const [a, b, more] = range.split('-');
      if (more !== undefined || !a || !b) throw new CronError(`${f.name}: bad range "${range}"`);
      lo = value(a, f);
      hi = value(b, f);
      if (lo > hi) throw new CronError(`${f.name}: range ${range} runs backwards`);
    } else {
      lo = value(range, f);
      hi = stepText !== undefined ? (f.max === 7 ? 6 : f.max) : lo; // "a/s" = from a to the max
    }
    for (let v = lo; v <= hi; v += step) set.add(f.max === 7 && v === 7 ? 0 : v);
  }
  return { set, restricted: text !== '*' && !/^\*\/1$/.test(text) };
}

export function parseCron(expr: string): CronSpec {
  const source = expr.trim();
  if (!source) throw new CronError('empty cron expression');
  if (source.startsWith('@')) {
    if (source === '@reboot') throw new CronError('@reboot is not supported; use a file-watch or webhook trigger, or run the job when the daemon starts');
    const m = MACROS[source.toLowerCase()];
    if (!m) throw new CronError(`unknown macro ${source}`);
    return { ...parseCron(m), source };
  }
  const parts = source.split(/\s+/);
  if (parts.length !== 5) throw new CronError(`expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}: "${source}"`);
  const [mi, ho, dm, mo, dw] = parts.map((p, i) => parseField(p, FIELDS[i]));
  return { source, minute: mi.set, hour: ho.set, dom: dm.set, month: mo.set, dow: dw.set, domRestricted: dm.restricted, dowRestricted: dw.restricted };
}

interface Parts {
  minute: number;
  hour: number;
  dom: number;
  month: number;
  dow: number;
  year: number;
}

function partsOf(d: Date, tz: CronTz): Parts {
  return tz === 'UTC'
    ? { minute: d.getUTCMinutes(), hour: d.getUTCHours(), dom: d.getUTCDate(), month: d.getUTCMonth() + 1, dow: d.getUTCDay(), year: d.getUTCFullYear() }
    : { minute: d.getMinutes(), hour: d.getHours(), dom: d.getDate(), month: d.getMonth() + 1, dow: d.getDay(), year: d.getFullYear() };
}

function dayMatches(c: CronSpec, p: Parts): boolean {
  const dom = c.dom.has(p.dom);
  const dow = c.dow.has(p.dow);
  if (c.domRestricted && c.dowRestricted) return dom || dow;
  if (c.domRestricted) return dom;
  if (c.dowRestricted) return dow;
  return true;
}

/** Does the minute containing `d` match? */
export function cronMatches(c: CronSpec, d: Date, tz: CronTz = 'UTC'): boolean {
  const p = partsOf(d, tz);
  return c.minute.has(p.minute) && c.hour.has(p.hour) && c.month.has(p.month) && dayMatches(c, p);
}

/**
 * The first matching minute strictly after `after`. Skips whole days and hours
 * that cannot match, so sparse schedules (Feb 29th) stay fast. Returns
 * undefined if nothing matches within 8 years (e.g. "0 0 31 2 *").
 */
export function nextRun(c: CronSpec, after: Date, tz: CronTz = 'UTC'): Date | undefined {
  const d = new Date(after.getTime());
  d.setUTCSeconds(0, 0);
  d.setTime(d.getTime() + 60_000);
  const limit = after.getTime() + 8 * 366 * 24 * 3600_000;
  const set = (fn: (x: Date) => void) => fn(d);
  while (d.getTime() <= limit) {
    const p = partsOf(d, tz);
    if (!c.month.has(p.month) || !dayMatches(c, p)) {
      // jump to the next day at 00:00
      set((x) => (tz === 'UTC' ? x.setUTCHours(24, 0, 0, 0) : x.setHours(24, 0, 0, 0)));
      continue;
    }
    if (!c.hour.has(p.hour)) {
      set((x) => (tz === 'UTC' ? x.setUTCMinutes(60, 0, 0) : x.setMinutes(60, 0, 0)));
      continue;
    }
    if (!c.minute.has(p.minute)) {
      d.setTime(d.getTime() + 60_000);
      continue;
    }
    return d;
  }
  return undefined;
}

/** A stable key for "the minute this fire belongs to", used as the cron event id (dedupe across processes). */
export function minuteKey(d: Date): string {
  return new Date(Math.floor(d.getTime() / 60_000) * 60_000).toISOString().slice(0, 16) + 'Z';
}

/** Human summary for `tug schedule list`. */
export function describeNext(c: CronSpec, now: Date, tz: CronTz, n = 1): string[] {
  const out: string[] = [];
  let t: Date | undefined = now;
  for (let i = 0; i < n && t; i++) {
    t = nextRun(c, t, tz);
    if (t) out.push(t.toISOString());
  }
  return out;
}
