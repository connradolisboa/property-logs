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

/**
 * Collects `- [n] …` lines from periodic notes so they can be drawn on the
 * timeline. Files are pre-filtered through Obsidian's metadata cache, so only
 * notes that actually carry a configured marker are ever read from disk.
 */
export class JournalNoteIndex {
  private readonly cache = new Map<string, CachedParse>();

  constructor(
    private readonly app: App,
    private readonly periodic: PeriodicNotes,
    private readonly getMarkers: () => JournalMarkerStyle[]
  ) {}

  invalidate(path?: string): void {
    if (path) this.cache.delete(path);
    else this.cache.clear();
  }

  async collect(window: PeriodRange): Promise<JournalNote[]> {
    const markers = this.getMarkers();
    if (markers.length === 0) return [];
    const wanted = new Set(markers.map((style) => style.marker));

    const filesWithMarkers = this.app.vault.getMarkdownFiles().filter((file) => {
      const listItems = this.app.metadataCache.getFileCache(file)?.listItems;
      return listItems?.some((item) => item.task !== undefined && wanted.has(item.task)) ?? false;
    });
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
