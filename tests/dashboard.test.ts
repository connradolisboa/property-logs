import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  createDashboardSettings,
  duplicateDashboardSettings,
  isFileInDashboardScope,
  normalizeDashboardSettings,
} from "../data/dashboard";
import { DEFAULT_LEVEL_COLORS, DEFAULT_PROPERTY_COLOR } from "../data/colorPalette";

test("new dashboards do not share mutable scope arrays", () => {
  const first = createDashboardSettings("first");
  const second = createDashboardSettings("second");
  assert.equal(first.groupBy, "status");
  assert.equal(first.noteOpenGesture, "ctrl-click");
  first.scopeFilter.includedFolders.push("Projects");
  assert.deepEqual(second.scopeFilter.includedFolders, []);
});

test("normalizes persisted dashboards without trusting malformed levels", () => {
  const dashboard = normalizeDashboardSettings({
    id: "saved",
    name: "Topics",
    levelMapping: { Good: 4, Bad: 7 },
    defaultLevelForUnset: 2,
    unmappedValueLevel: -1,
    levelColors: { 2: "#abcdef" },
    groupBy: "property:area",
    sortBy: "recent",
  }, "fallback", "Fallback");

  assert.equal(dashboard.id, "saved");
  assert.deepEqual(dashboard.levelMapping, { Good: 4 });
  assert.equal(dashboard.defaultLevelForUnset, 2);
  assert.equal(dashboard.unmappedValueLevel, 0);
  assert.equal(dashboard.levelColors[2], "#abcdef");
  assert.equal(dashboard.groupBy, "property:area");
  assert.equal(dashboard.sortBy, "recent");
});

test("migrates blank colors to the adaptive palette and preserves legacy hex", () => {
  const dashboard = normalizeDashboardSettings({
    levelColors: { 1: "", 2: "#abcdef", 3: "palette:purple" },
    colorPropertyMap: { work: "", home: "palette:teal" },
  }, "colors", "Colors");

  assert.equal(dashboard.levelColors[1], DEFAULT_LEVEL_COLORS[1]);
  assert.equal(dashboard.levelColors[2], "#abcdef");
  assert.equal(dashboard.levelColors[3], "palette:purple");
  assert.equal(dashboard.colorPropertyMap.work, DEFAULT_PROPERTY_COLOR);
  assert.equal(dashboard.colorPropertyMap.home, "palette:teal");
});

test("accepts status as a persisted grouping mode", () => {
  const dashboard = normalizeDashboardSettings({
    groupBy: "status",
    noteOpenGesture: "click",
  }, "status", "Status");
  assert.equal(dashboard.groupBy, "status");
  assert.equal(dashboard.noteOpenGesture, "click");
});

test("scope exclusions win over matching inclusions", () => {
  const dashboard = createDashboardSettings("scope");
  dashboard.scopeFilter.includedFolders = ["Projects"];
  dashboard.scopeFilter.includedTags = ["topic", "project"];
  dashboard.scopeFilter.includedProperties = [{ key: "area", value: "work" }];
  dashboard.scopeFilter.excludedTags = ["hidden"];

  const base = {
    path: "Projects/Launch.md",
    frontmatter: { area: "work" },
  };
  assert.equal(isFileInDashboardScope({ ...base, tags: new Set(["topic"]) }, dashboard.scopeFilter), true);
  assert.equal(isFileInDashboardScope({ ...base, tags: new Set(["topic", "hidden"]) }, dashboard.scopeFilter), false);
});

test("active inclusion categories are ANDed and values within one category are ORed", () => {
  const dashboard = createDashboardSettings("scope");
  dashboard.scopeFilter.includedFolders = ["Projects", "Topics"];
  dashboard.scopeFilter.includedTags = ["topic", "project"];

  assert.equal(isFileInDashboardScope({
    path: "Projects/Launch.md",
    tags: new Set(["project"]),
  }, dashboard.scopeFilter), true);
  assert.equal(isFileInDashboardScope({
    path: "Archive/Launch.md",
    tags: new Set(["project"]),
  }, dashboard.scopeFilter), false);
  assert.equal(isFileInDashboardScope({
    path: "Projects/Launch.md",
    tags: new Set(["personal"]),
  }, dashboard.scopeFilter), false);
});

test("property rules support array values and blank means property exists", () => {
  const dashboard = createDashboardSettings("scope");
  dashboard.scopeFilter.includedProperties = [
    { key: "tags", value: "topic" },
    { key: "owner", value: "" },
  ];

  assert.equal(isFileInDashboardScope({
    path: "Note.md",
    tags: new Set(),
    frontmatter: { tags: ["work", "topic"] },
  }, dashboard.scopeFilter), true);
  assert.equal(isFileInDashboardScope({
    path: "Note.md",
    tags: new Set(),
    frontmatter: { owner: "Connrado" },
  }, dashboard.scopeFilter), true);
});

test("duplicating a dashboard copies its settings without aliasing them", () => {
  const source = createDashboardSettings("original", "Topics");
  source.scopeFilter.includedFolders.push("Projects");
  source.levelMapping.Active = 3;
  source.valueColors.Active = "palette:green";
  source.foldedGroups.push("status:Active");

  const copy = duplicateDashboardSettings(source, "copy", "Topics copy");
  assert.equal(copy.id, "copy");
  assert.equal(copy.name, "Topics copy");
  assert.deepEqual(copy.levelMapping, { Active: 3 });
  assert.deepEqual(copy.foldedGroups, ["status:Active"]);

  copy.scopeFilter.includedFolders.push("Archive");
  copy.valueColors.Active = "palette:red";
  assert.deepEqual(source.scopeFilter.includedFolders, ["Projects"]);
  assert.equal(source.valueColors.Active, "palette:green");
});

test("new dashboard fields survive a round trip through persisted data", () => {
  const dashboard = normalizeDashboardSettings({
    id: "saved",
    colorMode: "value",
    valueColors: { Active: "palette:green", Broken: "chartreuse" },
    foldedGroups: ["bucket:Projects", 7],
    showPeriodAxis: false,
    showJournalNotes: "yes",
  }, "fallback", "Fallback");

  assert.equal(dashboard.colorMode, "value");
  assert.equal(dashboard.valueColors.Active, "palette:green");
  assert.equal(dashboard.valueColors.Broken, "palette:blue");
  assert.deepEqual(dashboard.foldedGroups, ["bucket:Projects"]);
  assert.equal(dashboard.showPeriodAxis, false);
  assert.equal(dashboard.showJournalNotes, true);
});
