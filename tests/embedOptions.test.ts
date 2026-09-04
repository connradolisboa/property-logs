import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseEmbedOptions } from "../data/embedOptions";

test("an empty block uses the note's own period and the first dashboard", () => {
  const options = parseEmbedOptions("");
  assert.equal(options.dashboard, "");
  assert.equal(options.date, null);
  assert.equal(options.period, null);
  assert.equal(options.windowDays, null);
  assert.equal(options.header, true);
  assert.equal(options.minimal, false);
  assert.deepEqual(options.errors, []);
});

test("zoom accepts durations and plain day counts", () => {
  assert.equal(parseEmbedOptions("zoom: 30d").windowDays, 30);
  assert.equal(parseEmbedOptions("zoom: 6w").windowDays, 42);
  assert.equal(parseEmbedOptions("zoom: 1y").windowDays, 365);
  assert.equal(parseEmbedOptions("zoom: 45").windowDays, 45);
  assert.equal(parseEmbedOptions("zoom: auto").windowDays, null);
});

test("options are reported rather than silently dropped", () => {
  const options = parseEmbedOptions([
    "dashboard: Topics",
    "date: 2026-13-01",
    "period: fortnight",
    "height: 12",
    "wat: true",
    "just a line",
  ].join("\n"));

  assert.equal(options.dashboard, "Topics");
  assert.equal(options.date, null);
  assert.equal(options.errors.length, 5);
});

test("explicit anchors override the host note", () => {
  const options = parseEmbedOptions([
    "date: 2026-09-03",
    "period: week",
    "height: 320px",
    "header: false",
  ].join("\n"));

  assert.equal(options.date?.getDate(), 3);
  assert.equal(options.period, "week");
  assert.equal(options.height, 320);
  assert.equal(options.header, false);
  assert.deepEqual(options.errors, []);
});

test("minimal accepts boolean values and rejects other input", () => {
  assert.equal(parseEmbedOptions("minimal: true").minimal, true);
  assert.equal(parseEmbedOptions("minimal: yes").minimal, true);
  assert.equal(parseEmbedOptions("minimal: false").minimal, false);
  const invalid = parseEmbedOptions("minimal: sideways");
  assert.equal(invalid.minimal, false);
  assert.equal(invalid.errors.length, 1);
});

test("block-local layout overrides are parsed without changing dashboard defaults", () => {
  const options = parseEmbedOptions([
    "groupBy: property:areas",
    "sortBy: property:priority",
    "sortAscending: false",
    "scroll: true",
  ].join("\n"));

  assert.equal(options.groupBy, "property:areas");
  assert.equal(options.sortBy, "property:priority");
  assert.equal(options.sortAscending, false);
  assert.equal(options.scroll, true);
  assert.deepEqual(options.errors, []);
});

test("file tags and a natural-height embed are supported", () => {
  const options = parseEmbedOptions("groupBy: file.tags\nscroll: false");
  assert.equal(options.groupBy, "file.tags");
  assert.equal(options.scroll, false);
});
