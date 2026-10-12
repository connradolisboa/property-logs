import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  compareTracked,
  forgetTrackedPaths,
  moveTrackedPaths,
  trackedValue,
} from "../data/trackedValues";

test("treats missing and empty frontmatter values as no value", () => {
  assert.equal(trackedValue(undefined), undefined);
  assert.equal(trackedValue(null), undefined);
  assert.equal(trackedValue(""), undefined);
  assert.equal(trackedValue([]), undefined);
  assert.equal(trackedValue("Active"), "Active");
  assert.equal(trackedValue(3), "3");
  assert.equal(trackedValue(false), "false");
});

test("compares list values by their text, so an unchanged list is not a change", () => {
  assert.equal(compareTracked(trackedValue(["Backlog", "Active"])!, "Backlog,Active", false), "unchanged");
});

test("logs a value that replaces a different one", () => {
  assert.equal(compareTracked("Active", "Backlog", false), "changed");
  assert.equal(compareTracked("Active", "Active", true), "unchanged");
});

test("logs a value filling in a property the note was seen without", () => {
  assert.equal(compareTracked("Active", undefined, true), "changed");
});

test("keeps the first sight of a note as its baseline", () => {
  assert.equal(compareTracked("Active", undefined, false), "baseline");
});

test("moves a renamed note's entry to its new path", () => {
  const map = new Map([["Efforts/Old.md", "Active"], ["Efforts/Other.md", "Done"]]);
  assert.equal(moveTrackedPaths(map, "Efforts/Old.md", "Efforts/New.md"), true);
  assert.deepEqual([...map].sort(), [["Efforts/New.md", "Active"], ["Efforts/Other.md", "Done"]]);
});

test("moves every note inside a renamed folder, and only those", () => {
  const map = new Map([
    ["Efforts/A.md", "Active"],
    ["Efforts/Sub/B.md", "Done"],
    ["Efforts Archive/C.md", "Paused"],
  ]);
  assert.equal(moveTrackedPaths(map, "Efforts", "Projects"), true);
  assert.deepEqual([...map].sort(), [
    ["Efforts Archive/C.md", "Paused"],
    ["Projects/A.md", "Active"],
    ["Projects/Sub/B.md", "Done"],
  ]);
});

test("a rename with nothing tracked, or repeated for a child already moved, changes nothing", () => {
  const map = new Map([["Projects/A.md", "Active"]]);
  assert.equal(moveTrackedPaths(map, "Efforts/A.md", "Projects/A.md"), false);
  assert.deepEqual([...map], [["Projects/A.md", "Active"]]);
});

test("forgets a deleted note, or every note in a deleted folder", () => {
  const map = new Map([["Efforts/A.md", 1], ["Efforts/Sub/B.md", 2], ["Efforts.md", 3]]);
  assert.equal(forgetTrackedPaths(map, "Efforts"), true);
  assert.deepEqual([...map], [["Efforts.md", 3]]);
  assert.equal(forgetTrackedPaths(map, "Missing.md"), false);
});
