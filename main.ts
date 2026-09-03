import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TextAreaComponent, TextComponent, TFile, moment, normalizePath } from "obsidian";

import {
  DashboardSettings,
  isFileInDashboardScope,
  normalizeDashboardSettings,
} from "./data/dashboard";
import { collectCompatibleHistory, historyContainsKey } from "./data/historyCompatibility";
import { DashboardPickerModal } from "./modals/DashboardPickerModal";
import { renderDashboardSettingsPane } from "./settings/dashboardSettings";
import { TIMELINE_VIEW_TYPE, TimelineDashboardView } from "./view/TimelineView";

type StatusEntry = Record<string, string>;

type PeriodType = "week" | "month" | "quarter" | "year";

type KeyForm = "frontmatter" | "history";

interface DailyNoteGroup {
  tag: string;
  template: string;
  watchedKeys: string[];
  keyForm: KeyForm;
}

interface DailyNoteLogSettings {
  enabled: boolean;
  folder: string;
  dateFormat: string;
  heading: string;
  groups: DailyNoteGroup[];
}

interface PluginSettings {
  includedFolders: string[];
  includedTags: string[];
  excludedFolders: string[];
  excludedTags: string[];
  overwriteSameDay: boolean;
  skipDuplicateStatus: boolean;
  historyKey: string;
  dateKey: string;
  statusKey: string;
  additionalProperties: { frontmatterKey: string; historyKey: string }[];
  chartDefaults: {
    folder: string;
    tags: string;
    periodType: PeriodType;
    startDate: string;
    endDate: string;
  };
  dailyNoteLog: DailyNoteLogSettings;
  dashboards: DashboardSettings[];
}

interface PluginData {
  previousStatuses: Record<string, string>;
  previousPropertyValues: Record<string, Record<string, string>>;
  settings: PluginSettings;
}

const currentYear = new Date().getFullYear();

const DEFAULT_SETTINGS: PluginSettings = {
  includedFolders: [],
  includedTags: [],
  excludedFolders: [],
  excludedTags: [],
  overwriteSameDay: false,
  skipDuplicateStatus: false,
  historyKey: "property_history",
  dateKey: "dateSet",
  statusKey: "statusSet",
  additionalProperties: [],
  chartDefaults: {
    folder: "",
    tags: "",
    periodType: "month",
    startDate: `${currentYear}-01-01`,
    endDate: `${currentYear}-12-31`,
  },
  dailyNoteLog: {
    enabled: false,
    folder: "",
    dateFormat: "YYYY-MM-DD",
    heading: "",
    groups: [],
  },
  dashboards: [],
};

export default class PropertyLogsPlugin extends Plugin {
  private previousStatuses: Map<string, string> = new Map();
  private previousPropertyValues: Map<string, Record<string, string>> = new Map();
  settings: PluginSettings = { ...DEFAULT_SETTINGS };

  async onload() {
    console.log("Property Logs Plugin loaded");

    await this.load_();

    this.registerView(TIMELINE_VIEW_TYPE, (leaf) => new TimelineDashboardView(leaf, this));

    this.addSettingTab(new StatusHistorySettingTab(this.app, this));

    this.addRibbonIcon("chart-gantt", "Open Property Logs dashboard", () => {
      this.openDashboardPicker();
    });

    this.addCommand({
      id: "open-property-logs-dashboard",
      name: "Open timeline dashboard",
      callback: () => this.openDashboardPicker(),
    });

    this.addCommand({
      id: "insert-status-chart",
      name: "Insert status chart",
      editorCallback: () => {
        new InsertChartModal(this.app, this).open();
      },
    });

    this.addCommand({
      id: "add-comment-to-note",
      name: "Add comment to note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) new AddCommentModal(this.app, this, file).open();
        return true;
      },
    });

    this.app.workspace.onLayoutReady(() => {
      this.loadAllStatuses();
    });

    this.registerEvent(
      this.app.metadataCache.on("changed", (file: TFile) => {
        void this.handleMetadataChange(file);
        this.refreshDashboardViews();
      })
    );

