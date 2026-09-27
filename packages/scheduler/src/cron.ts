/** UTC-only, five-field cron helpers used by the scheduler. */

/**
 * Returns the next fire time strictly after `from`.
 * Supports minute, hour, day-of-month, month, and day-of-week fields with
 * wildcards, lists, ranges, and steps. Day-of-week uses 0=Sunday through 6.
 */
export function nextCronFire(cron: string, from: Date): Date | null {
  const parsed = parseCron(cron);
  if (!parsed || !Number.isFinite(from.getTime())) return null;

  let cur = new Date(from.getTime());
  cur.setUTCSeconds(0, 0);
  cur = new Date(cur.getTime() + 60_000);
  const limit = cur.getTime() + (4 * 366 * 24 * 60 * 60 * 1000);
  while (cur.getTime() < limit) {
    if (matches(parsed, cur)) return cur;
    cur = new Date(cur.getTime() + 60_000);
  }
  return null;
}

/** Returns whether a UTC minute matches a five-field cron expression. */
export function cronMatchesAtMinute(cron: string, minute: Date): boolean {
  return cronMatchesAtMinuteInTimeZone(cron, minute, 'UTC');
}

/** Validate an IANA time-zone identifier using the host's Intl database. */
export function isValidTimeZone(time_zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: time_zone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Match a UTC instant against a cron expression in an IANA wall-clock zone.
 * During a fall-back repeated hour the scheduler's local fire key prevents a
 * second fire. A spring-forward wall time that does not exist is skipped.
 */
export function cronMatchesAtMinuteInTimeZone(cron: string, minute: Date, time_zone: string): boolean {
  const parsed = parseCron(cron);
  if (!parsed || !Number.isFinite(minute.getTime()) || !isValidTimeZone(time_zone)) return false;
  const fields = formatterFor(time_zone).formatToParts(new Date(Math.floor(minute.getTime() / 60_000) * 60_000));
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(fields.find((item) => item.type === type)?.value);
  const weekday = fields.find((item) => item.type === 'weekday')?.value;
  const dow = weekday === 'Sun' ? 0 : weekday === 'Mon' ? 1 : weekday === 'Tue' ? 2
    : weekday === 'Wed' ? 3 : weekday === 'Thu' ? 4 : weekday === 'Fri' ? 5 : weekday === 'Sat' ? 6 : -1;
  const local = new Date(Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute')));
  if (!Number.isFinite(local.getTime()) || dow < 0) return false;
  return matches(parsed, local, dow);
}

/** A stable minute key from local wall time, shared by repeated DST minutes. */
export function wallClockMinuteIdentity(minute: Date, time_zone: string): number | null {
  if (!Number.isFinite(minute.getTime()) || !isValidTimeZone(time_zone)) return null;
  const fields = formatterFor(time_zone).formatToParts(minute);
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(fields.find((item) => item.type === type)?.value);
  return Math.floor(Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute')) / 60_000);
}

type ParsedCron = {
  readonly minutes: Set<number>;
  readonly hours: Set<number>;
  readonly doms: Set<number>;
  readonly months: Set<number>;
  readonly dows: Set<number>;
};

function parseCron(cron: string): ParsedCron | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minutes = parseField(fields[0]!, 0, 59);
  const hours = parseField(fields[1]!, 0, 23);
  const doms = parseField(fields[2]!, 1, 31);
  const months = parseField(fields[3]!, 1, 12);
  const dows = parseField(fields[4]!, 0, 6);
  if (!minutes || !hours || !doms || !months || !dows) return null;
  return { minutes, hours, doms, months, dows };
}

function matches(cron: ParsedCron, date: Date, day_of_week = date.getUTCDay()): boolean {
  if (!cron.months.has(date.getUTCMonth() + 1)) return false;

  const dom_match = cron.doms.has(date.getUTCDate());
  const dow_match = cron.dows.has(day_of_week);
  const dom_is_wildcard = cron.doms.size === 31;
  const dow_is_wildcard = cron.dows.size === 7;
  const day_match = dom_is_wildcard && dow_is_wildcard
    ? true
    : dom_is_wildcard
      ? dow_match
      : dow_is_wildcard
        ? dom_match
        : dom_match || dow_match;

  return day_match
    && cron.hours.has(date.getUTCHours())
    && cron.minutes.has(date.getUTCMinutes());
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(time_zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(time_zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: time_zone,
      year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    formatters.set(time_zone, formatter);
  }
  return formatter;
}

function parseField(spec: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const match = part.match(/^(\*|(\d+)(-(\d+))?)(?:\/(\d+))?$/);
    if (!match) return null;
    const lo = match[1] === '*' ? min : Number(match[2]);
    const hi = match[1] === '*' ? max : match[4] !== undefined ? Number(match[4]) : lo;
    const step = match[5] !== undefined ? Number(match[5]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) return null;
    for (let value = lo; value <= hi; value += step) out.add(value);
  }
  return out;
}
