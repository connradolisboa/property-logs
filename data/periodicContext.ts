import {
  PeriodGranularity,
  PeriodRange,
  parseDateString,
  periodRange,
  startOfDay,
} from "./periodic";

export interface PeriodicNoteContext {
  granularity: PeriodGranularity;
  range: PeriodRange;
  /** The period's anchor date, at local midnight. */
  date: Date;
  journalName?: string;
  source: "journals" | "frontmatter" | "filename" | "daily-notes";
}

export interface PeriodicNotesConfig {
  /** Fallback daily-note folder, used when the core plugin is disabled. */
  dailyFolder: string;
  dailyFormat: string;
  dateFields: string[];
  weekStartsOn: number;
}

const DAY_MS = 1000 * 60 * 60 * 24;

const FILENAME_PATTERNS: Array<{ pattern: RegExp; granularity: PeriodGranularity }> = [
  { pattern: /(\d{4})-(\d{2})-(\d{2})/, granularity: "day" },
  { pattern: /(\d{4})-?W(\d{1,2})/i, granularity: "week" },
  { pattern: /(\d{4})-?Q([1-4])/i, granularity: "quarter" },
  { pattern: /(\d{4})-(\d{2})(?!\d)/, granularity: "month" },
  { pattern: /^(\d{4})$/, granularity: "year" },
];

/** Maps a start/end pair onto the closest calendar granularity. */
export function granularityForSpan(days: number): PeriodGranularity {
  if (days <= 1.5) return "day";
  if (days <= 10) return "week";
  if (days <= 45) return "month";
  if (days <= 135) return "quarter";
  return "year";
}

function weekStartFromIsoWeek(year: number, week: number, weekStartsOn: number): Date {
  // ISO weeks are anchored on the Thursday of week 1.
  const fourthJanuary = new Date(year, 0, 4);
  const isoWeekday = (fourthJanuary.getDay() + 6) % 7;
  const firstIsoWeekStart = new Date(year, 0, 4 - isoWeekday);
  const target = new Date(firstIsoWeekStart);
  target.setDate(target.getDate() + (week - 1) * 7);
  return periodRange("week", target, weekStartsOn).start;
}

/** Reads a period out of a file name, covering the usual periodic-note formats. */
export function contextFromFileName(
  basename: string,
  weekStartsOn: number
): PeriodicNoteContext | null {
  for (const { pattern, granularity } of FILENAME_PATTERNS) {
    const match = pattern.exec(basename);
    if (!match) continue;

    if (granularity === "day") {
      const date = parseDateString(`${match[1]}-${match[2]}-${match[3]}`);
      if (!date) continue;
      return { granularity, date, range: periodRange("day", date, weekStartsOn), source: "filename" };
    }
    if (granularity === "week") {
      const week = Number(match[2]);
      if (!Number.isInteger(week) || week < 1 || week > 53) continue;
      const start = weekStartFromIsoWeek(Number(match[1]), week, weekStartsOn);
      return {
        granularity,
        date: start,
        range: periodRange("week", start, weekStartsOn),
        source: "filename",
      };
    }
    if (granularity === "quarter") {
      const start = new Date(Number(match[1]), (Number(match[2]) - 1) * 3, 1);
      return { granularity, date: start, range: periodRange("quarter", start, weekStartsOn), source: "filename" };
    }
    if (granularity === "month") {
      const month = Number(match[2]);
      if (month < 1 || month > 12) continue;
      const start = new Date(Number(match[1]), month - 1, 1);
      return { granularity, date: start, range: periodRange("month", start, weekStartsOn), source: "filename" };
    }
    const start = new Date(Number(match[1]), 0, 1);
    return { granularity, date: start, range: periodRange("year", start, weekStartsOn), source: "filename" };
  }
  return null;
}

/** Reads a period out of frontmatter written by Journals or a template. */
export function contextFromFrontmatter(
  frontmatter: Record<string, unknown> | undefined,
  config: PeriodicNotesConfig
): PeriodicNoteContext | null {
  if (!frontmatter) return null;

  const readDate = (keys: string[]): Date | null => {
    for (const key of keys) {
      const raw = frontmatter[key];
      if (typeof raw === "string") {
        const parsed = parseDateString(raw);
        if (parsed) return parsed;
      } else if (raw instanceof Date && Number.isFinite(raw.getTime())) {
        return startOfDay(raw);
      }
    }
    return null;
  };

  const start = readDate(["journal-start-date", ...config.dateFields]);
  if (!start) return null;
  const end = readDate(["journal-end-date"]);
  const journalName = typeof frontmatter.journal === "string" ? frontmatter.journal : undefined;

  if (end) {
    const days = (end.getTime() - start.getTime()) / DAY_MS + 1;
    const granularity = granularityForSpan(days);
    return {
      granularity,
      date: start,
      range: { start, end: new Date(end.getTime() + DAY_MS) },
      journalName,
      source: "frontmatter",
    };
  }

  return {
    granularity: "day",
    date: start,
    range: periodRange("day", start, config.weekStartsOn),
    journalName,
    source: "frontmatter",
  };
}