    this.registerEvent(this.app.vault.on("create", () => this.refreshDashboardViews()));
    this.registerEvent(this.app.vault.on("delete", () => this.refreshDashboardViews()));
    this.registerEvent(this.app.vault.on("rename", () => this.refreshDashboardViews()));
  }

  getDashboards(): DashboardSettings[] {
    return this.settings.dashboards;
  }

  getDashboard(id: string): DashboardSettings | undefined {
    return this.settings.dashboards.find((dashboard) => dashboard.id === id);
  }

  async setDashboards(dashboards: DashboardSettings[]): Promise<void> {
    this.settings.dashboards = dashboards;
    await this.save();
    this.refreshDashboardViews();
  }

  getDashboardHistoryKey(): string {
    return this.settings.historyKey;
  }

  getDashboardDateKey(): string {
    return this.settings.dateKey;
  }

  getDashboardFiles(dashboard: DashboardSettings): TFile[] {
    return this.app.vault.getMarkdownFiles().filter((file) => {
      const cache = this.app.metadataCache.getFileCache(file);
      const tags = new Set<string>();
      const frontmatterTags = cache?.frontmatter?.tags;
      if (Array.isArray(frontmatterTags)) {
        frontmatterTags.forEach((tag) => tags.add(String(tag).replace(/^#/, "")));
      } else if (frontmatterTags !== undefined && frontmatterTags !== null) {
        tags.add(String(frontmatterTags).replace(/^#/, ""));
      }
      cache?.tags?.forEach((tag) => tags.add(tag.tag.replace(/^#/, "")));
      return isFileInDashboardScope({
        path: file.path,
        tags,
        frontmatter: cache?.frontmatter as Record<string, unknown> | undefined,
      }, dashboard.scopeFilter);
    });
  }

  noteHasTrackedHistory(file: TFile, dashboard: DashboardSettings): boolean {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
    const history = collectCompatibleHistory(
      frontmatter ?? {},
      this.settings.historyKey,
      this.settings.dateKey
    );
    const trackedHistoryKey = this.resolveHistoryKey(dashboard.trackedPropertyKey);
    return historyContainsKey(history, trackedHistoryKey);
  }

  async createDashboardNote(title: string, folder: string, dashboard: DashboardSettings): Promise<TFile> {
    const normalizedFolder = normalizePath(folder).replace(/^\/+|\/+$/g, "");
    if (normalizedFolder) {
      const segments = normalizedFolder.split("/");
      let current = "";
      for (const segment of segments) {
        current = current ? `${current}/${segment}` : segment;
        if (!this.app.vault.getAbstractFileByPath(current)) {
          await this.app.vault.createFolder(current);
        }
      }
    }
    const path = normalizePath(normalizedFolder ? `${normalizedFolder}/${title}.md` : `${title}.md`);
    if (this.app.vault.getAbstractFileByPath(path)) {
      throw new Error(`A note already exists at ${path}.`);
    }
    const file = await this.app.vault.create(path, "");
    const firstTag = dashboard.scopeFilter.includedTags[0];
    const firstProperty = dashboard.scopeFilter.includedProperties[0];
    if (firstTag || (firstProperty && firstProperty.key !== dashboard.trackedPropertyKey)) {
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        if (firstTag) {
          const existing = Array.isArray(frontmatter.tags)
            ? frontmatter.tags.map(String)
            : frontmatter.tags
              ? [String(frontmatter.tags)]
              : [];
          if (!existing.includes(firstTag)) existing.push(firstTag);
          frontmatter.tags = existing;
        }
        if (firstProperty && firstProperty.key !== dashboard.trackedPropertyKey) {
          frontmatter[firstProperty.key] = firstProperty.value || true;
        }
      });
    }
    return file;
  }

  async openDashboard(id: string): Promise<void> {
    const dashboard = this.getDashboard(id);
    if (!dashboard) {
      new Notice("Property Logs dashboard not found.");
      return;
    }

    const existing = this.app.workspace.getLeavesOfType(TIMELINE_VIEW_TYPE).find((leaf) =>
      leaf.view instanceof TimelineDashboardView && leaf.view.getState().dashboardId === id
    );
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      return;
    }

    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: TIMELINE_VIEW_TYPE,
      active: true,
      state: { dashboardId: id },
    });
    await this.app.workspace.revealLeaf(leaf);
  }

  refreshDashboardViews(): void {
    this.app.workspace.getLeavesOfType(TIMELINE_VIEW_TYPE).forEach((leaf) => {
      if (leaf.view instanceof TimelineDashboardView) leaf.view.refresh();
    });
  }

  private openDashboardPicker(): void {
    if (this.settings.dashboards.length === 0) {
      new Notice("Create a dashboard in Property Logs settings first.");
    } else if (this.settings.dashboards.length === 1) {
      void this.openDashboard(this.settings.dashboards[0].id);
    } else {
      new DashboardPickerModal(this.app, this).open();
    }
  }

  async load_() {
    const data: PluginData | null = await this.loadData();
    if (data?.settings) {
      this.settings = {
        ...DEFAULT_SETTINGS,
        ...data.settings,
        chartDefaults: {
          ...DEFAULT_SETTINGS.chartDefaults,
          ...(data.settings.chartDefaults ?? {}),
        },
        dailyNoteLog: {
          ...DEFAULT_SETTINGS.dailyNoteLog,
          ...(data.settings.dailyNoteLog ?? {}),
          groups: data.settings.dailyNoteLog?.groups ?? [],
        },
        dashboards: Array.isArray(data.settings.dashboards)
          ? data.settings.dashboards.map((dashboard, index) =>
              normalizeDashboardSettings(dashboard, `dashboard-${index + 1}`, `Dashboard ${index + 1}`)
            )
          : [],
      };
    }
    if (data?.previousStatuses) {
      this.previousStatuses = new Map(Object.entries(data.previousStatuses));
    }
    if (data?.previousPropertyValues) {
      this.previousPropertyValues = new Map(Object.entries(data.previousPropertyValues));
    }
  }

  async save() {
    await this.saveData({
      previousStatuses: Object.fromEntries(this.previousStatuses),
      previousPropertyValues: Object.fromEntries(this.previousPropertyValues),
      settings: this.settings,
    });
  }

  async loadAllStatuses() {
    const files = this.app.vault.getMarkdownFiles();
    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (!fm) continue;
      if (fm.status) {
        this.previousStatuses.set(file.path, String(fm.status));
      }
      const props = this.getTrackedPropertyConfigs();
      if (props.length > 0) {
        const existing = this.previousPropertyValues.get(file.path) ?? {};
        let changed = false;
        for (const { frontmatterKey } of props) {
          const val = fm[frontmatterKey];
          if (val !== undefined && val !== null && existing[frontmatterKey] === undefined) {
            existing[frontmatterKey] = String(val);
            changed = true;
          }
        }
        if (changed) this.previousPropertyValues.set(file.path, existing);
      }
    }
    await this.save();
  }

  isFileWatched(file: TFile): boolean {
    const { includedFolders, includedTags, excludedFolders, excludedTags } = this.settings;

    const folderPath = file.parent?.path ?? "";
    const matchesFolder = (folders: string[]) =>
      folders.some((f) => folderPath === f || folderPath.startsWith(f + "/"));

    const getFileTags = (): Set<string> => {
      const cache = this.app.metadataCache.getFileCache(file);
      const tags = new Set<string>();
      const fmTags = cache?.frontmatter?.tags;
      if (Array.isArray(fmTags)) fmTags.forEach((t) => tags.add(String(t)));
      else if (fmTags != null) tags.add(String(fmTags));
      cache?.tags?.forEach((t) => tags.add(t.tag.replace(/^#/, "")));
      return tags;
    };

    const matchesTags = (watchedTags: string[]) => {
      if (watchedTags.length === 0) return false;
      const fileTags = getFileTags();
      return watchedTags.some((t) => fileTags.has(t));
    };

    // Exclusions take priority
    if (matchesFolder(excludedFolders) || matchesTags(excludedTags)) return false;

    // If no inclusions defined, include everything
    if (includedFolders.length === 0 && includedTags.length === 0) return true;

    return matchesFolder(includedFolders) || matchesTags(includedTags);
  }

  async handleMetadataChange(file: TFile) {
    if (!this.isFileWatched(file)) return;

    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;

    const newStatus = fm?.status as string | undefined;
    const previousStatus = this.previousStatuses.get(file.path);
    const statusChanged = newStatus !== undefined && newStatus !== previousStatus;

    const prevProps = this.previousPropertyValues.get(file.path) ?? {};
    // changedProps: historyKey → new value (for writing to history entry)
    const changedProps: Record<string, string> = {};
    // realChanges: structured per-property change list (used by daily-note logger)
    const realChanges: Array<{ fmKey: string; histKey: string; from: string; to: string }> = [];
    // updatedTracking: frontmatterKey → new value (for persisting previous values)
    const updatedTracking: Record<string, string> = { ...prevProps };
    for (const { frontmatterKey, historyKey } of this.getTrackedPropertyConfigs()) {
      const newVal = fm?.[frontmatterKey];
      if (newVal === undefined || newVal === null) continue;
      const strVal = String(newVal);
      if (prevProps[frontmatterKey] !== undefined && prevProps[frontmatterKey] !== strVal) {
        changedProps[historyKey] = strVal;
        updatedTracking[frontmatterKey] = strVal;
        realChanges.push({ fmKey: frontmatterKey, histKey: historyKey, from: prevProps[frontmatterKey], to: strVal });
      } else if (prevProps[frontmatterKey] === undefined) {
        // Establish baseline silently
        updatedTracking[frontmatterKey] = strVal;
      }
    }

    if (!statusChanged && Object.keys(changedProps).length === 0) return;

    // Update tracking
    if (newStatus !== undefined) this.previousStatuses.set(file.path, newStatus);
    this.previousPropertyValues.set(file.path, updatedTracking);
    await this.save();

    // Don't log on first-time baseline (no previous value)
    const shouldLogStatus = statusChanged && previousStatus !== undefined && !!newStatus;
    if (!shouldLogStatus && Object.keys(changedProps).length === 0) return;

    if (shouldLogStatus) {
      realChanges.unshift({ fmKey: "status", histKey: this.settings.statusKey, from: previousStatus!, to: newStatus! });
    }

    await this.appendStatusHistory(file, shouldLogStatus ? newStatus! : undefined, changedProps);
    await this.logChangesToDailyNote(file, realChanges);
  }

  normalizeEntry(entry: StatusEntry): StatusEntry {
    const { dateKey, statusKey, additionalProperties } = this.settings;
    const ordered: StatusEntry = {};
    if (entry[dateKey] !== undefined) ordered[dateKey] = entry[dateKey];
    if (entry["comment"] !== undefined) ordered["comment"] = entry["comment"];
    if (entry[statusKey] !== undefined) ordered[statusKey] = entry[statusKey];
    const orderedPropertyKeys = [
      ...additionalProperties.map((property) => property.historyKey),
      ...this.settings.dashboards.map((dashboard) => this.resolveHistoryKey(dashboard.trackedPropertyKey)),
    ];
    for (const historyKey of new Set(orderedPropertyKeys)) {
      if (entry[historyKey] !== undefined) ordered[historyKey] = entry[historyKey];
    }
    for (const [k, v] of Object.entries(entry)) {
      if (!(k in ordered)) ordered[k] = v;
    }
    return ordered;
  }

  resolveHistoryKey(frontmatterKey: string): string {
    if (frontmatterKey === "status") return this.settings.statusKey;
    return this.settings.additionalProperties.find(
      (property) => property.frontmatterKey === frontmatterKey
    )?.historyKey ?? `${frontmatterKey}Set`;
  }

  private getTrackedPropertyConfigs(): Array<{ frontmatterKey: string; historyKey: string }> {
    const properties = new Map<string, string>();
    this.settings.additionalProperties.forEach((property) => {
      if (property.frontmatterKey !== "status") {
        properties.set(property.frontmatterKey, property.historyKey);
      }
    });
    this.settings.dashboards.forEach((dashboard) => {
      const key = dashboard.trackedPropertyKey.trim();
      if (key && key !== "status" && !properties.has(key)) {
        properties.set(key, this.resolveHistoryKey(key));
      }
    });
    return Array.from(properties, ([frontmatterKey, historyKey]) => ({ frontmatterKey, historyKey }));
  }

  private updateHistoryInFrontmatter(
    frontmatter: Record<string, any>,
    today: string,
    newStatus?: string,
    changedProps: Record<string, string> = {}
  ): boolean {
    const { historyKey, dateKey, statusKey } = this.settings;
    const history: StatusEntry[] = Array.isArray(frontmatter[historyKey])
      ? frontmatter[historyKey]
      : [];

    if (
      this.settings.skipDuplicateStatus &&
      newStatus !== undefined &&
      history.length > 0 &&
      history[history.length - 1][statusKey] === newStatus
    ) {
      return false;
    }

    const newEntry: StatusEntry = { [dateKey]: today };
    if (newStatus !== undefined) newEntry[statusKey] = newStatus;
    for (const [key, value] of Object.entries(changedProps)) newEntry[key] = value;

    const lastEntry = history.length > 0 ? history[history.length - 1] : null;
    if (lastEntry?.[dateKey] === today) {
      history[history.length - 1] = this.normalizeEntry({ ...lastEntry, ...newEntry });
    } else {
      history.push(this.normalizeEntry(newEntry));
    }
    frontmatter[historyKey] = history;
    return true;
  }

  async appendStatusHistory(file: TFile, newStatus?: string, changedProps: Record<string, string> = {}) {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      this.updateHistoryInFrontmatter(frontmatter, today, newStatus, changedProps);
    });

    console.log(`Property Logs: logged changes for ${file.name}`);
  }

  async setTrackedPropertyValue(file: TFile, frontmatterKey: string, value: string): Promise<void> {
    const key = frontmatterKey.trim();
    if (!key) throw new Error("A tracked frontmatter property is required.");

    const cache = this.app.metadataCache.getFileCache(file);
    const currentRaw = cache?.frontmatter?.[key];
    const previousValue = currentRaw === undefined || currentRaw === null ? "" : String(currentRaw);
    if (previousValue === value) return;

    const historyKey = this.resolveHistoryKey(key);
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    if (key === "status") {
      this.previousStatuses.set(file.path, value);
    } else {
      const previous = this.previousPropertyValues.get(file.path) ?? {};
      this.previousPropertyValues.set(file.path, { ...previous, [key]: value });
    }

    try {
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        frontmatter[key] = value;
        this.updateHistoryInFrontmatter(
          frontmatter,
          today,
          key === "status" ? value : undefined,
          key === "status" ? {} : { [historyKey]: value }
        );
      });
      await this.save();
      await this.logChangesToDailyNote(file, [{
        fmKey: key,
        histKey: historyKey,
        from: previousValue,
        to: value,
      }]);
    } catch (error) {
      if (key === "status") {
        if (currentRaw === undefined || currentRaw === null) this.previousStatuses.delete(file.path);
        else this.previousStatuses.set(file.path, previousValue);
      } else {
        const tracked = { ...(this.previousPropertyValues.get(file.path) ?? {}) };
        if (currentRaw === undefined || currentRaw === null) delete tracked[key];
        else tracked[key] = previousValue;
        this.previousPropertyValues.set(file.path, tracked);
      }
      throw error;
    }
  }

  // ─── Daily Note Logging ─────────────────────────────────────────────────────

  private getFileTagsSet(file: TFile): Set<string> {
    const cache = this.app.metadataCache.getFileCache(file);
    const tags = new Set<string>();
    const fmTags = cache?.frontmatter?.tags;
    if (Array.isArray(fmTags)) fmTags.forEach((t) => tags.add(String(t)));
    else if (fmTags != null) tags.add(String(fmTags));
    cache?.tags?.forEach((t) => tags.add(t.tag.replace(/^#/, "")));
    return tags;
  }

  private findMatchingDailyNoteGroup(file: TFile): DailyNoteGroup | null {
    const fileTags = this.getFileTagsSet(file);
    for (const group of this.settings.dailyNoteLog.groups) {
      const tag = group.tag.trim();
      if (!tag) continue;
      if (fileTags.has(tag)) return group;
    }
    return null;
  }

  private resolveDailyNoteConfig(): { folder: string; format: string } {
    const fallback = {
      folder: this.settings.dailyNoteLog.folder,
      format: this.settings.dailyNoteLog.dateFormat || "YYYY-MM-DD",
    };
    const internalPlugins = (this.app as any).internalPlugins;
    const dn = internalPlugins?.getPluginById?.("daily-notes") ?? internalPlugins?.plugins?.["daily-notes"];
    if (dn?.enabled) {
      const opts = dn.instance?.options ?? {};
      return {
        folder: typeof opts.folder === "string" && opts.folder ? opts.folder : fallback.folder,
        format: typeof opts.format === "string" && opts.format ? opts.format : fallback.format,
      };
    }
    return fallback;
  }

  private async getOrCreateDailyNote(): Promise<TFile> {
    const { folder, format } = this.resolveDailyNoteConfig();
    const filename = `${moment().format(format)}.md`;
    const path = normalizePath(folder ? `${folder}/${filename}` : filename);

    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) return existing;

    if (folder) {
      const folderPath = normalizePath(folder);
      if (!this.app.vault.getAbstractFileByPath(folderPath)) {
        await this.app.vault.createFolder(folderPath);
      }
    }
    return await this.app.vault.create(path, "");
  }

  private formatTemplate(template: string, vars: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => vars[key] ?? "");
  }

  private async appendToDailyNote(file: TFile, line: string, heading: string) {
    await this.app.vault.process(file, (content) => {
      if (!heading.trim()) {
        const sep = content.length === 0 || content.endsWith("\n") ? "" : "\n";
        return content + sep + line + "\n";
      }

      const headingTrimmed = heading.trim();
      const headingMatch = headingTrimmed.match(/^(#+)\s/);
      const level = headingMatch ? headingMatch[1].length : 0;

      const lines = content.split("\n");
      let headingIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === headingTrimmed) {
          headingIdx = i;
          break;
        }
      }

      if (headingIdx === -1) {
        const prefix = content.length === 0 ? "" : (content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n");
        return content + prefix + headingTrimmed + "\n" + line + "\n";
      }

      let sectionEnd = lines.length;
      if (level > 0) {
        for (let i = headingIdx + 1; i < lines.length; i++) {
          const m = lines[i].match(/^(#+)\s/);
          if (m && m[1].length <= level) {
            sectionEnd = i;
            break;
          }
        }
      }

      let insertAt = sectionEnd;
      while (insertAt > headingIdx + 1 && lines[insertAt - 1].trim() === "") {
        insertAt--;
      }

      lines.splice(insertAt, 0, line);
      return lines.join("\n");
    });
  }

  async logChangesToDailyNote(
    file: TFile,
    changes: Array<{ fmKey: string; histKey: string; from: string; to: string }>
  ) {
    if (!this.settings.dailyNoteLog.enabled) return;
    if (changes.length === 0) return;

    const group = this.findMatchingDailyNoteGroup(file);
    if (!group) return;

    const watched = group.watchedKeys.map((k) => k.trim()).filter((k) => k);
    const filtered = watched.length > 0 ? changes.filter((c) => watched.includes(c.fmKey)) : changes;
    if (filtered.length === 0) return;

    const dailyNote = await this.getOrCreateDailyNote();
    if (dailyNote.path === file.path) return; // never log into the file that changed

    const now = moment();
    const date = now.format("YYYY-MM-DD");
    const time = now.format("HH:mm");

    for (const change of filtered) {
      const vars: Record<string, string> = {
        link: `[[${file.basename}]]`,
        name: file.basename,
        path: file.path,
        key: group.keyForm === "history" ? change.histKey : change.fmKey,
        from: change.from,
        to: change.to,
        date,
        time,
      };
      const line = this.formatTemplate(group.template, vars);
      await this.appendToDailyNote(dailyNote, line, this.settings.dailyNoteLog.heading);
    }
  }

  onunload() {
    console.log("Property Logs Plugin unloaded");
  }
}

// ─── Chart Helpers ───────────────────────────────────────────────────────────

function buildPagesQuery(folder: string, tags: string[]): string {
  const parts: string[] = [];
  if (folder) parts.push(`"${folder}"`);
  tags.forEach((t) => parts.push(`#${t}`));
  return parts.join(" and ");
}

function generateChartCode(
  pagesQuery: string,
  periodType: PeriodType,
  startDate: string,
  endDate: string,
  historyKey: string,
  dateKey: string,
  statusKey: string
): string {
  const pagesArg = pagesQuery ? JSON.stringify(pagesQuery) : '""';
  return `const todoistColors = {
  "berry_red":   "#b8256f",
  "red":         "#db4035",
  "orange":      "#ff9933",
  "yellow":      "#fad000",
  "olive_green": "#afb83b",
  "lime_green":  "#7ecc49",
  "green":       "#299438",
  "mint_green":  "#6accbc",
  "teal":        "#158fad",
  "sky_blue":    "#14aaf5",
  "light_blue":  "#96c3eb",
  "blue":        "#4073ff",
  "grape":       "#884dff",
  "violet":      "#af38eb",
  "lavender":    "#eb96eb",
  "magenta":     "#e05194",
  "salmon":      "#ff8d85",
  "charcoal":    "#808080",
  "grey":        "#b8b8b8",
  "taupe":       "#ccac93"
};

const statusMap = {
  "Inactive": 1, "New": 1, "Cancelled": 1,
  "Backlog": 2,
  "Ongoing": 3,
  "Active": 4,
  "Done": 5
};

const pointShapeMap = {
  "Inactive": "circle",
  "New": "triangle",
  "Cancelled": "cross"
};

const periodType = ${JSON.stringify(periodType)};
const start = new Date(${JSON.stringify(startDate)} + "T00:00:00");
const end = new Date(${JSON.stringify(endDate)} + "T00:00:00");

// Build periods array: { label, periodEnd }
const periods = [];
if (periodType === "month") {
  let cur = new Date(start.getFullYear(), start.getMonth(), 1);
  const stop = new Date(end.getFullYear(), end.getMonth(), 1);
  while (cur <= stop) {
    const label = cur.toLocaleString("en-US", { month: "short", year: "numeric" });
    const periodEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
    periods.push({ label, periodEnd });
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }
} else if (periodType === "quarter") {
  let cur = new Date(start.getFullYear(), Math.floor(start.getMonth() / 3) * 3, 1);
  while (cur <= end) {
    const q = Math.floor(cur.getMonth() / 3) + 1;
    const label = \`Q\${q} \${cur.getFullYear()}\`;
    const periodEnd = new Date(cur.getFullYear(), cur.getMonth() + 3, 0);
    periods.push({ label, periodEnd });
    cur = new Date(cur.getFullYear(), cur.getMonth() + 3, 1);
  }
} else if (periodType === "year") {
  let cur = new Date(start.getFullYear(), 0, 1);
  while (cur.getFullYear() <= end.getFullYear()) {
    const label = String(cur.getFullYear());
    const periodEnd = new Date(cur.getFullYear(), 11, 31);
    periods.push({ label, periodEnd });
    cur = new Date(cur.getFullYear() + 1, 0, 1);
  }
} else if (periodType === "week") {
  // Align to the Monday of the week containing startDate
  let cur = new Date(start);
  const day = cur.getDay();
  cur.setDate(cur.getDate() - (day === 0 ? 6 : day - 1));
  while (cur <= end) {
    const weekEnd = new Date(cur);
    weekEnd.setDate(weekEnd.getDate() + 6);
    // ISO week number
    const d = new Date(Date.UTC(cur.getFullYear(), cur.getMonth(), cur.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    const label = \`\${d.getUTCFullYear()}-W\${String(weekNum).padStart(2, "0")}\`;
    periods.push({ label, periodEnd: weekEnd });
    cur.setDate(cur.getDate() + 7);
  }
}

const labels = periods.map(p => p.label);

const pages = dv.pages(${pagesArg});
const datasets = [];

for (let page of pages) {
  const history = page[${JSON.stringify(historyKey)}];
  const createdDate = page.date ? new Date(page.date) : null;
  const rawColor = page.color ?? "charcoal";
  const color = todoistColors[rawColor] ?? rawColor;

  const sorted = (history && Array.isArray(history))
    ? history
        .map(e => ({ date: new Date(e[${JSON.stringify(dateKey)}] + "T00:00:00"), status: e[${JSON.stringify(statusKey)}] }))
        .sort((a, b) => a.date - b.date)
    : [];

  const data = [];
  const pointStyles = [];
  const pointRadii = [];

  periods.forEach(({ periodEnd }) => {
    if (createdDate && periodEnd < createdDate) {
      data.push(null);
      pointStyles.push("circle");
      pointRadii.push(0);
      return;
    }

    let currentStatus = null;
    for (let entry of sorted) {
      if (entry.date <= periodEnd) {
        currentStatus = entry.status;
      } else {
        break;
      }
    }

    if (currentStatus === null) currentStatus = "Inactive";

    data.push(statusMap[currentStatus] ?? null);
    pointStyles.push(pointShapeMap[currentStatus] ?? "circle");
    pointRadii.push(5);
  });

  datasets.push({
    label: page.file.name,
    data: data,
    borderColor: color,
    backgroundColor: color + "33",
    pointStyle: pointStyles,
    pointRadius: pointRadii,
    tension: 0.3,
    spanGaps: true,
  });
}

const chartData = {
  type: "line",
  data: { labels: labels, datasets: datasets },
  options: {
    responsive: true,
    scales: {
      y: {
        min: 1,
        max: 5,
        ticks: {
          stepSize: 1,
          callback: val => ["","Inactive/New/Cancelled","Backlog","Ongoing","Active","Done"][val] ?? ""
        }
      }
    },
    plugins: {
      legend: { position: "bottom" },
      tooltip: {
        callbacks: {
          label: ctx => {
            const statusLabels = ["","Inactive/New/Cancelled","Backlog","Ongoing","Active","Done"];
            return \`\${ctx.dataset.label}: \${statusLabels[ctx.raw] ?? "Unknown"}\`;
          }
        }
      }
    }
  }
};

window.renderChart(chartData, this.container);`;
}

// ─── Insert Chart Modal ───────────────────────────────────────────────────────

class InsertChartModal extends Modal {
  private plugin: PropertyLogsPlugin;
  private folder: string;
  private tags: string;
  private periodType: PeriodType;
  private startDate: string;
  private endDate: string;

  constructor(app: App, plugin: PropertyLogsPlugin) {
    super(app);
    this.plugin = plugin;
    this.folder = plugin.settings.chartDefaults.folder;
    this.tags = plugin.settings.chartDefaults.tags;
    this.periodType = plugin.settings.chartDefaults.periodType;
    this.startDate = plugin.settings.chartDefaults.startDate;
    this.endDate = plugin.settings.chartDefaults.endDate;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Insert Status Chart" });

    new Setting(contentEl)
      .setName("Folder")
      .setDesc("Filter pages by folder path (e.g. Management). Leave empty for all folders.")
      .addText((text) =>
        text.setValue(this.folder).onChange((val) => (this.folder = val))
      );

    new Setting(contentEl)
      .setName("Tags")
      .setDesc("Filter pages by tags, comma-separated without # (e.g. area, project). Leave empty for all tags.")
      .addText((text) =>
        text.setValue(this.tags).onChange((val) => (this.tags = val))
      );

    new Setting(contentEl)
      .setName("Period")
      .setDesc("The time interval for each data point on the X axis.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("week", "Week")
          .addOption("month", "Month")
          .addOption("quarter", "Quarter")
          .addOption("year", "Year")
          .setValue(this.periodType)
          .onChange((val) => (this.periodType = val as PeriodType))
      );

    new Setting(contentEl)
      .setName("Start date")
      .setDesc("Start of the date range (YYYY-MM-DD).")
      .addText((text) =>
        text.setValue(this.startDate).onChange((val) => (this.startDate = val))
      );

    new Setting(contentEl)
      .setName("End date")
      .setDesc("End of the date range (YYYY-MM-DD).")
      .addText((text) =>
        text.setValue(this.endDate).onChange((val) => (this.endDate = val))
      );

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Insert")
          .setCta()
          .onClick(async () => {
            await this.insertChart();
            this.close();
          })
      )
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => this.close())
      );
  }

  onClose() {
    this.contentEl.empty();
  }

  async insertChart() {
    this.plugin.settings.chartDefaults = {
      folder: this.folder,
      tags: this.tags,
      periodType: this.periodType,
      startDate: this.startDate,
      endDate: this.endDate,
    };
    await this.plugin.save();

    const editor = this.app.workspace.activeEditor?.editor;
    if (!editor) return;

    const tags = this.tags
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t);
    const pagesQuery = buildPagesQuery(this.folder.trim(), tags);
    const { historyKey, dateKey, statusKey } = this.plugin.settings;
    const chartCode = generateChartCode(pagesQuery, this.periodType, this.startDate, this.endDate, historyKey, dateKey, statusKey);

    editor.replaceRange("```dataviewjs\n" + chartCode + "\n```", editor.getCursor());
  }
}

