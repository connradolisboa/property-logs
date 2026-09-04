import { App, TFile } from "obsidian";

import {
  JournalMarkerStyle,
  ParsedJournalNote,
  parseJournalNotes,
} from "../data/journalMarkers";
import { PeriodGranularity, PeriodRange } from "../data/periodic";
import { PeriodicNotes } from "./periodicNotes";

export interface JournalNote {
  id: string;
  marker: string;
  text: string;
  file: TFile;
  line: number;
  links: string[];
  granularity: PeriodGranularity;
  range: PeriodRange;
}

interface CachedParse {
  mtime: number;
  notes: ParsedJournalNote[];
}

/** Everything a timeline draws from one marked line, flattened for comparison. */
function signature(notes: ParsedJournalNote[]): string {
  return notes
    .map((note) => `${note.line}\u0000${note.marker}\u0000${note.text}\u0000${note.links.join(",")}`)
    .join("\u0001");
}

/**
 * Collects `- [n] …` lines from periodic notes so they can be drawn on the
 * timeline. Files are pre-filtered through Obsidian's metadata cache, so only
 * notes that actually carry a configured marker are ever read from disk.
 */
export class JournalNoteIndex {
  private readonly cache = new Map<string, CachedParse>();
  /**
   * The notes that carry a marker at all, from one walk of the vault. Several
   * dashboards collecting for their own windows share this walk, and it is
   * dropped whenever any note changes.
   */
  private markerFiles: { key: string; files: TFile[] } | null = null;

  constructor(
    private readonly app: App,
    private readonly periodic: PeriodicNotes,
    private readonly getMarkers: () => JournalMarkerStyle[]
  ) {}

  invalidate(path?: string): void {
    this.markerFiles = null;
    if (path) this.cache.delete(path);
    else this.cache.clear();
  }

  /**
   * Re-reads one note and reports whether its marked lines actually changed.
   *
   * Obsidian writes a note to disk while it is still being typed in, so a
   * dashboard that rebuilt on every write would flicker through a sentence.
   * Comparing the parsed lines lets the common edit — typing anywhere that is
   * not a marked line — leave every open timeline untouched.
   */
  async syncFile(file: TFile): Promise<boolean> {
    const previous = this.cache.get(file.path);
    this.cache.delete(file.path);
    // This edit may be the one that gave the note its first marker, which is
    // what decides whether the note is read at all.
    this.markerFiles = null;
    const markers = this.getMarkers();
    if (markers.length === 0) return previous !== undefined && previous.notes.length > 0;
    const wanted = new Set(markers.map((style) => style.marker));
    const hasMarkers = this.app.metadataCache
      .getFileCache(file)
      ?.listItems
      ?.some((item) => item.task !== undefined && wanted.has(item.task)) ?? false;
    if (!hasMarkers) return previous !== undefined && previous.notes.length > 0;
    const notes = await this.parseFile(file, wanted);
    return signature(previous?.notes ?? []) !== signature(notes);
  }

  async collect(window: PeriodRange): Promise<JournalNote[]> {
    const markers = this.getMarkers();
    if (markers.length === 0) return [];
    const wanted = new Set(markers.map((style) => style.marker));

    const filesWithMarkers = this.filesWithMarkers(wanted);
    const candidates = (await Promise.all(filesWithMarkers.map(async (file) => {
      const context = await this.periodic.journalContextForFile(file);
      if (!context) return null;
      if (context.range.end.getTime() < window.start.getTime()) return null;
      if (context.range.start.getTime() > window.end.getTime()) return null;
      return { file, context };
    }))).flatMap((candidate) => candidate ? [candidate] : []);

    // cachedRead is asynchronous. Parse independent periodic notes together so
    // one slow vault read does not serially delay the whole dashboard.
    const parsedCandidates = await Promise.all(candidates.map(async ({ file, context }) => ({
      file,
      context,
      parsed: await this.parseFile(file, wanted),
    })));
    return parsedCandidates.flatMap(({ file, context, parsed }) => parsed.map((note) => ({
      id: `journal:${file.path}:${note.line}`,
      marker: note.marker,
      text: note.text,
      file,
      line: note.line,
      links: note.links,
      granularity: context.granularity,
      range: context.range,
    })));
  }

  private filesWithMarkers(wanted: Set<string>): TFile[] {
    const key = Array.from(wanted).sort().join(",");
    if (this.markerFiles && this.markerFiles.key === key) return this.markerFiles.files;
    const files = this.app.vault.getMarkdownFiles().filter((file) => {
      const listItems = this.app.metadataCache.getFileCache(file)?.listItems;
      return listItems?.some((item) => item.task !== undefined && wanted.has(item.task)) ?? false;
    });
    this.markerFiles = { key, files };
    return files;
  }

  private async parseFile(file: TFile, wanted: Set<string>): Promise<ParsedJournalNote[]> {
    const cached = this.cache.get(file.path);
    if (cached && cached.mtime === file.stat.mtime) return cached.notes;
    try {
      const content = await this.app.vault.cachedRead(file);
      const notes = parseJournalNotes(content, wanted);
      this.cache.set(file.path, { mtime: file.stat.mtime, notes });
      return notes;
    } catch (error) {
      console.error(`Property Logs: could not read ${file.path}`, error);
      return [];
    }
  }
}
