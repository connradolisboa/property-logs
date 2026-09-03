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

/**
 * Resolves periodic notes through the Journals plugin when it is available and
 * falls back to frontmatter, file names, and the core Daily Notes plugin.
 */
export class PeriodicNotes {
  constructor(
    private readonly app: App,
    private readonly getConfig: () => PeriodicNotesConfig
  ) {}

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
  async contextForFile(file: TFile): Promise<PeriodicNoteContext | null> {
    const config = this.getConfig();
    const api = this.api();
    if (api) {
      try {
        const note = await api.journalOf(file);
        if (note) {
          const start = parseDateString(note.date);
          if (start) {
            const end = note.endDate ? parseDateString(note.endDate) : null;
            const info = await api.journalInfo(note.journal).catch(() => null);
            const writeType = info?.write?.type;
            const granularity = isPeriodGranularity(writeType)
              ? writeType
              : granularityForSpan(
                  end ? (end.getTime() - start.getTime()) / DAY_MS + 1 : 1
                );
            return {
              granularity,
              date: start,
              range: end
                ? { start, end: new Date(end.getTime() + DAY_MS) }
                : periodRange(granularity, start, config.weekStartsOn),
              journalName: note.journal,
              source: "journals",
            };
          }
        }
      } catch (error) {
        console.error("Property Logs: the Journals API could not resolve this note", error);
      }
    }
    return this.contextForFileSync(file);
  }

  /** Granularities that have a journal (or a daily note) to open. */
  async availableGranularities(): Promise<Set<PeriodGranularity>> {
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
