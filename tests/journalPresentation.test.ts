import { strict as assert } from "node:assert";
import { test } from "node:test";

import { journalNoteCanOverflow } from "../data/journalPresentation";
import { PeriodGranularity, periodRange } from "../data/periodic";

function period(granularity: PeriodGranularity, year: number, month: number, day: number) {
  return { granularity, range: periodRange(granularity, new Date(year, month, day)) };
}

const today = new Date(2026, 8, 6, 12);

test("today's daily journal notes can overflow without an embed focus", () => {
  assert.equal(journalNoteCanOverflow(period("day", 2026, 8, 6), null, today), true);
});

test("a focused past day can overflow while every other day stays bounded", () => {
  const focus = period("day", 2026, 8, 3);
  assert.equal(journalNoteCanOverflow(period("day", 2026, 8, 3), focus, today), true);
  assert.equal(journalNoteCanOverflow(period("day", 2026, 8, 2), focus, today), false);
  assert.equal(journalNoteCanOverflow(period("day", 2026, 8, 7), focus, today), false);
});

test("broader periodic notes stay bounded even when their period contains today", () => {
  const week = period("week", 2026, 8, 6);
  assert.equal(journalNoteCanOverflow(week, null, today), false);
  assert.equal(journalNoteCanOverflow(week, week, today), false);
});
