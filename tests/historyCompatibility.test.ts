import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  collectCompatibleHistory,
  historyContainsKey,
} from "../data/historyCompatibility";

test("merges configured and legacy history while normalizing date keys", () => {
  const result = collectCompatibleHistory({
    property_history: [{ dateSet: "2026-09-03", statusSet: "Active" }],
    propertyLogs: [{ dateLog: "2026-07-17", statusSet: "Ongoing" }],
  }, "property_history", "dateSet");

  assert.deepEqual(result, [
    { dateSet: "2026-09-03", statusSet: "Active" },
    { statusSet: "Ongoing", dateSet: "2026-07-17" },
  ]);
  assert.equal(historyContainsKey(result, "statusSet"), true);
});

test("deduplicates identical entries copied between history containers", () => {
  const entry = { dateSet: "2026-09-03", relevantSet: "High" };
  const result = collectCompatibleHistory({
    property_history: [entry],
    statusHistory: [{ ...entry }],
  }, "property_history", "dateSet");

  assert.deepEqual(result, [entry]);
});

test("preserves malformed configured history when there is no compatible array", () => {
  const result = collectCompatibleHistory({ property_history: "broken" }, "property_history", "dateSet");
  assert.equal(result, "broken");
});
