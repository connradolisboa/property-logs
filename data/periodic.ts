/**
 * Period math shared by the dashboard axis, the periodic-note embed, and the
 * Journals integration. Everything here is deliberately free of Obsidian and
 * moment so it can be unit tested directly.
 */

export type PeriodGranularity = "day" | "week" | "month" | "quarter" | "year";

export const PERIOD_GRANULARITIES: PeriodGranularity[] = [
  "day",
  "week",
  "month",
  "quarter",
  "year",
];

export interface PeriodRange {
  /** Inclusive start of the period, at local midnight. */
  start: Date;
  /** Exclusive end of the period, at local midnight. */
  end: Date;
}

const DAY_MS = 1000 * 60 * 60 * 24;

export function isPeriodGranularity(value: unknown): value is PeriodGranularity {
  return typeof value === "string" && PERIOD_GRANULARITIES.includes(value as PeriodGranularity);
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function startOfWeek(date: Date, weekStartsOn = 1): Date {
  const day = startOfDay(date);
  const offset = (day.getDay() - weekStartsOn + 7) % 7;
  return addDays(day, -offset);
}

/** ISO-8601 week number, independent of the configured week start. */
export function isoWeekNumber(date: Date): number {
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  return Math.ceil(((day.getTime() - yearStart) / DAY_MS + 1) / 7);
}

export function periodRange(
  granularity: PeriodGranularity,
  date: Date,
  weekStartsOn = 1
): PeriodRange {
  const day = startOfDay(date);
  switch (granularity) {
    case "day":
      return { start: day, end: addDays(day, 1) };
    case "week": {
      const start = startOfWeek(day, weekStartsOn);
      return { start, end: addDays(start, 7) };
    }
    case "month": {
      const start = new Date(day.getFullYear(), day.getMonth(), 1);
      return { start, end: new Date(day.getFullYear(), day.getMonth() + 1, 1) };
    }
    case "quarter": {
      const firstMonth = Math.floor(day.getMonth() / 3) * 3;
      const start = new Date(day.getFullYear(), firstMonth, 1);
      return { start, end: new Date(day.getFullYear(), firstMonth + 3, 1) };
    }
    case "year": {
      const start = new Date(day.getFullYear(), 0, 1);
      return { start, end: new Date(day.getFullYear() + 1, 0, 1) };
    }
  }
}

export function nextPeriodStart(
  granularity: PeriodGranularity,
  start: Date,
  weekStartsOn = 1
): Date {
  switch (granularity) {
    case "day":
      return addDays(start, 1);
    case "week":
      return addDays(startOfWeek(start, weekStartsOn), 7);
    case "month":
      return new Date(start.getFullYear(), start.getMonth() + 1, 1);
    case "quarter":
      return new Date(start.getFullYear(), Math.floor(start.getMonth() / 3) * 3 + 3, 1);
    case "year":
      return new Date(start.getFullYear() + 1, 0, 1);
  }
}

/** How much calendar context each note type shows around its own period. */
export const DEFAULT_PERIOD_WINDOW_DAYS: Record<PeriodGranularity, number> = {
  day: 21,
  week: 70,
  month: 240,
  quarter: 550,
  year: 1460,
};

export function normalizePeriodWindowDays(
  raw: unknown
): Record<PeriodGranularity, number> {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const result = { ...DEFAULT_PERIOD_WINDOW_DAYS };
  for (const granularity of PERIOD_GRANULARITIES) {
    const value = Number(source[granularity]);
    if (Number.isFinite(value) && value >= 1 && value <= 365 * 40) {
      result[granularity] = Math.round(value);
    }
  }
  return result;
}

/** Centers a window of `spanDays` on the middle of `range`, never narrower than the period. */
export function windowForPeriod(range: PeriodRange, spanDays: number): PeriodRange {
  const periodSpan = Math.max(range.end.getTime() - range.start.getTime(), DAY_MS);
  const span = Math.max(spanDays * DAY_MS, periodSpan);
  const center = range.start.getTime() + periodSpan / 2;
  return {
    start: new Date(center - span / 2),
    end: new Date(center + span / 2),
  };
}

/** The two axis rows to draw for a visible span, finest row first. */
export function axisGranularities(spanMs: number): [PeriodGranularity, PeriodGranularity] {
  const days = spanMs / DAY_MS;
  if (days <= 45) return ["day", "week"];
  if (days <= 220) return ["week", "month"];
  if (days <= 800) return ["month", "quarter"];
  return ["quarter", "year"];
}

/** Every period start touching `window`, including the one containing its start. */
export function periodBoundaries(
  granularity: PeriodGranularity,
  window: PeriodRange,
  weekStartsOn = 1
): Date[] {
  const boundaries: Date[] = [];
  let cursor = periodRange(granularity, window.start, weekStartsOn).start;
  // Guard against pathological windows so a bad range can never hang the view.
  for (let guard = 0; guard < 2000; guard++) {
    boundaries.push(cursor);
    if (cursor.getTime() > window.end.getTime()) break;
    const next = nextPeriodStart(granularity, cursor, weekStartsOn);
    if (next.getTime() <= cursor.getTime()) break;
    cursor = next;
  }
  return boundaries;
}

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function periodLabel(granularity: PeriodGranularity, start: Date): string {
  switch (granularity) {
    case "day":
      return String(start.getDate());
    case "week":
      return `W${String(isoWeekNumber(start)).padStart(2, "0")}`;
    case "month":
      return MONTH_NAMES[start.getMonth()];
    case "quarter":
      return `Q${Math.floor(start.getMonth() / 3) + 1}`;
    case "year":
      return String(start.getFullYear());
  }
}

export function periodTitle(granularity: PeriodGranularity, start: Date): string {
  const iso = toDateString(start);
  switch (granularity) {
    case "day":
      return iso;
    case "week":
      return `Week ${isoWeekNumber(start)}, starting ${iso}`;
    case "month":
      return `${MONTH_NAMES[start.getMonth()]} ${start.getFullYear()}`;
    case "quarter":
      return `Q${Math.floor(start.getMonth() / 3) + 1} ${start.getFullYear()}`;
    case "year":
      return String(start.getFullYear());
  }
}

export function toDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Parses `YYYY-MM-DD`, returning null for both malformed and impossible dates. */
export function parseDateString(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}
