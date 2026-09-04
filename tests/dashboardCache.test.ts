import { strict as assert } from "node:assert";
import { test } from "node:test";

import { DashboardDataCache } from "../data/dashboardCache";

interface StubFile {
  path: string;
  stat: { mtime: number };
}

function file(path: string, mtime: number): StubFile {
  return { path, stat: { mtime } };
}

test("a vault scan is computed once until something invalidates it", () => {
  const cache = new DashboardDataCache();
  let walks = 0;
  const walk = () => cache.scan("scope:a", () => ++walks);

  assert.equal(walk(), 1);
  assert.equal(walk(), 1);
  cache.invalidateFile("Notes/one.md");
  assert.equal(walk(), 2);
});

test("scans are kept apart by key", () => {
  const cache = new DashboardDataCache();
  assert.equal(cache.scan("scope:a", () => "a"), "a");
  assert.equal(cache.scan("scope:b", () => "b"), "b");
  assert.equal(cache.scan("scope:a", () => "recomputed"), "a");
});

test("a file's parsed result survives edits to every other file", () => {
  const cache = new DashboardDataCache();
  const first = file("one.md", 10);
  const second = file("two.md", 10);
  const parses: string[] = [];
  const parse = (target: StubFile) =>
    cache.forFile("row", target as any, "settings", () => {
      parses.push(target.path);
      return target.path;
    });

  parse(first);
  parse(second);
  cache.invalidateFile("two.md");
  parse(first);
  parse(second);

  assert.deepEqual(parses, ["one.md", "two.md", "two.md"]);
});

test("a written file and changed settings both force a reparse", () => {
  const cache = new DashboardDataCache();
  const target = file("one.md", 10);
  let parses = 0;
  const parse = (key: string) => cache.forFile("row", target as any, key, () => ++parses);

  assert.equal(parse("settings"), 1);
  assert.equal(parse("settings"), 1);
  assert.equal(parse("other settings"), 2);
  target.stat.mtime = 11;
  assert.equal(parse("other settings"), 3);
});

test("namespaces do not overwrite one another", () => {
  const cache = new DashboardDataCache();
  const target = file("one.md", 10);
  assert.equal(cache.forFile("row", target as any, "", () => "row"), "row");
  assert.equal(cache.forFile("scope-data", target as any, "", () => "scope"), "scope");
  assert.equal(cache.forFile("row", target as any, "", () => "recomputed"), "row");
});

test("invalidating everything drops per-file results too", () => {
  const cache = new DashboardDataCache();
  const target = file("one.md", 10);
  let parses = 0;
  const parse = () => cache.forFile("row", target as any, "settings", () => ++parses);

  assert.equal(parse(), 1);
  cache.invalidateAll();
  assert.equal(parse(), 2);
});