// ─── Add Comment Modal ────────────────────────────────────────────────────────

class AddCommentModal extends Modal {
  private plugin: PropertyLogsPlugin;
  private file: TFile;
  private comment: string = "";

  constructor(app: App, plugin: PropertyLogsPlugin, file: TFile) {
    super(app);
    this.plugin = plugin;
    this.file = file;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Add comment to note" });

    new Setting(contentEl)
      .setName("Comment")
      .addText((text) => {
        text.setPlaceholder("Enter comment…").onChange((val) => (this.comment = val));
        text.inputEl.style.width = "100%";
        text.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { this.submit(); }
        });
        setTimeout(() => text.inputEl.focus(), 50);
      });

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Add").setCta().onClick(() => this.submit())
      )
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => this.close())
      );
  }

  onClose() {
    this.contentEl.empty();
  }

  private async submit() {
    const comment = this.comment.trim();
    if (!comment) return;

    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const { historyKey, dateKey } = this.plugin.settings;

    await this.plugin.app.fileManager.processFrontMatter(this.file, (frontmatter) => {
      const history: StatusEntry[] = Array.isArray(frontmatter[historyKey])
        ? frontmatter[historyKey]
        : [];
      const lastEntry = history.length > 0 ? history[history.length - 1] : null;
      if (lastEntry && lastEntry[dateKey] === today) {
        history[history.length - 1] = this.plugin.normalizeEntry({ ...lastEntry, comment });
      } else {
        history.push(this.plugin.normalizeEntry({ [dateKey]: today, comment }));
      }
      frontmatter[historyKey] = history;
    });

    this.close();
  }
}

