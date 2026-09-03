import { DEFAULT_PROPERTY_COLOR, normalizeTimelineColor } from "./colorPalette";

/**
 * A checkbox marker that turns a periodic-note line into a timeline note.
 * Markers mirror Obsidian's task syntax, so `- [n] text` uses the `n` style.
 */
export interface JournalMarkerStyle {
  marker: string;
  label: string;
  icon: string;
  color: string;
}

export interface ParsedJournalNote {
  marker: string;
  text: string;
  /** Zero-based line number in the source note. */
  line: number;
  /** Wiki-link targets found in the line, without alias or heading. */
  links: string[];
}

export const DEFAULT_JOURNAL_MARKERS: JournalMarkerStyle[] = [
  { marker: "n", label: "Note", icon: "pencil", color: "palette:blue" },
  { marker: "!", label: "Important", icon: "alert-triangle", color: "palette:red" },
  { marker: "?", label: "Question", icon: "help-circle", color: "palette:purple" },
  { marker: "i", label: "Info", icon: "info", color: "palette:teal" },
  { marker: "*", label: "Highlight", icon: "star", color: "palette:amber" },
  { marker: "b", label: "Bookmark", icon: "bookmark", color: "palette:pink" },
];

export const FALLBACK_JOURNAL_MARKER: JournalMarkerStyle = {
  marker: "",
  label: "Note",
  icon: "message-square",
  color: "palette:slate",
};

export function normalizeJournalMarkers(raw: unknown): JournalMarkerStyle[] {
  if (!Array.isArray(raw)) return DEFAULT_JOURNAL_MARKERS.map((style) => ({ ...style }));
  const markers: JournalMarkerStyle[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const marker = typeof record.marker === "string" ? record.marker.trim().slice(0, 1) : "";
    if (!marker || markers.some((style) => style.marker === marker)) continue;
    markers.push({
      marker,
      label: typeof record.label === "string" && record.label.trim() ? record.label.trim() : marker,
      icon: typeof record.icon === "string" && record.icon.trim()
        ? record.icon.trim()
        : FALLBACK_JOURNAL_MARKER.icon,
      color: normalizeTimelineColor(record.color, DEFAULT_PROPERTY_COLOR),
    });
  }
  return markers;
}

export function markerStyle(
  markers: JournalMarkerStyle[],
  marker: string
): JournalMarkerStyle {
  return markers.find((style) => style.marker === marker)
    ?? { ...FALLBACK_JOURNAL_MARKER, marker, label: marker || FALLBACK_JOURNAL_MARKER.label };
}

const TASK_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\[(.)\]\s*(.*)$/;
const WIKI_LINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const FRONTMATTER_FENCE = /^---\s*$/;

function extractLinks(text: string): string[] {
  const links: string[] = [];
  for (const match of text.matchAll(WIKI_LINK)) {
    const target = match[1].trim();
    if (target && !links.includes(target)) links.push(target);
  }
  return links;
}

/** Removes the markup that would read as noise in a one-line timeline note. */
export function plainNoteText(text: string): string {
  return text
    .replace(WIKI_LINK, (_match, target: string) => target.trim())
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Reads `- [x] text` lines whose marker is one of `markers`. Fenced code blocks
 * and frontmatter are skipped so a documented example never becomes a note.
 */
export function parseJournalNotes(
  content: string,
  markers: Iterable<string>
): ParsedJournalNote[] {
  const wanted = new Set(markers);
  if (wanted.size === 0) return [];

  const notes: ParsedJournalNote[] = [];
  const lines = content.split(/\r?\n/);
  let fence: string | null = null;
  let inFrontmatter = false;

  lines.forEach((line, index) => {
    if (index === 0 && FRONTMATTER_FENCE.test(line)) {
      inFrontmatter = true;
      return;
    }
    if (inFrontmatter) {
      if (FRONTMATTER_FENCE.test(line)) inFrontmatter = false;
      return;
    }

    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      return;
    }
    if (fence !== null) return;

    const match = TASK_LINE.exec(line);
    if (!match) return;
    const marker = match[1];
    if (!wanted.has(marker)) return;
    const text = match[2].trim();
    if (!text) return;
    notes.push({ marker, text, line: index, links: extractLinks(text) });
  });

  return notes;
}
