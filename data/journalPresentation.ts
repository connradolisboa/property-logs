import { PeriodGranularity, PeriodRange } from "./periodic";

export interface JournalPeriod {
  granularity: PeriodGranularity;
  range: PeriodRange;
}

function sameLocalDay(first: Date, second: Date): boolean {
  return first.getFullYear() === second.getFullYear()
    && first.getMonth() === second.getMonth()
    && first.getDate() === second.getDate();
}

/**
 * Daily journal text may extend beyond its own column only when that date is
 * the embed's focus or today. Weekly and broader notes stay period-bounded.
 */
export function journalNoteCanOverflow(
  note: JournalPeriod,
  focus: JournalPeriod | null,
  today = new Date()
): boolean {
  if (note.granularity !== "day") return false;
  if (sameLocalDay(note.range.start, today)) return true;
  return focus?.granularity === "day"
    && sameLocalDay(note.range.start, focus.range.start);
}
