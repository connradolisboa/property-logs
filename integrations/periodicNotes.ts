import { App, Notice, TFile, moment, normalizePath } from "obsidian";

import {
  PeriodGranularity,
  isPeriodGranularity,
  parseDateString,
  periodRange,
  toDateString,
} from "../data/periodic";
import {
  PeriodicNoteContext,
  PeriodicNotesConfig,
  contextFromFileName,
  contextFromFrontmatter,
  granularityForSpan,
} from "../data/periodicContext";

export type { PeriodicNoteContext, PeriodicNotesConfig } from "../data/periodicContext";
export {
  contextFromFileName,
  contextFromFrontmatter,
  granularityForSpan,
} from "../data/periodicContext";

interface JournalNoteInfo {
  journal: string;
  date: string;
  endDate?: string;
}

interface JournalInfo {
  name: string;
  write: { type: string };
}

interface JournalsApi {
  apiVersion: number;
  listJournals(filter?: Record<string, unknown>): Promise<JournalInfo[]>;
  journalInfo(name: string): Promise<JournalInfo | null>;
  journalOf(file: TFile): Promise<JournalNoteInfo | null>;
  openNote(
    journal: string | Record<string, unknown>,
    date: string,
    options?: Record<string, unknown>
  ): Promise<unknown>;
}

const DAY_MS = 1000 * 60 * 60 * 24;

/** How long a Journals configuration lookup is trusted before it is asked again. */
const GRANULARITY_TTL_MS = 60_000;

interface CachedContext {
  mtime: number;
  context: Promise<PeriodicNoteContext | null>;
}

/**
 * Resolves periodic notes through the Journals plugin when it is available and
 * falls back to frontmatter, file names, and the core Daily Notes plugin.
 */
export class PeriodicNotes {
  /**
   * Resolved contexts, per note. The Journals plugin answers `journalOf`
   * asynchronously, and a dashboard asks it for every candidate periodic note
   * on every render, so the uncached round-trips are what keeps journal notes
   * arriving late. Entries are stamped with the note's mtime and dropped by
   * path when it changes; the plugin invalidates the lot when the periodic
   * configuration itself moves.
   */
  private readonly contexts = new Map<string, CachedContext>();
  private readonly journalContexts = new Map<string, CachedContext>();
  private granularities: { at: number; value: Promise<Set<PeriodGranularity>> } | null = null;

  constructor(
    private readonly app: App,
    private readonly getConfig: () => PeriodicNotesConfig
  ) {}

  /** Drops one note's resolved context, or every one of them. */
  invalidate(path?: string): void {
    if (path) {
      this.contexts.delete(path);
      this.journalContexts.delete(path);
      return;
    }
    this.contexts.clear();
    this.journalContexts.clear();
    this.granularities = null;
  }

  /**
   * The cached answer for one note, or a fresh lookup.
   *
   * The in-flight promise itself is what gets stored, so the burst of embeds
   * that all open on the same note resolve it once between them rather than
   * once each.
   */
  private resolveCached(
    store: Map<string, CachedContext>,
    file: TFile,
    compute: () => Promise<PeriodicNoteContext | null>
  ): Promise<PeriodicNoteContext | null> {
    const cached = store.get(file.path);
    if (cached && cached.mtime === file.stat.mtime) return cached.context;
    const context = compute().catch((error) => {
      console.error(`Property Logs: could not resolve the period of ${file.path}`, error);
      return null;
    });
    store.set(file.path, { mtime: file.stat.mtime, context });
    return context;
  }

  private api(): JournalsApi | null {
    const plugin = (this.app as any).plugins?.plugins?.journals;
    const api = plugin?.api;
    if (!api || typeof api.journalOf !== "function" || typeof api.openNote !== "function") {
      return null;
    }
    return api as JournalsApi;
  }

  hasJournals(): boolean {
    return this.api() !== null;
  }

  /** Frontmatter and file-name resolution only, safe to call in a render loop. */
  contextForFileSync(file: TFile): PeriodicNoteContext | null {
    const config = this.getConfig();
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as
      | Record<string, unknown>
      | undefined;
    return contextFromFrontmatter(frontmatter, config)
      ?? contextFromFileName(file.basename, config.weekStartsOn);
  }

  /** Full resolution, preferring the Journals index over heuristics. */
  contextForFile(file: TFile): Promise<PeriodicNoteContext | null> {
    return this.resolveCached(this.contexts, file, async () => {
      const journalContext = await this.contextFromJournals(file);
      if (journalContext) return journalContext;
      return this.contextForFileSync(file);
    });
  }

  /**
   * Strict eligibility for checkbox annotations. A note merely mentioning a
   * date, or having one in its filename, is not automatically a journal.
   */
  journalContextForFile(file: TFile): Promise<PeriodicNoteContext | null> {
    return this.resolveCached(this.journalContexts, file, () => this.resolveJournalContext(file));
  }

