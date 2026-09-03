import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  HistoryParserOptions,
  reconstructHistorySegments,
} from "../data/historyParser";

function options(overrides: Partial<HistoryParserOptions> = {}): HistoryParserOptions {
  return {
    history: [],
    trackedHistoryKey: "relevantSet",
    dateKey: "dateSet",
    creationDate: "2026-08-01",
    today: "2026-09-04",
    levelMapping: { Low: 1, Mid: 2, High: 4, Hidden: 0 },
    defaultLevelForUnset: 0,
    unmappedValueLevel: 3,
    colorMode: "level",
    levelColors: {
      0: "#000000",
      1: "#111111",
      2: "#222222",
      3: "#333333",
      4: "#444444",
    },
    colorPropertyMap: {},
    ...overrides,
  };
}

function dateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

test("reconstructs only tracked-property changes in date order", () => {
  const result = reconstructHistorySegments(options({
    history: [
      { dateSet: "2026-09-03", commentSet: "Trying less", relevantSet: "Mid" },
      { dateSet: "2026-09-01", commentSet: "Unrelated comment" },
      { dateSet: "2026-09-02", commentSet: "Nice touch", relevantSet: "High" },
    ],
  }));

  assert.equal(result.malformed, false);
  assert.equal(result.hasTrackedHistory, true);
  assert.equal(result.currentValue, "Mid");
  assert.equal(result.currentLevel, 2);
  assert.deepEqual(
    result.segments.map((segment) => ({
      start: dateOnly(segment.start),
      end: dateOnly(segment.end),
      value: segment.value,
      level: segment.level,
      color: segment.color,
      implicit: segment.implicit,
    })),
    [
      {
        start: "2026-09-02",
        end: "2026-09-03",
        value: "High",
        level: 4,
        color: "#444444",
        implicit: false,
      },
      {
        start: "2026-09-03",
        end: "2026-09-04",
        value: "Mid",
        level: 2,
        color: "#222222",
        implicit: false,
      },
    ]
  );
});

test("uses one implicit segment when no tracked-key history exists", () => {
  const result = reconstructHistorySegments(options({
    history: [{ dateSet: "2026-09-01", commentSet: "Other change" }],
    defaultLevelForUnset: 3,
  }));

  assert.equal(result.hasTrackedHistory, false);
  assert.deepEqual(result.segments.map((segment) => ({
    start: dateOnly(segment.start),
    end: dateOnly(segment.end),
    value: segment.value,
    level: segment.level,
    implicit: segment.implicit,
  })), [{
    start: "2026-08-01",
    end: "2026-09-04",
    value: null,
    level: 3,
    implicit: true,
  }]);
});

test("hides implicit and explicit level-zero segments", () => {
  const implicit = reconstructHistorySegments(options({ defaultLevelForUnset: 0 }));
  assert.deepEqual(implicit.segments, []);

  const explicit = reconstructHistorySegments(options({
    history: [
      { dateSet: "2026-09-01", relevantSet: "Hidden" },
      { dateSet: "2026-09-02", relevantSet: "High" },
    ],
  }));
  assert.equal(explicit.segments.length, 1);
  assert.equal(dateOnly(explicit.segments[0].start), "2026-09-02");
  assert.equal(explicit.currentLevel, 4);

  const removed = reconstructHistorySegments(options({
    history: [
      { dateSet: "2026-09-01", relevantSet: "High" },
      { dateSet: "2026-09-02", relevantSet: "Hidden" },
    ],
  }));
  assert.equal(removed.currentLevel, 0);
  assert.equal(removed.segments.length, 1);
  assert.equal(dateOnly(removed.segments[0].end), "2026-09-02");
});

test("assigns the configured fallback level to unmapped free text", () => {
  const result = reconstructHistorySegments(options({
    history: [{ dateSet: "2026-09-02", relevantSet: "My custom value" }],
    unmappedValueLevel: 1,
  }));

  assert.equal(result.segments[0].value, "My custom value");
  assert.equal(result.segments[0].level, 1);
});

test("coalesces consecutive identical tracked values into one segment", () => {
  const result = reconstructHistorySegments(options({
    history: [
      { dateSet: "2026-09-01", relevantSet: "High" },
      { dateSet: "2026-09-02", relevantSet: "High" },
      { dateSet: "2026-09-03", relevantSet: "Mid" },
    ],
  }));

  assert.deepEqual(result.segments.map((segment) => ({
    value: segment.value,
    start: dateOnly(segment.start),
    end: dateOnly(segment.end),
  })), [
    { value: "High", start: "2026-09-01", end: "2026-09-03" },
    { value: "Mid", start: "2026-09-03", end: "2026-09-04" },
  ]);
});

test("resolves property colors, including the first mapped array value", () => {
  const result = reconstructHistorySegments(options({
    history: [{ dateSet: "2026-09-02", relevantSet: "High" }],
    colorMode: "property",
    colorPropertyValue: ["unmapped-tag", "topic"],
    colorPropertyMap: { topic: "#abcdef" },
  }));

  assert.equal(result.segments[0].color, "#abcdef");
  assert.deepEqual(result.issues, []);
});

test("accepts adaptive palette colors without a warning", () => {
  const result = reconstructHistorySegments(options({
    history: [{ dateSet: "2026-09-02", relevantSet: "High" }],
    levelColors: { 4: "palette:green" },
  }));

  assert.equal(result.segments[0].color, "palette:green");
  assert.deepEqual(result.issues, []);
});

test("normalizes scalar YAML values before mapping", () => {
  const result = reconstructHistorySegments(options({
    history: [
      { dateSet: "2026-09-01", relevantSet: 2 },
      { dateSet: "2026-09-02", relevantSet: true },
    ],
    levelMapping: { "2": 2, "true": 4 },
  }));

  assert.deepEqual(result.segments.map((segment) => segment.level), [2, 4]);
});

test("reports a non-array history instead of inventing an implicit segment", () => {
  const result = reconstructHistorySegments(options({
    history: { dateSet: "2026-09-02", relevantSet: "High" },
    defaultLevelForUnset: 4,
  }));

  assert.equal(result.malformed, true);
  assert.deepEqual(result.segments, []);
  assert.equal(result.issues[0].code, "history-not-array");
});

test("keeps valid segments while reporting malformed entries", () => {
  const result = reconstructHistorySegments(options({
    history: [
      "bad entry",
      { relevantSet: "High" },
      { dateSet: "not-a-date", relevantSet: "Mid" },
      { dateSet: "2026-09-02", relevantSet: ["High"] },
      { dateSet: "2026-09-03", relevantSet: "High" },
    ],
  }));

  assert.equal(result.malformed, true);
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].value, "High");
  assert.deepEqual(result.issues.map((issue) => issue.code), [
    "entry-not-object",
    "missing-date",
    "invalid-date",
    "invalid-value",
  ]);
});

test("does not mutate metadata-cache input", () => {
  const history = [
    { dateSet: "2026-09-03", relevantSet: "Mid" },
    { dateSet: "2026-09-02", relevantSet: "High" },
  ];
  const snapshot = JSON.stringify(history);

  reconstructHistorySegments(options({ history }));

  assert.equal(JSON.stringify(history), snapshot);
});
