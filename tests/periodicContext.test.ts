import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  PeriodicNotesConfig,
  contextFromFileName,
  contextFromFrontmatter,
  granularityForSpan,
} from "../data/periodicContext";

const CONFIG: PeriodicNotesConfig = {
  dailyFolder: "Calendar/Daily",
  dailyFormat: "YYYY-MM-DD",
  dateFields: ["journal-date", "date"],
  weekStartsOn: 1,
};

test("file names resolve to the period they name", () => {
  assert.equal(contextFromFileName("2026-09-03 Thursday", 1)?.granularity, "day");
  assert.equal(contextFromFileName("2026-W36", 1)?.granularity, "week");
  assert.equal(contextFromFileName("2026-09 September", 1)?.granularity, "month");
  assert.equal(contextFromFileName("2026-Q3", 1)?.granularity, "quarter");
  assert.equal(contextFromFileName("2026", 1)?.granularity, "year");
  assert.equal(contextFromFileName("Meeting notes", 1), null);
});

test("week file names land inside the ISO week they name", () => {
  const context = contextFromFileName("2026-W36", 1);
  assert.ok(context);
  assert.equal(context.range.start.getDay(), 1);
  assert.equal(context.range.start.getTime(), new Date(2026, 7, 31).getTime());
});

test("frontmatter start and end dates infer the period type", () => {
  const week = contextFromFrontmatter({
    "journal-start-date": "2026-08-31",
    "journal-end-date": "2026-09-06",
    journal: "Calendar Weekly",
  }, CONFIG);
  assert.equal(week?.granularity, "week");
  assert.equal(week?.journalName, "Calendar Weekly");
  assert.equal(week?.range.end.getTime(), new Date(2026, 8, 7).getTime());

  const day = contextFromFrontmatter({ date: "2026-09-03" }, CONFIG);
  assert.equal(day?.granularity, "day");
  assert.equal(contextFromFrontmatter({ title: "no date" }, CONFIG), null);
  assert.equal(contextFromFrontmatter(undefined, CONFIG), null);
});

test("spans map onto the nearest calendar granularity", () => {
  assert.equal(granularityForSpan(1), "day");
  assert.equal(granularityForSpan(7), "week");
  assert.equal(granularityForSpan(31), "month");
  assert.equal(granularityForSpan(92), "quarter");
  assert.equal(granularityForSpan(365), "year");
});