  private async resolveJournalContext(file: TFile): Promise<PeriodicNoteContext | null> {
    const journalContext = await this.contextFromJournals(file);
    if (journalContext) return journalContext;

    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as
      | Record<string, unknown>
      | undefined;
    // Custom periodic templates can opt in explicitly, without making a
    // generic `date:` field on an ordinary project note act like a journal.
    if (
      frontmatter
      && (typeof frontmatter.journal === "string"
        || Object.prototype.hasOwnProperty.call(frontmatter, "journal-start-date"))
    ) {
      const context = contextFromFrontmatter(frontmatter, this.getConfig());
      if (context) return context;
    }

    return this.dailyNoteContextForFile(file);
  }

  /**
   * Granularities that have a journal (or a daily note) to open.
   *
   * Every render asks, and the answer changes only when the user reconfigures
   * Journals, so it is held for a minute rather than fetched per dashboard.
   */
  availableGranularities(): Promise<Set<PeriodGranularity>> {
    const now = Date.now();
    if (this.granularities && now - this.granularities.at < GRANULARITY_TTL_MS) {
      return this.granularities.value;
    }
    const value = this.listGranularities();
    this.granularities = { at: now, value };
    return value;
  }

  private async listGranularities(): Promise<Set<PeriodGranularity>> {
    const available = new Set<PeriodGranularity>(["day"]);
    const api = this.api();
    if (!api) return available;
    try {
      const journals = await api.listJournals();
      journals.forEach((journal) => {
        if (isPeriodGranularity(journal.write?.type)) available.add(journal.write.type);
      });
    } catch (error) {
      console.error("Property Logs: could not list journals", error);
    }
    return available;
  }

  /** Opens (creating when needed) the periodic note covering `date`. */
  async openPeriod(granularity: PeriodGranularity, date: Date): Promise<void> {
    const anchor = toDateString(periodRange(granularity, date, this.getConfig().weekStartsOn).start);
    const api = this.api();
    if (api) {
      try {
        const journals = await api.listJournals().catch(() => [] as JournalInfo[]);
        const match = journals.find((journal) => journal.write?.type === granularity);
        if (match) {
          await api.openNote(match.name, anchor);
          return;
        }
        if (granularity !== "day") {
          new Notice(`No ${granularity} journal is configured in Journals.`);
          return;
        }
      } catch (error) {
        console.error("Property Logs: Journals could not open the note", error);
      }
    }

    if (granularity !== "day") {
      new Notice(`Install or configure a ${granularity} journal to open this period.`);
      return;
    }
    await this.openDailyNoteFallback(date);
  }

  private dailyNoteConfig(): { folder: string; format: string } {
    const config = this.getConfig();
    const fallback = {
      folder: config.dailyFolder,
      format: config.dailyFormat || "YYYY-MM-DD",
    };
    const internalPlugins = (this.app as any).internalPlugins;
    const daily = internalPlugins?.getPluginById?.("daily-notes")
      ?? internalPlugins?.plugins?.["daily-notes"];
    if (!daily?.enabled) return fallback;
    const options = daily.instance?.options ?? {};
    return {
      folder: typeof options.folder === "string" && options.folder ? options.folder : fallback.folder,
      format: typeof options.format === "string" && options.format ? options.format : fallback.format,
    };
  }

  private dailyNoteContextForFile(file: TFile): PeriodicNoteContext | null {
    const { folder, format } = this.dailyNoteConfig();
    const folderPath = normalizePath(folder || "");
    const parentPath = normalizePath(file.parent?.path || "");
    if (parentPath !== folderPath) return null;

    const parsed = moment(file.basename, format, true);
    if (!parsed.isValid()) return null;
    const date = new Date(parsed.year(), parsed.month(), parsed.date());
    return {
      granularity: "day",
      date,
      range: periodRange("day", date, this.getConfig().weekStartsOn),
      source: "daily-notes",
    };
  }

  private async contextFromJournals(file: TFile): Promise<PeriodicNoteContext | null> {
    const config = this.getConfig();
    const api = this.api();
    if (!api) return null;
    try {
      const note = await api.journalOf(file);
      if (!note) return null;
      const start = parseDateString(note.date);
      if (!start) return null;
      const end = note.endDate ? parseDateString(note.endDate) : null;
      const info = await api.journalInfo(note.journal).catch(() => null);
      const writeType = info?.write?.type;
      const granularity = isPeriodGranularity(writeType)
        ? writeType
        : granularityForSpan(end ? (end.getTime() - start.getTime()) / DAY_MS + 1 : 1);
      return {
        granularity,
        date: start,
        range: end
          ? { start, end: new Date(end.getTime() + DAY_MS) }
          : periodRange(granularity, start, config.weekStartsOn),
        journalName: note.journal,
        source: "journals",
      };
    } catch (error) {
      console.error("Property Logs: the Journals API could not resolve this note", error);
      return null;
    }
  }

  private async openDailyNoteFallback(date: Date): Promise<void> {
    const { folder, format } = this.dailyNoteConfig();
    const filename = `${moment(date).format(format)}.md`;
    const path = normalizePath(folder ? `${folder}/${filename}` : filename);
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      if (folder && !this.app.vault.getAbstractFileByPath(normalizePath(folder))) {
        await this.app.vault.createFolder(normalizePath(folder));
      }
      try {
        file = await this.app.vault.create(path, "");
      } catch (error) {
        console.error("Property Logs: could not create the daily note", error);
        new Notice("Property Logs could not create that daily note.");
        return;
      }
    }
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
  }
}
