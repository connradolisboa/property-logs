import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  axisGranularities,
  isoWeekNumber,
  normalizePeriodWindowDays,
  periodBoundaries,
  periodLabel,
  periodRange,
  parseDateString,
  windowForPeriod,
} from "../data/periodic";

const DAY_MS = 1000 * 60 * 60 * 24;

test("period ranges cover exactly one calendar period", () => {
  const day = periodRange("day", new Date(2026, 8, 3));
  assert.equal(day.start.getTime(), new Date(2026, 8, 3).getTime());
  assert.equal(day.end.getTime(), new Date(2026, 8, 4).getTime());

  const month = periodRange("month", new Date(2026, 8, 17));
  assert.equal(month.start.getTime(), new Date(2026, 8, 1).getTime());
  assert.equal(month.end.getTime(), new Date(2026, 9, 1).getTime());

  const quarter = periodRange("quarter", new Date(2026, 8, 17));
  assert.equal(quarter.start.getTime(), new Date(2026, 6, 1).getTime());
  assert.equal(quarter.end.getTime(), new Date(2026, 9, 1).getTime());
});

test("week ranges honour the configured first day", () => {
  const monday = periodRange("week", new Date(2026, 8, 3), 1);
  assert.equal(monday.start.getDay(), 1);
  assert.equal(monday.start.getTime(), new Date(2026, 7, 31).getTime());

  const sunday = periodRange("week", new Date(2026, 8, 3), 0);
  assert.equal(sunday.start.getDay(), 0);
  assert.equal(sunday.start.getTime(), new Date(2026, 7, 30).getTime());
});

test("ISO week numbers stay stable across a year boundary", () => {
  assert.equal(isoWeekNumber(new Date(2026, 0, 1)), 1);
  assert.equal(isoWeekNumber(new Date(2026, 8, 3)), 36);
  assert.equal(periodLabel("week", new Date(2026, 8, 3)), "W36");
});

test("a focus window centers the period and never crops it", () => {
  const range = periodRange("day", new Date(2026, 8, 3));
  const window = windowForPeriod(range, 21);
  assert.equal(Math.round((window.end.getTime() - window.start.getTime()) / DAY_MS), 21);
  const center = (window.start.getTime() + window.end.getTime()) / 2;
  assert.equal(center, (range.start.getTime() + range.end.getTime()) / 2);

  const year = periodRange("year", new Date(2026, 5, 1));
  const narrow = windowForPeriod(year, 5);
  assert.ok(narrow.start.getTime() <= year.start.getTime());
  assert.ok(narrow.end.getTime() >= year.end.getTime());
});

test("the axis picks finer rows as the window narrows", () => {
  assert.deepEqual(axisGranularities(30 * DAY_MS), ["day", "week"]);
  assert.deepEqual(axisGranularities(120 * DAY_MS), ["week", "month"]);
  assert.deepEqual(axisGranularities(400 * DAY_MS), ["month", "quarter"]);
  assert.deepEqual(axisGranularities(2000 * DAY_MS), ["quarter", "year"]);
});

test("boundaries span the whole window without runaway loops", () => {
  const window = { start: new Date(2026, 0, 15), end: new Date(2026, 2, 15) };
  const weeks = periodBoundaries("week", window, 1);
  assert.ok(weeks[0].getTime() <= window.start.getTime());
  assert.ok(weeks[weeks.length - 1].getTime() > window.end.getTime());
  assert.ok(weeks.length < 20);

  const inverted = periodBoundaries("day", { start: new Date(2026, 0, 10), end: new Date(2026, 0, 1) }, 1);
  assert.equal(inverted.length, 1);
});

test("window spans fall back to the defaults when persisted data is unusable", () => {
  const days = normalizePeriodWindowDays({ day: 10, week: "nonsense", month: -3 });
  assert.equal(days.day, 10);
  assert.equal(days.week, 70);
  assert.equal(days.month, 240);
});

test("date strings reject impossible calendar dates", () => {
  assert.equal(parseDateString("2026-02-30"), null);
  assert.equal(parseDateString("not a date"), null);
  assert.equal(parseDateString("2026-09-03")?.getMonth(), 8);
});