// ─── Settings Tab ────────────────────────────────────────────────────────────

class StatusHistorySettingTab extends PluginSettingTab {
  plugin: PropertyLogsPlugin;

  constructor(app: App, plugin: PropertyLogsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("status-history-settings");

    const tabs = [
      { id: "filters", label: "Filters" },
      { id: "behavior", label: "Behavior" },
      { id: "daily", label: "Daily Note Log" },
      { id: "dashboards", label: "Dashboards" },
      { id: "chart", label: "Chart Defaults" },
    ];

    const navEl = containerEl.createDiv({ cls: "status-history-tabs-nav" });
    const contentEl = containerEl.createDiv({ cls: "status-history-tabs-content" });

    const showTab = (activeId: string) => {
      navEl.querySelectorAll(".status-history-tab-btn").forEach((btn) => {
        btn.toggleClass("is-active", btn.getAttribute("data-tab") === activeId);
      });
      contentEl.querySelectorAll(".status-history-tab-pane").forEach((pane) => {
        (pane as HTMLElement).toggle(pane.getAttribute("data-tab") === activeId);
      });
    };

    for (const tab of tabs) {
      const btn = navEl.createEl("button", { text: tab.label, cls: "status-history-tab-btn" });
      btn.setAttribute("data-tab", tab.id);
      btn.addEventListener("click", () => showTab(tab.id));
    }

    // --- Filters tab ---
    const filtersPane = contentEl.createDiv({ cls: "status-history-tab-pane" });
    filtersPane.setAttribute("data-tab", "filters");

    this.renderListSection(
      filtersPane,
      "Included Folders",
      "Log status changes only for files in these folders. Leave empty to include all files (unless excluded).",
      "e.g. Projects/Active",
      () => this.plugin.settings.includedFolders,
      async (val) => {
        this.plugin.settings.includedFolders.push(val);
        await this.plugin.save();
      },
      async (val) => {
        this.plugin.settings.includedFolders = this.plugin.settings.includedFolders.filter((f) => f !== val);
        await this.plugin.save();
      }
    );

    this.renderListSection(
      filtersPane,
      "Included Tags",
      "Log status changes only for files with these tags. Leave empty to include all files (unless excluded).",
      "e.g. tracked",
      () => this.plugin.settings.includedTags,
      async (val) => {
        this.plugin.settings.includedTags.push(val);
        await this.plugin.save();
      },
      async (val) => {
        this.plugin.settings.includedTags = this.plugin.settings.includedTags.filter((t) => t !== val);
        await this.plugin.save();
      }
    );

    this.renderListSection(
      filtersPane,
      "Excluded Folders",
      "Never log status changes for files in these folders. Exclusions take priority over inclusions.",
      "e.g. Archive",
      () => this.plugin.settings.excludedFolders,
      async (val) => {
        this.plugin.settings.excludedFolders.push(val);
        await this.plugin.save();
      },
      async (val) => {
        this.plugin.settings.excludedFolders = this.plugin.settings.excludedFolders.filter((f) => f !== val);
        await this.plugin.save();
      }
    );

    this.renderListSection(
      filtersPane,
      "Excluded Tags",
      "Never log status changes for files with these tags. Exclusions take priority over inclusions.",
      "e.g. no-log",
      () => this.plugin.settings.excludedTags,
      async (val) => {
        this.plugin.settings.excludedTags.push(val);
        await this.plugin.save();
      },
      async (val) => {
        this.plugin.settings.excludedTags = this.plugin.settings.excludedTags.filter((t) => t !== val);
        await this.plugin.save();
      }
    );

    // --- Behavior tab ---
    const behaviorPane = contentEl.createDiv({ cls: "status-history-tab-pane" });
    behaviorPane.setAttribute("data-tab", "behavior");

    new Setting(behaviorPane)
      .setName("Overwrite same-day entries")
      .setDesc("When enabled, only the latest status change per day is kept instead of logging every change.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.overwriteSameDay).onChange(async (value) => {
          this.plugin.settings.overwriteSameDay = value;
          await this.plugin.save();
        })
      );

    new Setting(behaviorPane)
      .setName("Skip duplicate status")
      .setDesc("When enabled, a status change is not logged if it is the same as the most recent entry in the history.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.skipDuplicateStatus).onChange(async (value) => {
          this.plugin.settings.skipDuplicateStatus = value;
          await this.plugin.save();
        })
      );

    behaviorPane.createEl("h3", { text: "Property Keys" });
    behaviorPane.createEl("p", {
      text: "Customize the frontmatter keys used when writing history entries.",
      cls: "setting-item-description",
    });

    new Setting(behaviorPane)
      .setName("History key")
      .setDesc("The frontmatter key for the history array (default: status_history).")
      .addText((text) =>
        text
          .setPlaceholder("status_history")
          .setValue(this.plugin.settings.historyKey)
          .onChange(async (val) => {
            this.plugin.settings.historyKey = val || "status_history";
            await this.plugin.save();
          })
      );

    new Setting(behaviorPane)
      .setName("Date key")
      .setDesc("The key used for the date within each history entry (default: dateSet).")
      .addText((text) =>
        text
          .setPlaceholder("dateSet")
          .setValue(this.plugin.settings.dateKey)
          .onChange(async (val) => {
            this.plugin.settings.dateKey = val || "dateSet";
            await this.plugin.save();
          })
      );

    new Setting(behaviorPane)
      .setName("Status key")
      .setDesc("The key used for the status value within each history entry (default: statusSet).")
      .addText((text) =>
        text
          .setPlaceholder("statusSet")
          .setValue(this.plugin.settings.statusKey)
          .onChange(async (val) => {
            this.plugin.settings.statusKey = val || "statusSet";
            await this.plugin.save();
          })
      );

    behaviorPane.createEl("h3", { text: "Additional Tracked Properties" });
    behaviorPane.createEl("p", {
      text: "Track changes to other frontmatter properties. Only changed properties are logged in each history entry. 'Frontmatter key' is the property name in the note; 'History key' is the key written in the history entry.",
      cls: "setting-item-description",
    });

    const propListEl = behaviorPane.createDiv();
    const renderPropList = () => {
      propListEl.empty();
      const props = this.plugin.settings.additionalProperties;
      for (let i = 0; i < props.length; i++) {
        const item = props[i];
        new Setting(propListEl)
          .setName(`${item.frontmatterKey} → ${item.historyKey}`)
          .addButton((btn) =>
            btn
              .setIcon("arrow-up")
              .setTooltip("Move up")
              .setDisabled(i === 0)
              .onClick(async () => {
                [props[i - 1], props[i]] = [props[i], props[i - 1]];
                await this.plugin.save();
                renderPropList();
              })
          )
          .addButton((btn) =>
            btn
              .setIcon("arrow-down")
              .setTooltip("Move down")
              .setDisabled(i === props.length - 1)
              .onClick(async () => {
                [props[i], props[i + 1]] = [props[i + 1], props[i]];
                await this.plugin.save();
                renderPropList();
              })
          )
          .addButton((btn) =>
            btn
              .setIcon("trash")
              .setTooltip("Remove")
              .onClick(async () => {
                this.plugin.settings.additionalProperties = props.filter(
                  (p) => p.frontmatterKey !== item.frontmatterKey || p.historyKey !== item.historyKey
                );
                await this.plugin.save();
                renderPropList();
              })
          );
      }
    };
    renderPropList();

    let fmKeyInput: TextComponent;
    let histKeyInput: TextComponent;
    const addProp = async () => {
      const fmKey = fmKeyInput.getValue().trim();
      const histKey = histKeyInput.getValue().trim();
      if (!fmKey || !histKey) return;
      if (this.plugin.settings.additionalProperties.some((p) => p.frontmatterKey === fmKey)) return;
      this.plugin.settings.additionalProperties.push({ frontmatterKey: fmKey, historyKey: histKey });
      await this.plugin.save();
      await this.plugin.loadAllStatuses();
      fmKeyInput.setValue("");
      histKeyInput.setValue("");
      renderPropList();
    };

    new Setting(behaviorPane)
      .addText((text) => {
        fmKeyInput = text;
        text.setPlaceholder("Frontmatter key (e.g. deadline)");
        text.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") addProp(); });
      })
      .addText((text) => {
        histKeyInput = text;
        text.setPlaceholder("History key (e.g. deadlineSet)");
        text.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") addProp(); });
      })
      .addButton((btn) => btn.setButtonText("Add").onClick(addProp));

    // --- Daily Note Log tab ---
    const dailyPane = contentEl.createDiv({ cls: "status-history-tab-pane" });
    dailyPane.setAttribute("data-tab", "daily");
    this.renderDailyNoteLogPane(dailyPane);

    // --- Dashboards tab ---
    const dashboardsPane = contentEl.createDiv({ cls: "status-history-tab-pane" });
    dashboardsPane.setAttribute("data-tab", "dashboards");
    renderDashboardSettingsPane(dashboardsPane, this.plugin);

    // --- Chart Defaults tab ---
    const chartPane = contentEl.createDiv({ cls: "status-history-tab-pane" });
    chartPane.setAttribute("data-tab", "chart");

    chartPane.createEl("p", {
      text: "Default values pre-filled when using the 'Insert status chart' command. Updated automatically when you insert a chart.",
      cls: "setting-item-description",
    });

    new Setting(chartPane)
      .setName("Default folder")
      .setDesc("Folder path to filter pages by (e.g. Management).")
      .addText((text) =>
        text
          .setPlaceholder("e.g. Management")
          .setValue(this.plugin.settings.chartDefaults.folder)
          .onChange(async (val) => {
            this.plugin.settings.chartDefaults.folder = val;
            await this.plugin.save();
          })
      );

    new Setting(chartPane)
      .setName("Default tags")
      .setDesc("Tags to filter pages by, comma-separated without # (e.g. area, project).")
      .addText((text) =>
        text
          .setPlaceholder("e.g. area, project")
          .setValue(this.plugin.settings.chartDefaults.tags)
          .onChange(async (val) => {
            this.plugin.settings.chartDefaults.tags = val;
            await this.plugin.save();
          })
      );

    new Setting(chartPane)
      .setName("Default period")
      .setDesc("The time interval for each data point.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("week", "Week")
          .addOption("month", "Month")
          .addOption("quarter", "Quarter")
          .addOption("year", "Year")
          .setValue(this.plugin.settings.chartDefaults.periodType)
          .onChange(async (val) => {
            this.plugin.settings.chartDefaults.periodType = val as PeriodType;
            await this.plugin.save();
          })
      );

    new Setting(chartPane)
      .setName("Default start date")
      .setDesc("Start of the date range (YYYY-MM-DD).")
      .addText((text) =>
        text
          .setPlaceholder(`${currentYear}-01-01`)
          .setValue(this.plugin.settings.chartDefaults.startDate)
          .onChange(async (val) => {
            this.plugin.settings.chartDefaults.startDate = val;
            await this.plugin.save();
          })
      );

    new Setting(chartPane)
      .setName("Default end date")
      .setDesc("End of the date range (YYYY-MM-DD).")
      .addText((text) =>
        text
          .setPlaceholder(`${currentYear}-12-31`)
          .setValue(this.plugin.settings.chartDefaults.endDate)
          .onChange(async (val) => {
            this.plugin.settings.chartDefaults.endDate = val;
            await this.plugin.save();
          })
      );

    // Show first tab by default
    showTab("filters");
  }

  private renderDailyNoteLogPane(pane: HTMLElement) {
    const settings = this.plugin.settings.dailyNoteLog;

    new Setting(pane)
      .setName("Enable daily note logging")
      .setDesc("Append a log entry to the daily note whenever a tracked property changes on a watched file.")
      .addToggle((toggle) =>
        toggle.setValue(settings.enabled).onChange(async (value) => {
          this.plugin.settings.dailyNoteLog.enabled = value;
          await this.plugin.save();
        })
      );

    pane.createEl("h3", { text: "Daily Note Location" });
    pane.createEl("p", {
      text: "If the core Daily Notes plugin is enabled, its folder and date format are used. Otherwise the values below are used as a fallback.",
      cls: "setting-item-description",
    });

    new Setting(pane)
      .setName("Folder (fallback)")
      .setDesc("Folder where daily notes are stored. Leave empty for the vault root.")
      .addText((text) =>
        text
          .setPlaceholder("e.g. Daily")
          .setValue(settings.folder)
          .onChange(async (val) => {
            this.plugin.settings.dailyNoteLog.folder = val;
            await this.plugin.save();
          })
      );

    new Setting(pane)
      .setName("Date format (fallback)")
      .setDesc("Moment.js format used for the daily note filename (e.g. YYYY-MM-DD).")
      .addText((text) =>
        text
          .setPlaceholder("YYYY-MM-DD")
          .setValue(settings.dateFormat)
          .onChange(async (val) => {
            this.plugin.settings.dailyNoteLog.dateFormat = val;
            await this.plugin.save();
          })
      );

    new Setting(pane)
      .setName("Heading (optional)")
      .setDesc("If set, log entries are inserted under this heading (e.g. '## Status Changes'). The heading is created if missing. Leave empty to append to the end of the daily note.")
      .addText((text) =>
        text
          .setPlaceholder("e.g. ## Status Changes")
          .setValue(settings.heading)
          .onChange(async (val) => {
            this.plugin.settings.dailyNoteLog.heading = val;
            await this.plugin.save();
          })
      );

    pane.createEl("h3", { text: "Log Groups" });
    pane.createEl("p", {
      text: "Define a log template per tag. When a tracked property changes on a note, the first group whose tag is on the note is used. If no group matches, nothing is logged.",
      cls: "setting-item-description",
    });
    pane.createEl("p", {
      text: "Template placeholders: {{link}}, {{name}}, {{path}}, {{key}}, {{from}}, {{to}}, {{date}}, {{time}}",
      cls: "setting-item-description",
    });

    const groupsEl = pane.createDiv({ cls: "status-history-group-list" });
    const renderGroups = () => {
      groupsEl.empty();
      const groups = this.plugin.settings.dailyNoteLog.groups;
      groups.forEach((group, i) => {
        const card = groupsEl.createDiv({ cls: "status-history-group-card" });

        new Setting(card)
          .setName(`Group ${i + 1}${group.tag ? `: #${group.tag}` : ""}`)
          .addButton((btn) =>
            btn
              .setIcon("arrow-up")
              .setTooltip("Move up")
              .setDisabled(i === 0)
              .onClick(async () => {
                [groups[i - 1], groups[i]] = [groups[i], groups[i - 1]];
                await this.plugin.save();
                renderGroups();
              })
          )
          .addButton((btn) =>
            btn
              .setIcon("arrow-down")
              .setTooltip("Move down")
              .setDisabled(i === groups.length - 1)
              .onClick(async () => {
                [groups[i], groups[i + 1]] = [groups[i + 1], groups[i]];
                await this.plugin.save();
                renderGroups();
              })
          )
          .addButton((btn) =>
            btn
              .setIcon("trash")
              .setTooltip("Remove group")
              .onClick(async () => {
                groups.splice(i, 1);
                await this.plugin.save();
                renderGroups();
              })
          );

        new Setting(card)
          .setName("Tag")
          .setDesc("Notes carrying this tag use this group's template (without '#').")
          .addText((text) =>
            text
              .setPlaceholder("e.g. project")
              .setValue(group.tag)
              .onChange(async (val) => {
                group.tag = val.trim().replace(/^#/, "");
                await this.plugin.save();
              })
          );

        new Setting(card)
          .setName("Watched property keys")
          .setDesc("Comma-separated frontmatter keys this group logs (e.g. status, deadline). Leave empty to log every tracked change.")
          .addText((text) =>
            text
              .setPlaceholder("status, deadline")
              .setValue(group.watchedKeys.join(", "))
              .onChange(async (val) => {
                group.watchedKeys = val.split(",").map((k) => k.trim()).filter((k) => k);
                await this.plugin.save();
              })
          );

        new Setting(card)
          .setName("{{key}} uses")
          .setDesc("Which name to substitute for the {{key}} placeholder.")
          .addDropdown((dropdown) =>
            dropdown
              .addOption("frontmatter", "Frontmatter key (e.g. status)")
              .addOption("history", "History key (e.g. statusSet)")
              .setValue(group.keyForm)
              .onChange(async (val) => {
                group.keyForm = val as KeyForm;
                await this.plugin.save();
              })
          );

        const templateSetting = new Setting(card)
          .setName("Template")
          .setDesc("Line written to the daily note. Multiple lines are supported.");
        templateSetting.addTextArea((text: TextAreaComponent) => {
          text
            .setPlaceholder("- {{link}}: {{key}} changed from {{from}} to {{to}}")
            .setValue(group.template)
            .onChange(async (val) => {
              group.template = val;
              await this.plugin.save();
            });
          text.inputEl.rows = 3;
          text.inputEl.style.width = "100%";
        });
        templateSetting.settingEl.style.display = "block";
      });
    };
    renderGroups();

    new Setting(pane)
      .addButton((btn) =>
        btn
          .setButtonText("Add group")
          .setCta()
          .onClick(async () => {
            this.plugin.settings.dailyNoteLog.groups.push({
              tag: "",
              template: "- {{link}}: {{key}} changed from {{from}} to {{to}}",
              watchedKeys: [],
              keyForm: "frontmatter",
            });
            await this.plugin.save();
            renderGroups();
          })
      );
  }

  private renderListSection(
    containerEl: HTMLElement,
    heading: string,
    description: string,
    placeholder: string,
    getItems: () => string[],
    onAdd: (val: string) => Promise<void>,
    onRemove: (val: string) => Promise<void>
  ) {
    containerEl.createEl("h3", { text: heading });
    containerEl.createEl("p", { text: description, cls: "setting-item-description" });

    const listEl = containerEl.createDiv();
    const renderList = () => {
      listEl.empty();
      for (const item of getItems()) {
        new Setting(listEl).setName(item).addButton((btn) =>
          btn
            .setIcon("trash")
            .setTooltip("Remove")
            .onClick(async () => {
              await onRemove(item);
              renderList();
            })
        );
      }
    };
    renderList();

    let input: TextComponent;
    const addItem = async () => {
      const vals = input.getValue().split(",").map((v) => v.trim()).filter((v) => v && !getItems().includes(v));
      if (vals.length === 0) return;
      for (const val of vals) await onAdd(val);
      input.setValue("");
      renderList();
    };

    new Setting(containerEl)
      .addText((text) => {
        input = text;
        text.setPlaceholder(placeholder);
        text.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") addItem();
        });
      })
      .addButton((btn) => btn.setButtonText("Add").onClick(addItem));
  }
}
