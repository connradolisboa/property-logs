import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  DEFAULT_JOURNAL_MARKERS,
  markerStyle,
  normalizeJournalMarkers,
  parseJournalNotes,
  plainNoteText,
} from "../data/journalMarkers";

const MARKERS = ["n", "!", "?"];

test("only configured markers become timeline notes", () => {
  const notes = parseJournalNotes([
    "- [ ] a plain todo",
    "- [x] a finished todo",
    "- [n] Today I've been feeling well about this",
    "* [!] Something urgent",
    "1. [?] An open question",
  ].join("\n"), MARKERS);

  assert.deepEqual(notes.map((note) => note.marker), ["n", "!", "?"]);
  assert.equal(notes[0].text, "Today I've been feeling well about this");
  assert.equal(notes[0].line, 2);
});

test("code fences and frontmatter never produce notes", () => {
  const notes = parseJournalNotes([
    "---",
    "title: - [n] not a note",
    "---",
    "```markdown",
    "- [n] documentation example",
    "```",
    "- [n] a real note",
  ].join("\n"), MARKERS);

  assert.equal(notes.length, 1);
  assert.equal(notes[0].text, "a real note");
});

test("wiki links are captured so a note can attach to its row", () => {
  const [note] = parseJournalNotes("- [n] [[Project Atlas|Atlas]] shipped the beta", MARKERS);
  assert.deepEqual(note.links, ["Project Atlas"]);
  assert.equal(plainNoteText(note.text), "Project Atlas shipped the beta");
});

test("empty marker lines are ignored", () => {
  assert.equal(parseJournalNotes("- [n]   ", MARKERS).length, 0);
  assert.equal(parseJournalNotes("- [n] anything", []).length, 0);
});

test("marker styles fall back without losing the marker character", () => {
  const markers = normalizeJournalMarkers([
    { marker: "n", label: "Note", icon: "pencil", color: "palette:blue" },
    { marker: "n", label: "Duplicate" },
    { marker: "", label: "Empty" },
    { marker: "z", color: "not-a-color" },
  ]);
  assert.deepEqual(markers.map((style) => style.marker), ["n", "z"]);
  assert.equal(markers[1].label, "z");
  assert.equal(markers[1].color, "palette:blue");

  assert.equal(markerStyle(markers, "?").marker, "?");
  assert.equal(normalizeJournalMarkers("nonsense").length, DEFAULT_JOURNAL_MARKERS.length);
});
