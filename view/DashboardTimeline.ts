import { App, Menu, Platform, TFile, setIcon } from "obsidian";
import {
  DataSet,
  Timeline,
  TimelineAnimationOptions,
  TimelineEventPropertiesResult,
  TimelineGroup,
  TimelineItem,
  TimelineOptions,
} from "vis-timeline/standalone";

import {
  DashboardSettings,
  displayPropertyValue,
} from "../data/dashboard";
import { DashboardDataCache } from "../data/dashboardCache";
import { timelineColorStyle } from "../data/colorPalette";
import {
  HistoryParserResult,
  TimelineLevel,
  TimelineSegment,
  reconstructHistorySegments,
} from "../data/historyParser";
import { collectCompatibleHistory } from "../data/historyCompatibility";
import {
  JournalMarkerStyle,
  markerStyle,
  plainNoteText,
} from "../data/journalMarkers";
import { journalNoteCanOverflow } from "../data/journalPresentation";
import {
  PeriodGranularity,
  PeriodRange,
  DEFAULT_PERIOD_WINDOW_DAYS,
  periodTitle,
  windowForPeriod,
} from "../data/periodic";
import { GlobalValueStyles, globalLevelMapping, resolveValueColors } from "../data/valueStyles";
import { JournalNote, JournalNoteIndex } from "../integrations/journalNotes";
import { PeriodicNotes } from "../integrations/periodicNotes";
import { AddTopicModal, TopicHost } from "../modals/AddTopicModal";
import { openValuePicker } from "../modals/SetValueModal";
import { PeriodAxis } from "./PeriodAxis";
import { applyTooltip } from "./tooltips";

export interface DashboardHost extends TopicHost {
  getDashboards(): DashboardSettings[];
  getDashboard(id: string): DashboardSettings | undefined;
  openDashboard(id: string): Promise<void>;
  duplicateDashboard(id: string): Promise<DashboardSettings | null>;
  resolveHistoryKey(frontmatterKey: string): string;
  getDashboardHistoryKey(): string;
  getDashboardDateKey(): string;
  getDashboardStartDateProperty(): string;
  getGlobalValueStyles(): GlobalValueStyles;
  getJournalMarkers(): JournalMarkerStyle[];
  getPeriodicNotes(): PeriodicNotes;
  getJournalNoteIndex(): JournalNoteIndex;
  getDataCache(): DashboardDataCache;
  getWeekStartsOn(): number;
  getPeriodWindowDays(): Record<PeriodGranularity, number>;
  save(): Promise<void>;
}

export interface DashboardFocus {
  granularity: PeriodGranularity;
  range: PeriodRange;
  label?: string;
}

export interface DashboardTimelineOptions {
  /** Renders the full toolbar; embeds use a slim header instead. */
  showToolbar?: boolean;
  /** Compact rows, slim header, and page-friendly scrolling for embeds. */
  compact?: boolean;
  /** Shrinks rows, text, and spacing further, for a low-profile embed. Implies compact. */
  minimal?: boolean;
  /** Maximum pixel height, used by embeds so a long dashboard stays scrollable. */
  maxHeight?: number | null;
  /** Overrides the calendar span shown around the focused period. */
  windowDays?: number | null;
  /** In an embed, false lets the timeline grow naturally instead of adding an inner scroller. */
  scroll?: boolean | null;
  /** Per-embed presentation choices. These intentionally do not persist. */
  dashboardOverrides?: Partial<Pick<DashboardSettings, "groupBy" | "sortBy" | "sortAscending">>;
  onOpenFullDashboard?: (dashboardId: string) => void;
}

interface TimelineRow {
  file: TFile;
  frontmatter: Record<string, unknown>;
  fileTags: string[];
  history: unknown;
  parsed: HistoryParserResult;
  level: TimelineLevel;
  recentChange: number;
}

/**
 * One row or block, described before any of it is built.
 *
 * `contentKey` is everything the element is drawn from, so a redraw can tell
 * the blocks that actually changed from the ones that only got recomputed:
 * unchanged blocks keep the DOM they already have, which is what makes an
 * edit somewhere in the vault cost a few elements rather than all of them.
 */
interface TimelineItemProperties extends Omit<TimelineItem, "content"> {
  /** Supported by vis-timeline at runtime, but absent from its bundled type. */
  subgroupOrder?: number;
}

interface PlanItem {
  id: string;
  props: TimelineItemProperties;
  contentKey: string;
  createContent: () => HTMLElement;
}

interface PlanGroup {
  id: string;
  props: Omit<TimelineGroup, "content">;
  contentKey: string;
  createContent: () => HTMLElement;
}

/**
 * One day of a folded row: how many notes sit there, and which. The set is
 * what stops a note that spans the day from being counted once per segment.
 */
/** Everything one drawn dashboard consists of, as plain data. */
interface TimelineModel {
  items: PlanItem[];
  groups: PlanGroup[];
  itemRows: Map<string, TimelineRow>;
  journalNotes: Map<string, JournalNote>;
  /** note path → the group that note occupies, for attaching linked journal notes. */
  noteGroupIds: Map<string, string>;
  groupLabelText: Map<string, string>;
}

/** What was last handed to vis-timeline for one id. */
interface AppliedEntry {
  contentKey: string;
  propsKey: string;
}

function planSignature(props: Record<string, unknown>): string {
  return JSON.stringify(props);
}

/**
 * The parent/child links between groups. vis-timeline resolves nesting once,
 * when groups are added, and keeps a pointer on each child back to its parent,
 * so a note moving between buckets is the one change an update in place cannot
 * express: that one is rebuilt.
 */
function nestedGroupSignature(groups: PlanGroup[]): string {
  return groups
    .filter((group) => group.props.nestedGroups !== undefined)
    .map((group) => `${group.id}:${(group.props.nestedGroups ?? []).join(",")}`)
    .join("|");
}

/** Everything a drawn journal note carries, for spotting a collect that changed nothing. */
function journalSignature(notes: JournalNote[]): string {
  return notes.map((note) => `${note.id}\u0000${note.marker}\u0000${note.text}`).join("\u0001");
}

const DAY_MS = 1000 * 60 * 60 * 24;
const MIN_TIMELINE_ZOOM_MS = DAY_MS * 7;
const MAX_TIMELINE_ZOOM_MS = DAY_MS * 365 * 20;

interface TimelinePinchEvent {
  type?: string;
  scale?: number;
  center?: { x: number; y: number };
  srcEvent?: Event;
  preventDefault?: () => void;
}

interface TimelineGestureEvents {
  on(event: "touch" | "pinch" | "release", callback: (event?: TimelinePinchEvent) => void): void;
}

function localDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function latestTrackedDate(history: unknown, historyKey: string, dateKey: string): number {
  if (!Array.isArray(history)) return 0;
  let latest = 0;
  for (const entry of history) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, historyKey)) continue;
    if (typeof record[dateKey] !== "string") continue;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(record[dateKey]);
    if (!match) continue;
    const timestamp = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
    if (Number.isFinite(timestamp)) latest = Math.max(latest, timestamp);
  }
  return latest;
}

function latestHistoryValue(history: unknown, key: string, dateKey: string): unknown {
  if (!Array.isArray(history)) return undefined;
  let latestValue: unknown;
  let latestDate = Number.NEGATIVE_INFINITY;
  history.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const record = entry as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, key)) return;
    const rawDate = record[dateKey];
    const timestamp = typeof rawDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
      ? new Date(`${rawDate}T00:00:00`).getTime()
      : index;
    if (timestamp >= latestDate) {
      latestDate = timestamp;
      latestValue = record[key];
    }
  });
  return latestValue;
}

function compareText(first: string, second: string): number {
  return first.localeCompare(second, undefined, { numeric: true, sensitivity: "base" });
}

function propertyKeyFromMode(mode: string): string | null {
  return mode.startsWith("property:") ? mode.slice("property:".length) : null;
}

function rowSortValue(row: TimelineRow, dashboard: DashboardSettings): string | number {
  if (dashboard.sortBy === "level") return row.level;
  if (dashboard.sortBy === "recent") return row.recentChange;
  const propertyKey = propertyKeyFromMode(dashboard.sortBy);
  if (propertyKey) return displayPropertyValue(row.frontmatter[propertyKey]);
  return row.file.basename;
}

function compareRows(first: TimelineRow, second: TimelineRow, dashboard: DashboardSettings): number {
  const firstValue = rowSortValue(first, dashboard);
  const secondValue = rowSortValue(second, dashboard);
  const comparison = typeof firstValue === "number" && typeof secondValue === "number"
    ? firstValue - secondValue
    : compareText(String(firstValue), String(secondValue));
  const direction = dashboard.sortAscending ? 1 : -1;
  return comparison * direction || compareText(first.file.basename, second.file.basename);
}

function rowGroupValues(row: TimelineRow, dashboard: DashboardSettings): string[] {
  if (dashboard.groupBy === "folder") return [row.file.parent?.path || "Vault root"];
  if (dashboard.groupBy === "level") return [`Level ${row.level}`];
  if (dashboard.groupBy === "file.tags") return row.fileTags.length > 0 ? row.fileTags : ["No value"];
  const propertyKey = propertyKeyFromMode(dashboard.groupBy);
  if (propertyKey) {
    const value = row.frontmatter[propertyKey];
    const values = Array.isArray(value)
      ? value.flatMap((item) => {
          const display = displayPropertyValue(item);
          return display ? [display] : [];
        })
      : displayPropertyValue(value) ? [displayPropertyValue(value)] : [];
    return values.length > 0 ? values : ["No value"];
  }
  return [""];
}

function groupId(kind: string, value: string): string {
  return `${kind}:${encodeURIComponent(value)}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * Width, in days, given to the current status when it started today. A
 * same-day segment otherwise collapses to zero width; widening it lets it
 * read as an ongoing block spanning into the next few days rather than a
 * single, easy-to-miss sliver.
 */
const CURRENT_TODAY_OVERFLOW_DAYS = 3;

/** Pixels between a note's name and the line that follows it. */
const SEGMENT_LINE_GAP = 4;

function centerOf(range: PeriodRange): Date {
  return new Date((range.start.getTime() + range.end.getTime()) / 2);
}

/**
 * Whether a segment is the value a note still holds.
 *
 * Being the last one drawn is not enough. A value mapped to level 0 is hidden
 * rather than drawn, so a note whose latest change lands on one — `relevant`
 * going back to `false`, say — has no segment for where it stands now, and the
 * last segment on screen is one that ended. The parser records the level of
 * that latest change either way, which is what tells the two apart.
 */
function isOngoingSegment(row: TimelineRow, segmentIndex: number): boolean {
  return segmentIndex === row.parsed.segments.length - 1 && row.parsed.currentLevel !== 0;
}

/**
 * Renders one dashboard into any container: the timeline view, and the
 * `property-logs` code block embedded in a periodic note.
 */
export class DashboardTimeline {
  private timeline: Timeline | null = null;
  /** The collections vis-timeline draws from, updated in place between renders. */
  private itemsData: DataSet<TimelineItem> | null = null;
  private groupsData: DataSet<TimelineGroup> | null = null;
  /** What each id was last drawn as, so a redraw only touches what moved. */
  private appliedItems = new Map<string, AppliedEntry>();
  private appliedGroups = new Map<string, AppliedEntry>();
  private nestedSignature = "";
  private itemRows = new Map<string, TimelineRow>();
  private journalNotesById = new Map<string, JournalNote>();
  /** The journal notes on screen, redrawn straight away while the next read runs. */
  private journalNotes: JournalNote[] = [];
  private journalNotesKey: string | null = null;
  private axis: PeriodAxis | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private renderToken = 0;
  private refreshTimer: number | null = null;
  private journalDayTimer: number | null = null;
  private dashboardId = "";
  private focus: DashboardFocus | null = null;
  private openableGranularities = new Set<PeriodGranularity>(["day"]);
  private lastBlockActivation: { key: string; at: number } | null = null;
  private timelineEl: HTMLElement | null = null;
  private dividersEl: HTMLElement | null = null;
  /** Every fold button currently on screen, kept in step with one another. */
  private labelFoldButtons: HTMLButtonElement[] = [];
  /** Group id → the value shown for it, for drawing into rows when folded. */
  private groupLabelText = new Map<string, string>();
  /** What the last completed render was of, so a rebuild can tell it apart. */
  private renderedKey: string | null = null;
  /** The shape that render was built in; anything else needs a fresh build. */
  private renderedLayoutKey: string | null = null;
  /** The window that render was showing, to be handed back to its successor. */
  private preservedWindow: { key: string; start: Date; end: Date } | null = null;
  /** Width of each folded name at rest, measured once so redraws stay cheap. */
  private segmentLabelWidths = new WeakMap<HTMLElement, number>();

  constructor(
    private readonly app: App,
    private readonly host: DashboardHost,
    private readonly containerEl: HTMLElement,
    private options: DashboardTimelineOptions = {}
  ) {}

  setOptions(options: DashboardTimelineOptions): void {
    this.options = { ...this.options, ...options };
  }

  setDashboardId(id: string): void {
    this.dashboardId = id;
  }

  getDashboardId(): string {
    return this.dashboardId;
  }

  setFocus(focus: DashboardFocus | null): void {
    this.focus = focus;
  }

  refresh(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.render();
    }, 100);
  }

  destroy(): void {
    this.renderToken++;
    this.renderedKey = null;
    this.preservedWindow = null;
    this.journalNotes = [];
    this.journalNotesKey = null;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    if (this.journalDayTimer !== null) window.clearTimeout(this.journalDayTimer);
    this.journalDayTimer = null;
    this.destroyTimeline();
    this.containerEl.empty();
  }

  private destroyTimeline(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.axis?.destroy();
    this.axis = null;
    this.timeline?.destroy();
    this.timeline = null;
    this.itemsData = null;
    this.groupsData = null;
    this.appliedItems.clear();
    this.appliedGroups.clear();
    this.nestedSignature = "";
    this.itemRows.clear();
    this.journalNotesById.clear();
    this.renderedLayoutKey = null;
    this.timelineEl = null;
    this.dividersEl = null;
  }

  async render(): Promise<void> {
    const token = ++this.renderToken;
    const savedDashboard = this.host.getDashboard(this.dashboardId) ?? this.host.getDashboards()[0];
    if (!savedDashboard) {
      this.scheduleJournalDayRefresh(false);
      this.destroyTimeline();
      this.containerEl.empty();
      this.containerEl.addClass("property-logs-dashboard");
      this.renderNoDashboard();
      return;
    }
    this.dashboardId = savedDashboard.id;
    const dashboard = this.resolveDashboard(savedDashboard);
    this.scheduleJournalDayRefresh(dashboard.showJournalNotes);
    // A rebuild throws every block away and lays the calendar out from scratch.
    // When the change is one the drawn timeline can absorb — an edited note, a
    // new status, another colour mode — the data is updated in place instead,
    // which is both far cheaper and leaves the view where the user left it.
    if (this.canUpdateInPlace(dashboard) && this.updateInPlace(token, dashboard)) return;
    await this.renderFull(token, dashboard);
  }

  /** Applies block-local presentation choices without ever mutating saved settings. */
  private resolveDashboard(dashboard: DashboardSettings): DashboardSettings {
    const overrides = this.options.dashboardOverrides;
    // The full dashboard must keep the persisted object itself: its toolbar
    // writes directly to that object before saving. Only embeds with a real
    // local override receive a presentation copy.
    if (!overrides || (overrides.groupBy === undefined
      && overrides.sortBy === undefined
      && overrides.sortAscending === undefined)) return dashboard;
    return {
      ...dashboard,
      ...(overrides.groupBy === undefined ? {} : { groupBy: overrides.groupBy }),
      ...(overrides.sortBy === undefined ? {} : { sortBy: overrides.sortBy }),
      ...(overrides.sortAscending === undefined ? {} : { sortAscending: overrides.sortAscending }),
    };
  }

  /** Tears the dashboard down and builds it again, skeleton and all. */
  private async renderFull(token: number, dashboard: DashboardSettings): Promise<void> {
    this.preserveWindow();
    this.destroyTimeline();
    this.containerEl.empty();
    this.labelFoldButtons = [];
    this.containerEl.addClass("property-logs-dashboard");
    this.containerEl.toggleClass("is-compact", this.options.compact === true);
    this.containerEl.toggleClass("is-minimal", this.options.minimal === true);
    this.containerEl.toggleClass("is-mobile-layout", Platform.isMobile);
    this.containerEl.toggleClass("is-labels-collapsed", dashboard.collapsedLabels);

    const header = this.containerEl.createDiv({ cls: "property-logs-toolbar" });
    const loading = this.containerEl.createDiv({ cls: "property-logs-loading" });
    for (let line = 0; line < 3; line++) loading.createDiv({ cls: "property-logs-loading-line" });
    loading.setAttribute("role", "status");
    loading.setAttribute("aria-label", "Loading timeline");

    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    if (token !== this.renderToken) return;

    // Scope evaluation walks the vault. Reuse that result for both the rows and
    // the toolbar property picker instead of walking every file twice.
    const files = this.host.getDashboardFiles(dashboard);
    const rows = this.buildRows(dashboard, files);
    const visible = this.restoredWindow() ?? this.resolveWindow();
    // Notes read for a different dashboard, or a different period, describe
    // nothing that is about to be drawn.
    if (this.journalNotesKey !== this.viewKey()) this.journalNotes = [];

    this.renderHeader(header, dashboard, files);
    loading.remove();

    if (rows.length === 0 && !dashboard.showJournalNotes) {
      this.journalNotes = [];
      this.renderEmptyState(dashboard);
      return;
    }

    try {
      const model = this.buildModel(rows, dashboard);
      // The notes from the last read go back up with the first draw, so a
      // rebuild does not blink them out while the vault is read again.
      this.addJournalItems(model, this.journalNotes, dashboard);
      this.mountTimeline(model, dashboard, visible);
      // Reading marked journal lines can involve disk reads. Do it after the
      // dashboard is interactive; the update below keeps its current window.
      void this.syncJournalNotes(token, dashboard, visible, rows.length > 0);
    } catch (error) {
      console.error("Property Logs could not render the timeline", error);
      this.renderTimelineError(error);
    }

    void this.refreshOpenableGranularities();
  }

  /**
   * Feeds new data to the timeline that is already on screen. Returns false
   * when the change is one only a rebuild can express, leaving nothing behind.
   */
  private updateInPlace(token: number, dashboard: DashboardSettings): boolean {
    const files = this.host.getDashboardFiles(dashboard);
    const rows = this.buildRows(dashboard, files);
    // An emptied dashboard shows guidance instead of a timeline, which is the
    // full path's job.
    if (rows.length === 0 && this.journalNotes.length === 0) return false;

    const model = this.buildModel(rows, dashboard);
    this.addJournalItems(model, this.journalNotes, dashboard);
    if (!this.applyModel(model)) return false;

    this.containerEl.toggleClass("is-labels-collapsed", dashboard.collapsedLabels);
    this.refreshHeader(dashboard, files);
    this.syncFloatingLabels();
    this.syncSegmentLines();
    this.updateAxis(true);
    void this.syncJournalNotes(token, dashboard, this.currentWindow(), rows.length > 0);
    return true;
  }

  /** The span on screen right now, which an update in place leaves alone. */
  private currentWindow(): PeriodRange {
    if (!this.timeline) return this.resolveWindow();
    const visible = this.timeline.getWindow();
    return { start: new Date(visible.start), end: new Date(visible.end) };
  }

  /** Whether the drawn timeline can take this dashboard's data as an update. */
  private canUpdateInPlace(dashboard: DashboardSettings): boolean {
    return this.timeline !== null
      && this.itemsData !== null
      && this.timelineEl !== null
      && this.containerEl.contains(this.timelineEl)
      && this.renderedKey === this.viewKey()
      && this.renderedLayoutKey === this.layoutKey(dashboard);
  }

  /**
   * The shape the timeline was built in. Grouping, folding and the calendar
   * axis decide how vis-timeline is wired together rather than what it holds,
   * so a change to any of them starts again.
   */
  private layoutKey(dashboard: DashboardSettings): string {
    return [
      dashboard.groupBy,
      String(dashboard.showPeriodAxis),
      String(dashboard.showJournalNotes),
      [...dashboard.foldedGroups].sort().join(","),
      String(this.options.compact === true),
      String(this.options.minimal === true),
      String(this.options.showToolbar === false),
      String(this.options.maxHeight ?? ""),
      String(this.options.scroll ?? "auto"),
    ].join("|");
  }

  private renderHeader(header: HTMLElement, dashboard: DashboardSettings, files: TFile[]): void {
    if (this.options.showToolbar === false) header.remove();
    else if (this.options.compact) this.renderCompactHeader(header, dashboard);
    else this.renderToolbar(header, dashboard, this.collectProperties(dashboard, files));
  }

  /** Redraws the toolbar over a timeline that is staying put. */
  private refreshHeader(dashboard: DashboardSettings, files: TFile[]): void {
    if (this.options.showToolbar === false) return;
    const header = this.containerEl.querySelector<HTMLElement>(
      ":scope > .property-logs-toolbar"
    );
    if (!header) return;
    this.labelFoldButtons = this.labelFoldButtons.filter((button) => !header.contains(button));
    header.empty();
    header.removeClass("property-logs-toolbar-compact");
    if (this.options.compact) this.renderCompactHeader(header, dashboard);
    else this.renderToolbar(header, dashboard, this.collectProperties(dashboard, files));
  }

  // ─── Data ──────────────────────────────────────────────────────────────────

  /**
   * Parses each in-scope note's history into the row a timeline draws.
   *
   * A note's row depends on nothing but that note and the settings behind it,
   * so it is kept until the note is written to or one of those settings moves
   * — the day included, since an ongoing status runs up to today. An edit
   * anywhere in the vault then reparses one note rather than all of them.
   */
  private buildRows(dashboard: DashboardSettings, files: TFile[]): TimelineRow[] {
    if (!dashboard.trackedPropertyKey.trim()) return [];
    const today = new Date();
    const trackedHistoryKey = this.host.resolveHistoryKey(dashboard.trackedPropertyKey);
    const dateKey = this.host.getDashboardDateKey();
    const historyKey = this.host.getDashboardHistoryKey();
    const globalStyles = this.host.getGlobalValueStyles();
    const globalLevels = globalLevelMapping(globalStyles);
    const valueColors = resolveValueColors(globalStyles, dashboard.valueColors);
    const startDateProperty = dashboard.startDateProperty || this.host.getDashboardStartDateProperty();
    const parseKey = JSON.stringify({
      trackedHistoryKey,
      dateKey,
      startDateProperty,
      historyKey,
      day: localDate(today),
      levelMapping: dashboard.levelMapping,
      globalLevels,
      defaultLevelForUnset: dashboard.defaultLevelForUnset,
      unmappedValueLevel: dashboard.unmappedValueLevel,
      colorMode: dashboard.colorMode,
      levelColors: dashboard.levelColors,
      colorProperty: dashboard.colorProperty,
      colorPropertyMap: dashboard.colorPropertyMap,
      valueColors,
    });
    const cache = this.host.getDataCache();

    return files.flatMap((file) => {
      const row = cache.forFile("row", file, parseKey, (): TimelineRow | null => {
        const cacheEntry = this.app.metadataCache.getFileCache(file);
        const frontmatter = cacheEntry?.frontmatter as
          | Record<string, unknown>
          | undefined;
        const metadata = frontmatter ?? {};
        const history = collectCompatibleHistory(metadata, historyKey, dateKey);
        const parsed = reconstructHistorySegments({
          history,
          trackedHistoryKey,
          dateKey,
          creationDate: file.stat.ctime,
          noHistoryStartDate: startDateProperty ? metadata[startDateProperty] : undefined,
          currentValue: metadata[dashboard.trackedPropertyKey],
          today,
          levelMapping: dashboard.levelMapping,
          globalLevelMapping: globalLevels,
          defaultLevelForUnset: dashboard.defaultLevelForUnset,
          unmappedValueLevel: dashboard.unmappedValueLevel,
          colorMode: dashboard.colorMode,
          levelColors: dashboard.levelColors,
          colorPropertyValue: metadata[dashboard.colorProperty],
          colorPropertyMap: dashboard.colorPropertyMap,
          valueColors,
        });
        if (parsed.segments.length === 0 && !parsed.malformed) return null;
        return {
          file,
          frontmatter: metadata,
          fileTags: (cacheEntry?.tags ?? []).map((tag) => tag.tag),
          history,
          parsed,
          level: parsed.currentLevel,
          recentChange: latestTrackedDate(history, trackedHistoryKey, dateKey),
        };
      });
      return row ? [row] : [];
    });
  }

  /** Every property the toolbar's pickers offer, from one walk of the scope. */
  private collectProperties(dashboard: DashboardSettings, files: TFile[]): string[] {
    const scopeKey = JSON.stringify(dashboard.scopeFilter);
    const inScope = this.host.getDataCache().scan(`properties:${scopeKey}`, () => {
      const keys = new Set<string>();
      files.forEach((file) => {
        const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
        if (frontmatter) Object.keys(frontmatter).forEach((key) => keys.add(key));
      });
      return Array.from(keys);
    });
    const properties = new Set<string>([
      dashboard.trackedPropertyKey,
      dashboard.colorProperty,
      ...dashboard.rowProperties,
    ].filter(Boolean));
    inScope.forEach((key) => properties.add(key));
    return Array.from(properties).sort(compareText);
  }

  private async collectJournalNotes(
    dashboard: DashboardSettings,
    visible: PeriodRange
  ): Promise<JournalNote[]> {
    if (!dashboard.showJournalNotes) return [];
    if (this.host.getJournalMarkers().length === 0) return [];
    const padding = (visible.end.getTime() - visible.start.getTime()) * 2;
    try {
      return await this.host.getJournalNoteIndex().collect({
        start: new Date(visible.start.getTime() - padding),
        end: new Date(visible.end.getTime() + padding),
      });
    } catch (error) {
      console.error("Property Logs could not read periodic notes", error);
      return [];
    }
  }

  /**
   * Reads the marked lines of the periodic notes around the visible window and
   * puts them on the timeline that is already drawn.
   *
   * The notes already on screen were drawn with the first pass, so this only
   * has work to do when the read comes back with something different.
   */
  private async syncJournalNotes(
    token: number,
    dashboard: DashboardSettings,
    visible: PeriodRange,
    hasTrackedItems: boolean
  ): Promise<void> {
    const notes = await this.collectJournalNotes(dashboard, visible);
    if (token !== this.renderToken || this.timeline === null) return;
    const unchanged = journalSignature(notes) === journalSignature(this.journalNotes);
    this.journalNotes = notes;
    this.journalNotesKey = this.viewKey();

    if (notes.length === 0 && !hasTrackedItems) {
      // A dashboard that has no tracked rows uses journal notes as its only
      // possible content. Replace the temporary empty timeline with the normal
      // guidance once that lookup completes.
      this.destroyTimeline();
      this.containerEl.querySelector(".property-logs-timeline-wrapper")?.remove();
      this.renderEmptyState(dashboard);
      return;
    }
    if (unchanged) return;

    const current = this.resolveDashboard(this.host.getDashboard(this.dashboardId) ?? dashboard);
    const files = this.host.getDashboardFiles(current);
    const model = this.buildModel(this.buildRows(current, files), current);
    this.addJournalItems(model, notes, current);
    if (!this.applyModel(model)) {
      // The notes landed on groups this timeline cannot rearrange. Build again.
      this.renderedLayoutKey = null;
      void this.render();
      return;
    }
    this.syncFloatingLabels();
    this.syncSegmentLines();
    this.updateAxis();
  }

  /** Identifies what is on screen: the same dashboard, focused on the same period. */
  private viewKey(): string {
    const focus = this.focus
      ? `${this.focus.granularity}:${this.focus.range.start.getTime()}`
      : "";
    return `${this.dashboardId}|${focus}`;
  }

  /**
   * Remembers where the user had panned and zoomed to. A rebuild triggered by
   * an edit elsewhere in the vault should leave the view exactly where they
   * left it rather than snapping back to the default span.
   */
  private preserveWindow(): void {
    if (!this.timeline || this.renderedKey === null) return;
    const visible = this.timeline.getWindow();
    const start = new Date(visible.start);
    const end = new Date(visible.end);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return;
    if (end.getTime() <= start.getTime()) return;
    this.preservedWindow = { key: this.renderedKey, start, end };
  }

  /** That window again, but only for a rebuild of the very same view. */
  private restoredWindow(): PeriodRange | null {
    const preserved = this.preservedWindow;
    if (!preserved || preserved.key !== this.viewKey()) return null;
    return { start: preserved.start, end: preserved.end };
  }

  private resolveWindow(): PeriodRange {
    if (this.focus) {
      const days = this.options.windowDays
        ?? this.host.getPeriodWindowDays()[this.focus.granularity]
        ?? DEFAULT_PERIOD_WINDOW_DAYS[this.focus.granularity];
      return windowForPeriod(this.focus.range, days);
    }
    const days = this.options.windowDays ?? 90;
    const now = Date.now();
    return {
      start: new Date(now - (days * DAY_MS) / 2),
      end: new Date(now + (days * DAY_MS) / 2),
    };
  }

  private async refreshOpenableGranularities(): Promise<void> {
    const granularities = await this.host.getPeriodicNotes().availableGranularities();
    this.openableGranularities = granularities;
    this.axis?.setOptions({ openable: granularities });
    this.updateAxis();
  }

  // ─── Header ────────────────────────────────────────────────────────────────

  private renderCompactHeader(header: HTMLElement, dashboard: DashboardSettings): void {
    header.addClass("property-logs-toolbar-compact");
    const title = header.createEl("button", {
      cls: "property-logs-toolbar-title-button",
      text: dashboard.name,
      attr: { type: "button" },
    });
    applyTooltip(title, `Open ${dashboard.name}`);
    title.addEventListener("click", () => {
      if (this.options.onOpenFullDashboard) this.options.onOpenFullDashboard(dashboard.id);
      else void this.host.openDashboard(dashboard.id);
    });

    if (this.focus) {
      header.createSpan({
        cls: "property-logs-toolbar-period",
        text: this.focus.label ?? periodTitle(this.focus.granularity, this.focus.range.start),
      });
    }

    const controls = header.createDiv({ cls: "property-logs-timeline-controls" });
    this.createLabelFoldButton(controls, dashboard);
    this.createIconButton(controls, "zoom-out", "Zoom out", () => {
      this.timeline?.zoomOut(0.35, this.timelineAnimation());
    });
    this.createIconButton(
      controls,
      this.focus ? "crosshair" : "calendar-days",
      this.focus ? "Recenter on this note" : "Center today",
      () => this.centerOnFocus()
    );
    this.createIconButton(controls, "zoom-in", "Zoom in", () => {
      this.timeline?.zoomIn(0.35, this.timelineAnimation());
    });
  }

  private renderToolbar(
    toolbar: HTMLElement,
    dashboard: DashboardSettings,
    properties: string[]
  ): void {
    const dashboards = this.host.getDashboards();
    if (dashboards.length > 1) {
      const selector = toolbar.createEl("select", { cls: "dropdown property-logs-toolbar-select" });
      selector.setAttribute("aria-label", "Dashboard");
      dashboards.forEach((item) => selector.createEl("option", { text: item.name, value: item.id }));
      selector.value = dashboard.id;
      selector.addEventListener("change", () => {
        void this.host.openDashboard(selector.value);
      });
    } else {
      toolbar.createDiv({ text: dashboard.name, cls: "property-logs-toolbar-title" });
    }

    this.createModeSelect(toolbar, "Group by", dashboard.groupBy, [
      ["status", "Status"],
      ["none", "No grouping"],
      ["folder", "Folder"],
      ["level", "Current level"],
      ["file.tags", "File tags"],
      ...properties.map((property): [string, string] => [`property:${property}`, property]),
    ], async (value) => {
      dashboard.groupBy = value as DashboardSettings["groupBy"];
      dashboard.foldedGroups = [];
      await this.host.save();
      this.refresh();
    });

    this.createModeSelect(toolbar, "Sort by", dashboard.sortBy, [
      ["alphabetical", "Alphabetical"],
      ["level", "Current level"],
      ["recent", "Recently changed"],
      ...properties.map((property): [string, string] => [`property:${property}`, property]),
    ], async (value) => {
      dashboard.sortBy = value as DashboardSettings["sortBy"];
      await this.host.save();
      this.refresh();
    });

    const direction = toolbar.createEl("button", {
      cls: "clickable-icon property-logs-direction-button",
      attr: { type: "button" },
    });
    applyTooltip(direction, dashboard.sortAscending ? "Sort descending" : "Sort ascending");
    setIcon(direction, dashboard.sortAscending ? "arrow-up-narrow-wide" : "arrow-down-wide-narrow");
    direction.addEventListener("click", async () => {
      dashboard.sortAscending = !dashboard.sortAscending;
      await this.host.save();
      this.refresh();
    });

    this.createModeSelect(toolbar, "Color by", dashboard.colorMode, [
      ["level", "Level"],
      ["property", "Property"],
      ["value", "Tracked value"],
    ], async (value) => {
      dashboard.colorMode = value === "property" || value === "value" ? value : "level";
      await this.host.save();
      this.refresh();
    });

    const controls = toolbar.createDiv({ cls: "property-logs-timeline-controls" });
    this.createLabelFoldButton(controls, dashboard);
    this.createIconButton(controls, "zoom-out", "Zoom out", () => {
      this.timeline?.zoomOut(0.35, this.timelineAnimation());
    });
    const today = controls.createEl("button", {
      cls: "property-logs-today-button",
      attr: { type: "button" },
    });
    applyTooltip(today, "Center today");
    setIcon(today, "calendar-days");
    today.createSpan({ text: "Today" });
    today.addEventListener("click", () => this.centerOnFocus());
    this.createIconButton(controls, "zoom-in", "Zoom in", () => {
      this.timeline?.zoomIn(0.35, this.timelineAnimation());
    });

    const add = toolbar.createEl("button", {
      text: "Add note",
      cls: "mod-cta property-logs-add-topic",
      attr: { type: "button" },
    });
    add.addEventListener("click", () => new AddTopicModal(this.app, this.host, dashboard).open());

    this.createIconButton(toolbar, "more-horizontal", "More options", (event) => {
      this.showOverflowMenu(event, dashboard);
    });
  }

  private showOverflowMenu(event: MouseEvent, dashboard: DashboardSettings): void {
    const menu = new Menu();
    menu.addItem((item) => item
      .setTitle(dashboard.foldedGroups.length > 0 ? "Unfold all rows" : "Fold all rows")
      .setIcon(dashboard.foldedGroups.length > 0 ? "unfold-vertical" : "fold-vertical")
      .onClick(async () => {
        dashboard.foldedGroups = dashboard.foldedGroups.length > 0 ? [] : this.allFoldableGroupIds();
        await this.host.save();
        this.refresh();
      }));
    menu.addItem((item) => item
      .setTitle(dashboard.showJournalNotes ? "Hide periodic-note notes" : "Show periodic-note notes")
      .setIcon("sticky-note")
      .onClick(async () => {
        dashboard.showJournalNotes = !dashboard.showJournalNotes;
        await this.host.save();
        this.refresh();
      }));
    menu.addItem((item) => item
      .setTitle(dashboard.showPeriodAxis ? "Hide calendar axis" : "Show calendar axis")
      .setIcon("calendar-range")
      .onClick(async () => {
        dashboard.showPeriodAxis = !dashboard.showPeriodAxis;
        await this.host.save();
        this.refresh();
      }));
    menu.addItem((item) => item
      .setTitle("Duplicate dashboard")
      .setIcon("copy")
      .onClick(async () => {
        const copy = await this.host.duplicateDashboard(dashboard.id);
        if (copy) await this.host.openDashboard(copy.id);
      }));
    menu.showAtMouseEvent(event);
  }

  private allFoldableGroupIds(): string[] {
    if (!this.timeline) return [];
    const ids: string[] = [];
    this.containerEl.querySelectorAll<HTMLElement>("[data-foldable-group]").forEach((element) => {
      const id = element.dataset.foldableGroup;
      if (id) ids.push(id);
    });
    return ids;
  }

  /** Folds the left label column away, giving the calendar the full width. */
  private createLabelFoldButton(
    parent: HTMLElement,
    dashboard: DashboardSettings,
    cls?: string
  ): void {
    const button = this.createIconButton(parent, "panel-left-close", "Fold labels", () => {
      const current = this.host.getDashboard(this.dashboardId) ?? dashboard;
      current.collapsedLabels = !current.collapsedLabels;
      this.applyLabelColumn(current);
      void this.host.save();
    });
    if (cls) button.addClass(cls);
    this.labelFoldButtons.push(button);
    this.syncLabelColumn(dashboard);
  }

  /** Mirrors the folded state onto the container and every fold button on screen. */
  private syncLabelColumn(dashboard: DashboardSettings): void {
    const collapsed = dashboard.collapsedLabels;
    this.containerEl.toggleClass("is-labels-collapsed", collapsed);
    const label = collapsed ? "Unfold labels" : "Fold labels";
    this.labelFoldButtons.forEach((button) => {
      applyTooltip(button, label);
      setIcon(button, collapsed ? "panel-left-open" : "panel-left-close");
    });
  }

  /** The same, for the gesture that actually changes the column's width. */
  private applyLabelColumn(dashboard: DashboardSettings): void {
    this.syncLabelColumn(dashboard);
    // vis-timeline sizes the left panel from its own content width, so the
    // collapsed labels only take effect once it re-measures them.
    window.requestAnimationFrame(() => {
      this.timeline?.redraw();
      this.updateAxis(true);
      this.syncFloatingLabels();
      this.syncSegmentLines();
    });
  }

  private createIconButton(
    parent: HTMLElement,
    icon: string,
    label: string,
    onClick: (event: MouseEvent) => void
  ): HTMLButtonElement {
    const button = parent.createEl("button", {
      cls: "clickable-icon",
      attr: { type: "button" },
    });
    applyTooltip(button, label);
    setIcon(button, icon);
    button.addEventListener("click", (event) => onClick(event));
    return button;
  }

  private createModeSelect(
    toolbar: HTMLElement,
    label: string,
    value: string,
    options: Array<[string, string]>,
    onChange: (value: string) => Promise<void>
  ): void {
    const wrapper = toolbar.createEl("label", { cls: "property-logs-toolbar-field" });
    wrapper.createSpan({ text: label });
    const select = wrapper.createEl("select", { cls: "dropdown" });
    options.forEach(([optionValue, text]) => select.createEl("option", { value: optionValue, text }));
    select.value = value;
    select.addEventListener("change", () => void onChange(select.value));
  }

  private timelineAnimation(): TimelineAnimationOptions {
    return {
      animation: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? false
        : { duration: 180, easingFunction: "easeInOutQuad" },
    };
  }

  private centerOnFocus(animate = true): void {
    if (!this.timeline) return;
    const visible = this.timeline.getWindow();
    const duration = visible.end.getTime() - visible.start.getTime();
    const center = this.focus ? centerOf(this.focus.range).getTime() : Date.now();
    this.timeline.setWindow(
      new Date(center - duration / 2),
      new Date(center + duration / 2),
      animate ? this.timelineAnimation() : { animation: false }
    );
  }

  // ─── Timeline ──────────────────────────────────────────────────────────────

  private isFolded(dashboard: DashboardSettings, groupId: string): boolean {
    return dashboard.foldedGroups.includes(groupId);
  }

  private async toggleFold(dashboard: DashboardSettings, groupId: string): Promise<void> {
    // Labels outlive a redraw now, so the dashboard one was built with may have
    // been replaced by the settings tab since.
    dashboard = this.host.getDashboard(this.dashboardId) ?? dashboard;
    dashboard.foldedGroups = this.isFolded(dashboard, groupId)
      ? dashboard.foldedGroups.filter((id) => id !== groupId)
      : [...dashboard.foldedGroups, groupId];
    await this.host.save();
    this.refresh();
  }

  /**
   * Describes the whole dashboard without building any of it: which groups
   * exist, which blocks sit in them, and what each is drawn from. Nothing here
   * touches the DOM, so the result can be compared against what is on screen.
   */
  private buildModel(rows: TimelineRow[], dashboard: DashboardSettings): TimelineModel {
    const model: TimelineModel = {
      items: [],
      groups: [],
      itemRows: new Map(),
      journalNotes: new Map(),
      noteGroupIds: new Map(),
      groupLabelText: new Map(),
    };
    const sortedRows = [...rows].sort((first, second) => compareRows(first, second, dashboard));

    if (dashboard.groupBy === "status") {
      const statusBuckets = new Map<string, {
        level: TimelineLevel;
        notes: Set<string>;
        segments: Array<{ row: TimelineRow; segment: TimelineSegment; segmentIndex: number }>;
      }>();
      sortedRows.forEach((row) => {
        row.parsed.segments.forEach((segment, segmentIndex) => {
          const status = segment.value ?? "Unset";
          const bucket = statusBuckets.get(status) ?? {
            level: segment.level,
            notes: new Set<string>(),
            segments: [],
          };
          bucket.level = Math.max(bucket.level, segment.level) as TimelineLevel;
          bucket.notes.add(row.file.path);
          bucket.segments.push({ row, segment, segmentIndex });
          statusBuckets.set(status, bucket);
        });
      });

      Array.from(statusBuckets.entries())
        .sort(([firstStatus, first], [secondStatus, second]) =>
          first.level - second.level || compareText(firstStatus, secondStatus))
        .forEach(([status, bucket], order) => {
          const groupId = `status:${status}`;
          const foldable = bucket.notes.size > 1;
          const folded = foldable && this.isFolded(dashboard, groupId);
          const noteCount = bucket.notes.size;
          model.groupLabelText.set(groupId, status);
          model.groups.push({
            id: groupId,
            props: {
              id: groupId,
              className: folded
                ? "property-logs-status-group is-folded"
                : "property-logs-status-group",
              order,
            },
            contentKey: `status|${status}|${noteCount}|${foldable}|${folded}`,
            createContent: () => this.createGroupLabel(
              dashboard,
              groupId,
              this.createStatusLabel(status, noteCount),
              foldable
            ),
          });
          if (folded) {
            this.planFoldedSegments(model, groupId, dashboard, bucket.segments);
            return;
          }
          bucket.segments.forEach(({ row, segment, segmentIndex }) => {
            this.planSegmentItem(model, row, dashboard, segment, segmentIndex, groupId);
          });
        });
    } else if (dashboard.groupBy === "none") {
      const buckets = new Map<string, TimelineRow[]>();
      let order = 0;
      sortedRows.forEach((row) => {
        const groupId = `note:${row.file.path}`;
        model.noteGroupIds.set(row.file.path, groupId);
        model.groupLabelText.set(groupId, row.file.basename);
        model.groups.push({
          id: groupId,
          props: {
            id: groupId,
            className: row.parsed.malformed ? "property-logs-row-malformed" : "property-logs-row",
            order: order++,
          },
          contentKey: this.rowLabelKey(row, dashboard),
          createContent: () => this.createRowLabel(row, dashboard),
        });
        row.parsed.segments.forEach((segment, segmentIndex) => {
          this.planSegmentItem(model, row, dashboard, segment, segmentIndex, groupId);
        });
      });
    } else {
      const outerBuckets = new Map<string, TimelineRow[]>();
      sortedRows.forEach((row) => {
        rowGroupValues(row, dashboard).forEach((value) => {
          const bucket = outerBuckets.get(value) ?? [];
          bucket.push(row);
          outerBuckets.set(value, bucket);
        });
      });

      let order = 0;
      Array.from(outerBuckets.entries())
        .sort(([first], [second]) => compareText(first, second))
        .forEach(([outerValue, bucketRows]) => {
          const parentId = groupId("bucket", outerValue);
          const parentFolded = this.isFolded(dashboard, parentId);
          const statusBuckets = new Map<string, {
            level: TimelineLevel;
            notes: Set<string>;
            segments: Array<{ row: TimelineRow; segment: TimelineSegment; segmentIndex: number }>;
          }>();
          bucketRows.forEach((row) => row.parsed.segments.forEach((segment, segmentIndex) => {
            const status = segment.value ?? "No value";
            const bucket = statusBuckets.get(status) ?? {
              level: segment.level,
              notes: new Set<string>(),
              segments: [],
            };
            bucket.level = Math.max(bucket.level, segment.level) as TimelineLevel;
            bucket.notes.add(row.file.path);
            bucket.segments.push({ row, segment, segmentIndex });
            statusBuckets.set(status, bucket);
          }));
          const statuses = Array.from(statusBuckets.entries()).sort(([firstStatus, first], [secondStatus, second]) =>
            first.level - second.level || compareText(firstStatus, secondStatus));
          const parentFoldable = bucketRows.length > 1 || statuses.length > 1;
          const childIds = statuses.map(([status]) => groupId(`${parentId}:status`, status));

          // With the label column folded, only one label should float into a
          // visible nested row. An expanded parent has no timeline blocks of
          // its own, so its children carry the combined path instead. A
          // folded parent does hold the summary blocks, so it carries its own
          // label again.
          model.groupLabelText.set(parentId, parentFolded ? outerValue : "");
          model.groups.push({
            id: parentId,
            props: {
              id: parentId,
              nestedGroups: parentFolded ? undefined : childIds,
              showNested: parentFolded ? undefined : true,
              className: parentFolded
                ? "property-logs-group-header is-folded"
                : "property-logs-group-header",
              order: order++,
            },
            contentKey: `outer|${outerValue}|${bucketRows.length}|${parentFoldable}|${parentFolded}`,
            createContent: () => this.createGroupLabel(
              dashboard, parentId, this.createBucketLabel(outerValue, bucketRows.length), parentFoldable
            ),
          });

          if (parentFolded) {
            this.planFoldedSegments(
              model,
              parentId,
              dashboard,
              bucketRows.flatMap((row) => row.parsed.segments.map((segment, segmentIndex) => ({
                row,
                segment,
                segmentIndex,
              })))
            );
            return;
          }

          statuses.forEach(([status, statusBucket], index) => {
            const childId = childIds[index];
            const childFoldable = statusBucket.notes.size > 1;
            const childFolded = childFoldable && this.isFolded(dashboard, childId);
            model.groupLabelText.set(childId, `${outerValue} · ${status}`);
            model.groups.push({
              id: childId,
              props: {
                id: childId,
                className: childFolded
                  ? "property-logs-status-group is-folded"
                  : "property-logs-status-group",
                order: order++,
              },
              contentKey: `nested-status|${outerValue}|${status}|${statusBucket.notes.size}|${childFoldable}|${childFolded}`,
              createContent: () => this.createGroupLabel(
                dashboard, childId, this.createStatusLabel(status, statusBucket.notes.size), childFoldable
              ),
            });
            if (childFolded) {
              this.planFoldedSegments(model, childId, dashboard, statusBucket.segments);
              return;
            }
            statusBucket.segments.forEach(({ row, segment, segmentIndex }) => {
              this.planSegmentItem(model, row, dashboard, segment, segmentIndex, childId);
            });
          });
        });
    }

    return model;
  }

  /** Builds the vis-timeline instance the model will be fed into from now on. */
  private mountTimeline(
    model: TimelineModel,
    dashboard: DashboardSettings,
    visible: PeriodRange
  ): void {
    const wrapper = this.containerEl.createDiv({ cls: "property-logs-timeline-wrapper" });
    // A headerless embed has no toolbar to hold the fold button, so it gets a
    // small one tucked into the corner above the label column instead.
    if (this.options.showToolbar === false) {
      this.createLabelFoldButton(wrapper, dashboard, "property-logs-labels-corner-toggle");
    }
    const axisEl = wrapper.createDiv({ cls: "property-logs-axis" });
    const timelineEl = wrapper.createDiv({ cls: "property-logs-timeline" });
    const dividersEl = wrapper.createDiv({ cls: "property-logs-axis-dividers" });
    this.timelineEl = timelineEl;
    this.dividersEl = dividersEl;
    axisEl.toggle(dashboard.showPeriodAxis);
    dividersEl.toggle(dashboard.showPeriodAxis);

    this.itemsData = new DataSet<TimelineItem>();
    this.groupsData = new DataSet<TimelineGroup>();
    this.appliedItems.clear();
    this.appliedGroups.clear();
    this.nestedSignature = "";
    this.applyModel(model);

    const options = this.timelineOptions(visible, dashboard.showPeriodAxis);
    // vis-timeline supports HTMLElement content at runtime, although the standalone
    // constructor's collection alias narrows item content to strings.
    this.timeline = new Timeline(
      timelineEl,
      this.itemsData as any,
      this.groupsData as any,
      options
    );
    if (this.options.compact && Platform.isMobile) {
      this.enableCompactMobilePinchZoom(this.timeline, timelineEl);
    }
    this.timeline.on("click", (properties: TimelineEventPropertiesResult) => {
      if (properties.item === null || properties.item === undefined) return;
      const id = String(properties.item);
      const journalNote = this.journalNotesById.get(id);
      if (journalNote) {
        this.activateJournalNote(journalNote, properties.event);
        return;
      }
      const row = this.itemRows.get(id);
      if (row) this.activateTimelineBlock(row, dashboard, properties.event);
    });
    this.timeline.on("contextmenu", (properties: TimelineEventPropertiesResult) => {
      if (!this.isCtrlGesture(properties.event)) return;
      properties.event.preventDefault();
      if (properties.item === null || properties.item === undefined) return;
      const row = this.itemRows.get(String(properties.item));
      if (row) this.activateTimelineBlock(row, dashboard, properties.event);
    });

    // Rows are rebuilt on any redraw, so the folded-column labels are restored
    // from the same signal that vis uses to announce it has finished one.
    this.timeline.on("changed", () => {
      this.syncFloatingLabels();
      this.syncSegmentLines();
    });

    if (dashboard.showPeriodAxis) {
      this.axis = new PeriodAxis(axisEl, dividersEl, {
        weekStartsOn: this.host.getWeekStartsOn(),
        openable: this.openableGranularities,
        onOpenPeriod: (granularity, date) => {
          void this.host.getPeriodicNotes().openPeriod(granularity, date);
        },
      });
      this.axis.setFocus(this.focus?.range ?? null);
      this.timeline.on("rangechange", () => this.updateAxis());
      this.timeline.on("rangechanged", () => this.updateAxis(true));
      this.timeline.on("changed", () => this.updateAxis());
    }

    // Setting the initial range in the constructor can leave vis-timeline's root
    // hidden when its first range-change event fires before Obsidian lays out the
    // container. Build it visibly first, then apply the desired window.
    this.timeline.setWindow(visible.start, visible.end, { animation: false });
    const initialTimeline = this.timeline;
    window.requestAnimationFrame(() => {
      if (this.timeline !== initialTimeline) return;
      this.timeline.redraw();
      this.timeline.setWindow(visible.start, visible.end, { animation: false });
      this.updateAxis();
      this.syncFloatingLabels();
      this.syncSegmentLines();
      // Blocks are positioned twice before they sit where they belong. Holding
      // the wrapper back until then trades a visible jump for one short fade.
      wrapper.addClass("is-ready");
    });

    this.observeResize(wrapper, initialTimeline);
    this.renderedKey = this.viewKey();
    this.renderedLayoutKey = this.layoutKey(dashboard);
  }

  /**
   * Hands the model to vis-timeline as the difference from what it already
   * holds: rows and blocks that did not change keep the elements they have,
   * and the timeline keeps its scroll, its zoom and its selection.
   *
   * Returns false — having changed nothing — when the model re-links groups to
   * one another, which only a rebuild can carry out.
   */
  private applyModel(model: TimelineModel): boolean {
    const itemsData = this.itemsData;
    const groupsData = this.groupsData;
    if (!itemsData || !groupsData) return false;

    const nested = nestedGroupSignature(model.groups);
    if (this.appliedGroups.size > 0 && nested !== this.nestedSignature) return false;

    const groupAdds: TimelineGroup[] = [];
    const groupUpdates: Partial<TimelineGroup>[] = [];
    const nextGroups = new Map<string, AppliedEntry>();
    model.groups.forEach((group) => {
      const propsKey = planSignature(group.props as Record<string, unknown>);
      const applied = this.appliedGroups.get(group.id);
      if (!applied) {
        groupAdds.push({ ...group.props, content: group.createContent() } as TimelineGroup);
      } else if (applied.contentKey !== group.contentKey) {
        groupUpdates.push({ ...group.props, content: group.createContent() } as TimelineGroup);
      } else if (applied.propsKey !== propsKey) {
        groupUpdates.push({ ...group.props } as Partial<TimelineGroup>);
      }
      nextGroups.set(group.id, { contentKey: group.contentKey, propsKey });
    });

    const itemAdds: TimelineItem[] = [];
    const itemUpdates: Partial<TimelineItem>[] = [];
    const nextItems = new Map<string, AppliedEntry>();
    model.items.forEach((item) => {
      const propsKey = planSignature(item.props as unknown as Record<string, unknown>);
      const applied = this.appliedItems.get(item.id);
      if (!applied) {
        itemAdds.push({ ...item.props, content: item.createContent() } as TimelineItem);
      } else if (applied.contentKey !== item.contentKey) {
        itemUpdates.push({ ...item.props, content: item.createContent() } as TimelineItem);
      } else if (applied.propsKey !== propsKey) {
        itemUpdates.push({ ...item.props } as Partial<TimelineItem>);
      }
      nextItems.set(item.id, { contentKey: item.contentKey, propsKey });
    });

    const removedItems = Array.from(this.appliedItems.keys()).filter((id) => !nextItems.has(id));
    const removedGroups = Array.from(this.appliedGroups.keys()).filter((id) => !nextGroups.has(id));

    // Items go before the groups that held them, and groups before the items
    // that arrive in them, so vis-timeline never sees a block without a row.
    if (removedItems.length > 0) itemsData.remove(removedItems);
    if (removedGroups.length > 0) groupsData.remove(removedGroups);
    if (groupAdds.length > 0) groupsData.add(groupAdds);
    if (groupUpdates.length > 0) groupsData.update(groupUpdates as TimelineGroup[]);
    if (itemAdds.length > 0) itemsData.add(itemAdds);
    if (itemUpdates.length > 0) itemsData.update(itemUpdates as TimelineItem[]);

    this.appliedGroups = nextGroups;
    this.appliedItems = nextItems;
    this.nestedSignature = nested;
    this.itemRows = model.itemRows;
    this.journalNotesById = model.journalNotes;
    this.groupLabelText = model.groupLabelText;
    return true;
  }

  private timelineOptions(visible: PeriodRange, showAxis: boolean): TimelineOptions {
    const compact = this.options.compact === true;
    const minimal = this.options.minimal === true;
    // An embedded timeline that pans on touch would swallow the note's own
    // scrolling, so embeds stay still on mobile and move with their buttons.
    const interactive = !(compact && Platform.isMobile);
    const options: TimelineOptions = {
      autoResize: true,
      width: "100%",
      editable: false,
      groupEditable: false,
      itemsAlwaysDraggable: false,
      selectable: false,
      multiselect: false,
      align: "auto",
      stack: true,
      stackSubgroups: true,
      orientation: { axis: "top", item: "top" },
      showCurrentTime: true,
      showTooltips: false,
      // Our own calendar strip replaces vis-timeline's labels so day, week, and
      // month cells can open the matching periodic note.
      showMinorLabels: !showAxis,
      showMajorLabels: !showAxis,
      horizontalScroll: !compact && !Platform.isMobile,
      verticalScroll: this.options.scroll !== false,
      moveable: interactive,
      // Chromium represents a trackpad pinch as a Ctrl-wheel gesture. Using
      // the same modifier for a mouse gives both inputs one native, pointer-
      // centred zoom path while ordinary wheel/trackpad scrolling stays intact.
      zoomable: interactive,
      zoomKey: Platform.isMobile ? "" : "ctrlKey",
      zoomFriction: 8,
      zoomMin: MIN_TIMELINE_ZOOM_MS,
      zoomMax: MAX_TIMELINE_ZOOM_MS,
      // Rows sit tight under the axis and stacked lines sit tight on each
      // other: the folded rows are read as a list, and a list has no gaps.
      margin: {
        item: { horizontal: 0, vertical: 1 },
        axis: minimal ? 1 : 2,
      },
      groupOrder: (first, second) => (first.order ?? 0) - (second.order ?? 0),
      start: visible.start,
      end: visible.end,
    };
    if (compact && this.options.scroll !== false) {
      options.maxHeight = this.options.maxHeight ?? (minimal ? 220 : 420);
    }
    else options.height = "100%";
    return options;
  }

  /**
   * vis-timeline requires `moveable` for its pinch zoom, but enabling that in
   * a compact mobile embed also captures one-finger swipes that belong to the
   * surrounding note. Its Hammer recognizer still reports pinch events while
   * movement is disabled, so handle only those two-finger gestures here.
   */
  private enableCompactMobilePinchZoom(timeline: Timeline, timelineEl: HTMLElement): void {
    const gestures = timeline as unknown as TimelineGestureEvents;
    let initial: {
      start: number;
      duration: number;
      scale: number;
      anchor: number;
      anchorRatio: number;
    } | null = null;

    gestures.on("touch", () => {
      initial = null;
    });
    gestures.on("release", () => {
      initial = null;
    });
    gestures.on("pinch", (event) => {
      if (event?.type === "pinchstart") initial = null;
      const scale = event?.scale;
      const center = event?.center;
      if (!scale || scale <= 0 || !center) return;

      event.preventDefault?.();
      if (event.srcEvent?.cancelable) event.srcEvent.preventDefault();

      if (!initial) {
        const visible = timeline.getWindow();
        const start = visible.start.getTime();
        const duration = visible.end.getTime() - start;
        const centerPanel = timelineEl.querySelector<HTMLElement>(".vis-panel.vis-center");
        const bounds = (centerPanel ?? timelineEl).getBoundingClientRect();
        const anchorRatio = Math.max(0, Math.min(1,
          (center.x - bounds.left) / Math.max(bounds.width, 1)
        ));
        initial = {
          start,
          duration,
          scale,
          anchor: start + duration * anchorRatio,
          anchorRatio,
        };
        return;
      }

      const duration = Math.max(
        MIN_TIMELINE_ZOOM_MS,
        Math.min(MAX_TIMELINE_ZOOM_MS, initial.duration * initial.scale / scale)
      );
      const start = initial.anchor - duration * initial.anchorRatio;
      timeline.setWindow(
        new Date(start),
        new Date(start + duration),
        { animation: false }
      );
    });
  }

  private observeResize(wrapper: HTMLElement, timeline: Timeline): void {
    if (typeof ResizeObserver === "undefined") return;
    this.resizeObserver = new ResizeObserver(() => {
      if (this.timeline !== timeline) return;
      this.updateAxis();
    });
    this.resizeObserver.observe(wrapper);
  }

  /**
   * Writes each row's value into the calendar itself, which is the only place
   * it can go once the label column is folded to nothing: that panel scrolls
   * vertically, so CSS can never let its contents spill sideways. vis hangs a
   * reference to the group off its own row element, so the text follows the
   * right row through every redraw, fold and scroll.
   */
  private syncFloatingLabels(): void {
    if (!this.timelineEl) return;
    const collapsed = this.containerEl.hasClass("is-labels-collapsed");
    this.timelineEl
      .querySelectorAll<HTMLElement>(".vis-foreground .vis-group")
      .forEach((groupEl) => {
        const existing = groupEl.querySelector<HTMLElement>(
          ":scope > .property-logs-floating-label"
        );
        const group = (groupEl as HTMLElement & { "vis-group"?: { groupId?: unknown } })["vis-group"];
        const text = collapsed
          ? this.groupLabelText.get(String(group?.groupId ?? "")) ?? ""
          : "";
        if (!text) {
          existing?.remove();
          return;
        }
        const label = existing ?? groupEl.createDiv({ cls: "property-logs-floating-label" });
        if (label.textContent !== text) label.setText(text);
      });
  }

  /**
   * Lays the line and arrow of every note out around its name.
   *
   * The name sits inside vis-timeline's content element, which vis slides
   * sideways to keep it on screen when the range starts off the left edge, so
   * the line has to begin wherever the name currently ends and reach the
   * range's own end — or, for a name longer than its range, sit flush behind
   * it with the arrow directly after the text. Both edges are pushed onto the
   * item as custom properties, where the CSS draws from them.
   */
  private syncSegmentLines(): void {
    if (!this.timelineEl) return;
    const items = this.timelineEl.querySelectorAll<HTMLElement>(
      ".vis-foreground .vis-item.property-logs-segment"
    );
    if (items.length === 0) {
      this.syncTransitionArrows();
      return;
    }
    const measured: Array<{ item: HTMLElement; start: number; end: number }> = [];
    // Read everything first, then write: interleaving the two makes the
    // browser lay the row out again for every single item.
    items.forEach((item) => {
      const content = item.querySelector<HTMLElement>(":scope > .vis-item-overflow > .vis-item-content");
      const label = content?.querySelector<HTMLElement>(".property-logs-segment-button");
      if (!content || !label) return;
      const width = parseFloat(item.style.width) || 0;
      const shift = /translateX\((-?[\d.]+)px\)/.exec(content.style.transform);
      const offset = shift ? parseFloat(shift[1]) : 0;
      let labelWidth = this.segmentLabelWidths.get(label);
      if (labelWidth === undefined) {
        labelWidth = label.offsetWidth;
        // A name that has not been laid out yet measures zero; try it again
        // on the next redraw rather than remembering that.
        if (labelWidth > 0) this.segmentLabelWidths.set(label, labelWidth);
      }
      const start = offset + labelWidth + SEGMENT_LINE_GAP;
      measured.push({ item, start, end: Math.max(width, start) });
    });
    measured.forEach(({ item, start, end }) => {
      const key = `${Math.round(start)}:${Math.round(end)}`;
      if (item.dataset.segmentLine === key) return;
      item.dataset.segmentLine = key;
      item.style.setProperty("--property-logs-line-start", `${start}px`);
      item.style.setProperty("--property-logs-line-end", `${end}px`);
    });
    this.syncTransitionArrows();
  }

  /**
   * Connects consecutive visible values of one note across their rows. CSS can
   * draw a segment's own horizontal line, but a change from Backlog to Active
   * crosses DOM rows, so it needs this lightweight SVG overlay.
   */
  private syncTransitionArrows(): void {
    if (!this.timelineEl) return;
    this.timelineEl.querySelector(".property-logs-transition-arrows")?.remove();
    const anchors = Array.from(this.timelineEl.querySelectorAll<HTMLElement>(
      ".vis-foreground .property-logs-segment-button[data-transition-note]"
    ));
    if (anchors.length < 2) return;

    const timelineBounds = this.timelineEl.getBoundingClientRect();
    if (timelineBounds.width <= 0 || timelineBounds.height <= 0) return;
    const byNoteAndScope = new Map<string, Map<number, HTMLElement>>();
    anchors.forEach((anchor) => {
      const note = anchor.dataset.transitionNote;
      const scope = anchor.dataset.transitionScope;
      const index = Number(anchor.dataset.transitionIndex);
      if (!note || !scope || !Number.isInteger(index)) return;
      const key = `${note}\u0000${scope}`;
      const entries = byNoteAndScope.get(key) ?? new Map<number, HTMLElement>();
      entries.set(index, anchor);
      byNoteAndScope.set(key, entries);
    });

    const paths: Array<{ start: HTMLElement; end: HTMLElement }> = [];
    byNoteAndScope.forEach((entries) => {
      entries.forEach((end, index) => {
        if (end.dataset.connectsFromPrevious !== "true") return;
        const start = entries.get(index - 1);
        if (start) paths.push({ start, end });
      });
    });
    if (paths.length === 0) return;

    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.classList.add("property-logs-transition-arrows");
    svg.setAttribute("width", String(this.timelineEl.clientWidth));
    svg.setAttribute("height", String(this.timelineEl.clientHeight));
    svg.setAttribute("viewBox", `0 0 ${this.timelineEl.clientWidth} ${this.timelineEl.clientHeight}`);
    const defs = document.createElementNS(ns, "defs");
    const marker = document.createElementNS(ns, "marker");
    marker.setAttribute("id", "property-logs-transition-arrowhead");
    marker.setAttribute("viewBox", "0 0 6 6");
    marker.setAttribute("refX", "5");
    marker.setAttribute("refY", "3");
    marker.setAttribute("markerWidth", "5");
    marker.setAttribute("markerHeight", "5");
    marker.setAttribute("orient", "auto");
    const head = document.createElementNS(ns, "path");
    head.setAttribute("d", "M 0 0 L 6 3 L 0 6 z");
    head.setAttribute("class", "property-logs-transition-arrowhead");
    marker.appendChild(head);
    defs.appendChild(marker);
    svg.appendChild(defs);

    paths.forEach(({ start, end }) => {
      const startItem = start.closest<HTMLElement>(".vis-item.property-logs-segment");
      const endItem = end.closest<HTMLElement>(".vis-item.property-logs-segment");
      if (!startItem || !endItem) return;
      const startBounds = startItem.getBoundingClientRect();
      const endBounds = endItem.getBoundingClientRect();
      const lineEnd = Number.parseFloat(startItem.style.getPropertyValue("--property-logs-line-end"));
      const lineStart = Number.parseFloat(endItem.style.getPropertyValue("--property-logs-line-start"));
      if (!Number.isFinite(lineEnd) || !Number.isFinite(lineStart)) return;
      const startX = startBounds.left - timelineBounds.left + lineEnd;
      const startY = startBounds.top - timelineBounds.top + startBounds.height / 2;
      const endX = endBounds.left - timelineBounds.left + lineStart;
      const endY = endBounds.top - timelineBounds.top + endBounds.height / 2;
      const bend = Math.max(8, Math.min(32, Math.abs(endX - startX) / 2));
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`);
      path.setAttribute("class", "property-logs-transition-arrow");
      path.setAttribute("marker-end", "url(#property-logs-transition-arrowhead)");
      const color = endItem.style.getPropertyValue("--property-logs-segment-color").trim();
      if (color) path.style.stroke = color;
      svg.appendChild(path);
    });
    if (svg.childElementCount > 1) this.timelineEl.appendChild(svg);
  }

  private updateAxis(immediate = false): void {
    if (!this.timeline || !this.axis || !this.timelineEl) return;
    const leftPanel = this.timelineEl.querySelector<HTMLElement>(".vis-panel.vis-left");
    const centerPanel = this.timelineEl.querySelector<HTMLElement>(".vis-panel.vis-center");
    const offset = leftPanel?.offsetWidth ?? 0;
    const width = centerPanel?.offsetWidth
      ?? Math.max(this.timelineEl.clientWidth - offset, 0);
    const visible = this.timeline.getWindow();
    this.axis.scheduleUpdate(
      { start: new Date(visible.start), end: new Date(visible.end) },
      offset,
      width,
      immediate
    );
  }

  /**
   * Collapses a group into compact note lanes rather than daily totals. The
   * first available lane is reused after a range ends; only simultaneous
   * ranges create another line and increase the folded row's height.
   */
  private planFoldedSegments(
    model: TimelineModel,
    groupId: string,
    dashboard: DashboardSettings,
    segments: Array<{ row: TimelineRow; segment: TimelineSegment; segmentIndex: number }>
  ): void {
    const laneEnds: Date[] = [];
    [...segments]
      .sort((first, second) =>
        first.segment.start.getTime() - second.segment.start.getTime()
        || first.segment.end.getTime() - second.segment.end.getTime()
        || compareText(first.row.file.basename, second.row.file.basename)
      )
      .forEach(({ row, segment, segmentIndex }) => {
        const isCurrent = isOngoingSegment(row, segmentIndex);
        const end = this.segmentEnd(segment, isCurrent);
        let lane = laneEnds.findIndex((laneEnd) => laneEnd.getTime() <= segment.start.getTime());
        if (lane === -1) {
          lane = laneEnds.length;
          laneEnds.push(end);
        } else {
          laneEnds[lane] = end;
        }
        const id = `${groupId}\u0000${row.file.path}:${segment.sourceIndex ?? `implicit-${segmentIndex}`}`;
        model.items.push({
          id,
          props: {
            id,
            group: groupId,
            subgroup: `folded-lane:${lane}`,
            subgroupOrder: lane,
            start: segment.start,
            end,
            type: "range",
            selectable: false,
            editable: false,
            className: `property-logs-folded-segment${isCurrent ? " is-ongoing" : ""}`,
            style: timelineColorStyle(segment.color),
          },
          contentKey: [
            "folded",
            row.file.stat.mtime,
            row.file.basename,
            segment.value ?? "",
            localDate(segment.start),
            localDate(segment.end),
            dashboard.noteOpenGesture,
            lane,
          ].join("|"),
          createContent: () => this.createFoldedSegmentContent(row, dashboard, segment),
        });
        model.itemRows.set(id, row);
      });
  }

  private segmentEnd(segment: TimelineSegment, isCurrent: boolean): Date {
    const startedToday = localDate(segment.start) === localDate(new Date());
    return segment.end.getTime() > segment.start.getTime()
      ? segment.end
      : addDays(segment.start, isCurrent && startedToday ? CURRENT_TODAY_OVERFLOW_DAYS : 1);
  }

  private planSegmentItem(
    model: TimelineModel,
    row: TimelineRow,
    dashboard: DashboardSettings,
    segment: TimelineSegment,
    segmentIndex: number,
    groupId: string
  ): void {
    const id = `${groupId}\u0000${row.file.path}:${segment.sourceIndex ?? `implicit-${segmentIndex}`}`;
    const isCurrent = isOngoingSegment(row, segmentIndex);
    const end = this.segmentEnd(segment, isCurrent);
    // Every note reads as its name and a line, ending in an arrow while the
    // value is still the note's current one. Names that would collide stack,
    // so a row grows only as far as its notes need.
    const className = `property-logs-segment${isCurrent ? " is-ongoing" : ""}`;
    const transitionScope = groupId.startsWith("status:")
      ? "status"
      : groupId.includes(":status:")
        ? groupId.slice(0, groupId.lastIndexOf(":status:"))
        : groupId;
    model.items.push({
      id,
      props: {
        id,
        group: groupId,
        start: segment.start,
        end,
        type: "range",
        align: "auto",
        selectable: false,
        editable: false,
        className,
        style: timelineColorStyle(segment.color),
      },
      // The block's own text comes from the note, its properties and the dates
      // of this segment; the note's mtime stands in for the first two.
      contentKey: [
        row.file.stat.mtime,
        row.file.basename,
        segment.value ?? "",
        localDate(segment.start),
        localDate(segment.end),
        dashboard.rowProperties.join(","),
        dashboard.noteOpenGesture,
      ].join("|"),
      createContent: () => this.createSegmentContent(
        row, dashboard, segment, segmentIndex, transitionScope, groupId
      ),
    });
    model.itemRows.set(id, row);
  }

  /** What a note's row label is drawn from, for spotting the ones that moved. */
  private rowLabelKey(row: TimelineRow, dashboard: DashboardSettings): string {
    return [
      "note",
      row.file.stat.mtime,
      row.file.basename,
      dashboard.rowProperties.join(","),
      row.parsed.issues.length,
    ].join("|");
  }

  private addJournalItems(
    model: TimelineModel,
    notes: JournalNote[],
    dashboard: DashboardSettings
  ): void {
    if (notes.length === 0) return;
    const markers = this.host.getJournalMarkers();
    const laneId = "journal:lane";
    const laneFolded = this.isFolded(dashboard, laneId);
    const foldedLaneNotes: Array<{ note: JournalNote; style: JournalMarkerStyle }> = [];
    const today = new Date();
    let laneCount = 0;

    notes.forEach((note) => {
      const style = markerStyle(markers, note.marker);
      const canOverflow = journalNoteCanOverflow(note, this.focus, today);
      const targetGroup = this.resolveJournalGroup(note, model.noteGroupIds);
      // A folded row is one line of counts with no room for pills, so a note
      // that would land in one goes back to the shared lane instead.
      const groupId = targetGroup && !this.isFolded(dashboard, targetGroup)
        ? targetGroup
        : laneId;
      if (groupId === laneId) {
        laneCount++;
        if (laneFolded) {
          foldedLaneNotes.push({ note, style });
          return;
        }
      }
      model.items.push({
        id: note.id,
        props: {
          id: note.id,
          group: groupId,
          start: canOverflow ? centerOf(note.range) : note.range.start,
          ...(canOverflow ? {} : { end: note.range.end }),
          type: canOverflow ? "point" : "range",
          selectable: false,
          editable: false,
          className: canOverflow
            ? "property-logs-journal-note is-overflowing"
            : "property-logs-journal-note is-contained",
          style: timelineColorStyle(style.color),
        },
        contentKey: [
          "journal",
          note.marker,
          note.text,
          note.file.basename,
          localDate(note.range.start),
          style.icon,
          style.label,
          canOverflow ? "overflowing" : "contained",
        ].join("|"),
        createContent: () => this.createJournalContent(note, style),
      });
      model.journalNotes.set(note.id, note);
    });

    if (laneCount > 0) {
      if (laneFolded) this.planFoldedJournalLines(model, laneId, foldedLaneNotes);
      model.groupLabelText.set(laneId, `Journal notes · ${laneCount}`);
      model.groups.unshift({
        id: laneId,
        props: {
          id: laneId,
          className: laneFolded
            ? "property-logs-journal-lane is-folded"
            : "property-logs-journal-lane",
          order: -1,
        } as Omit<TimelineGroup, "content">,
        contentKey: `journal-lane|${laneCount}|${laneFolded}`,
        createContent: () => this.createGroupLabel(
          dashboard,
          laneId,
          this.createJournalLaneLabel(laneCount, laneFolded),
          true
        ),
      });
    }
  }

  /** Folded journal notes use the same compact lane treatment as status notes. */
  private planFoldedJournalLines(
    model: TimelineModel,
    groupId: string,
    notes: Array<{ note: JournalNote; style: JournalMarkerStyle }>
  ): void {
    const laneEnds: Date[] = [];
    [...notes]
      .sort((first, second) => first.note.range.start.getTime() - second.note.range.start.getTime())
      .forEach(({ note, style }) => {
        const end = note.range.end.getTime() > note.range.start.getTime()
          ? note.range.end
          : addDays(note.range.start, 1);
        let lane = laneEnds.findIndex((laneEnd) => laneEnd.getTime() <= note.range.start.getTime());
        if (lane === -1) {
          lane = laneEnds.length;
          laneEnds.push(end);
        } else {
          laneEnds[lane] = end;
        }
        model.items.push({
          id: note.id,
          props: {
            id: note.id,
            group: groupId,
            subgroup: `folded-lane:${lane}`,
            subgroupOrder: lane,
            start: note.range.start,
            end,
            type: "range",
            selectable: false,
            editable: false,
            className: "property-logs-folded-segment property-logs-folded-journal-line",
            style: timelineColorStyle(style.color),
          },
          contentKey: `folded-journal|${note.marker}|${note.text}|${localDate(note.range.start)}|${lane}`,
          createContent: () => this.createFoldedJournalContent(note, style),
        });
        model.journalNotes.set(note.id, note);
      });
  }

  /**
   * The lane's own label: a marker icon and its name. Unfolded it also carries
   * how many notes it holds; folded, that number has moved out into the
   * calendar, where it is broken down by day.
   */
  private createJournalLaneLabel(count: number, folded: boolean): HTMLElement {
    const label = document.createElement("div");
    label.className = folded
      ? "property-logs-journal-lane-label is-folded"
      : "property-logs-journal-lane-label";
    const icon = label.createSpan({ cls: "property-logs-journal-lane-icon" });
    setIcon(icon, "sticky-note");
    label.createSpan({ text: "Journal notes", cls: "property-logs-journal-lane-name" });
    if (!folded) label.createSpan({ text: String(count), cls: "property-logs-status-count" });
    const plural = count === 1 ? "note" : "notes";
    applyTooltip(
      label,
      folded
        ? `${count} journal ${plural}, counted by day — unfold to read them`
        : `${count} journal ${plural}`,
      "right"
    );
    return label;
  }

  private resolveJournalGroup(
    note: JournalNote,
    noteGroupIds: Map<string, string>
  ): string | null {
    for (const link of note.links) {
      const target = this.app.metadataCache.getFirstLinkpathDest(link, note.file.path);
      if (!target) continue;
      const groupId = noteGroupIds.get(target.path);
      if (groupId) return groupId;
    }
    return null;
  }

  private createJournalContent(note: JournalNote, style: JournalMarkerStyle): HTMLElement {
    const content = document.createElement("button");
    content.type = "button";
    content.className = "property-logs-journal-button";
    content.setAttribute("data-task", note.marker);
    const text = plainNoteText(note.text);
    applyTooltip(
      content,
      `${style.label} · ${localDate(note.range.start)}\n${text}\n${note.file.basename}`
    );
    const icon = content.createSpan({ cls: "property-logs-journal-icon" });
    setIcon(icon, style.icon);
    content.createSpan({ text, cls: "property-logs-journal-text" });
    content.addEventListener("click", (event) => {
      event.stopPropagation();
      this.activateJournalNote(note, event);
    });
    return content;
  }

  /** Reclassifies today's annotations immediately after the local date rolls over. */
  private scheduleJournalDayRefresh(enabled: boolean): void {
    if (this.journalDayTimer !== null) window.clearTimeout(this.journalDayTimer);
    this.journalDayTimer = null;
    if (!enabled) return;

    const nextDay = new Date();
    nextDay.setHours(24, 0, 0, 50);
    this.journalDayTimer = window.setTimeout(() => {
      this.journalDayTimer = null;
      this.refresh();
    }, Math.max(1, nextDay.getTime() - Date.now()));
  }

  private createFoldedJournalContent(note: JournalNote, style: JournalMarkerStyle): HTMLElement {
    const content = document.createElement("button");
    content.type = "button";
    content.className = "property-logs-folded-segment-button";
    applyTooltip(content, `${style.label} · ${localDate(note.range.start)}\n${plainNoteText(note.text)}`);
    content.addEventListener("click", (event) => {
      event.stopPropagation();
      this.activateJournalNote(note, event);
    });
    return content;
  }

  private activateJournalNote(note: JournalNote, event: Event): void {
    const now = Date.now();
    const key = `journal:${note.id}`;
    if (this.lastBlockActivation?.key === key && now - this.lastBlockActivation.at < 250) return;
    this.lastBlockActivation = { key, at: now };

    if (Platform.isMobile || this.isCtrlGesture(event)) {
      const source = (event as Event & { srcEvent?: MouseEvent }).srcEvent ?? (event as MouseEvent);
      const menu = new Menu();
      menu.addItem((item) => item.setTitle(plainNoteText(note.text)).setIcon("quote").setDisabled(true));
      menu.addItem((item) => item
        .setTitle(`Open ${note.file.basename}`)
        .setIcon("file-text")
        .onClick(() => void this.openJournalSource(note)));
      if (typeof source.clientX === "number") menu.showAtMouseEvent(source);
      else menu.showAtPosition({ x: 0, y: 0 });
      return;
    }
    void this.openJournalSource(note);
  }

  private async openJournalSource(note: JournalNote): Promise<void> {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(note.file, { eState: { line: note.line } });
  }

  private createStatusLabel(status: string, noteCount: number): HTMLElement {
    const label = document.createElement("div");
    label.className = "property-logs-status-label";
    label.createSpan({ text: status, cls: "property-logs-status-name" });
    label.createSpan({ text: String(noteCount), cls: "property-logs-status-count" });
    applyTooltip(label, `${status} · ${noteCount} ${noteCount === 1 ? "note" : "notes"}`, "right");
    return label;
  }

  private createBucketLabel(bucket: string, noteCount: number): HTMLElement {
    const label = document.createElement("div");
    label.className = "property-logs-status-label";
    const name = bucket || "All notes";
    label.createSpan({ text: name, cls: "property-logs-status-name" });
    label.createSpan({ text: String(noteCount), cls: "property-logs-status-count" });
    applyTooltip(label, `${name} · ${noteCount} ${noteCount === 1 ? "note" : "notes"}`, "right");
    return label;
  }

  /** Wraps a group label with the fold toggle that collapses it into one row. */
  private createGroupLabel(
    dashboard: DashboardSettings,
    groupId: string,
    content: HTMLElement,
    foldable: boolean
  ): HTMLElement {
    // A group holding one note has nothing to collapse, so it keeps the space
    // the toggle would take and lines its name up with the plain note rows.
    if (!foldable) {
      const plain = document.createElement("div");
      plain.className = "property-logs-group-label is-static";
      plain.appendChild(content);
      return plain;
    }

    const folded = this.isFolded(dashboard, groupId);
    const wrapper = document.createElement("div");
    wrapper.className = folded
      ? "property-logs-group-label is-folded"
      : "property-logs-group-label";
    wrapper.dataset.foldableGroup = groupId;
    const toggle = wrapper.createEl("button", {
      cls: "property-logs-fold-toggle",
      attr: { type: "button", "aria-expanded": String(!folded) },
    });
    applyTooltip(toggle, folded ? "Unfold rows" : "Fold into one row");
    setIcon(toggle, folded ? "chevron-right" : "chevron-down");
    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.toggleFold(dashboard, groupId);
    });
    wrapper.appendChild(content);
    return wrapper;
  }

  private createSegmentContent(
    row: TimelineRow,
    dashboard: DashboardSettings,
    segment: TimelineSegment,
    segmentIndex: number,
    transitionScope: string,
    groupId: string
  ): HTMLElement {
    const content = document.createElement("button");
    content.type = "button";
    content.className = "property-logs-segment-button";
    content.dataset.transitionNote = row.file.path;
    content.dataset.transitionIndex = String(segmentIndex);
    content.dataset.transitionScope = transitionScope;
    content.dataset.transitionGroup = groupId;
    content.dataset.connectsFromPrevious = String(segment.connectsFromPrevious === true);
    const primaryAction = dashboard.noteOpenGesture === "click"
      ? "Click to open note; Ctrl-click to change value."
      : "Click to change value; Ctrl-click to open note.";
    content.createSpan({ text: row.file.basename, cls: "property-logs-segment-title" });
    // Properties stay in the markup rather than being dropped: the small name
    // hides them until it is hovered, and then grows to show them.
    const meta: string[] = [];
    dashboard.rowProperties.forEach((key) => {
      const value = displayPropertyValue(
        Object.prototype.hasOwnProperty.call(row.frontmatter, key)
          ? row.frontmatter[key]
          : latestHistoryValue(row.history, key, this.host.getDashboardDateKey())
      );
      if (!value) return;
      meta.push(`${key}: ${value}`);
      content.createSpan({ text: value, cls: "property-logs-segment-meta" });
    });
    applyTooltip(content, [
      row.file.basename,
      `${segment.value ?? "Unset"} · ${localDate(segment.start)} → ${localDate(segment.end)}`,
      ...meta,
      primaryAction,
    ].join("\n"));
    content.addEventListener("click", (event) => {
      event.stopPropagation();
      this.activateTimelineBlock(row, dashboard, event);
    });
    content.addEventListener("contextmenu", (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      this.activateTimelineBlock(row, dashboard, event);
    });
    return content;
  }

  /** A folded lane stays visually quiet; its note name belongs in the hint. */
  private createFoldedSegmentContent(
    row: TimelineRow,
    dashboard: DashboardSettings,
    segment: TimelineSegment
  ): HTMLElement {
    const content = document.createElement("button");
    content.type = "button";
    content.className = "property-logs-folded-segment-button";
    const primaryAction = dashboard.noteOpenGesture === "click"
      ? "Click to open note; Ctrl-click to change value."
      : "Click to change value; Ctrl-click to open note.";
    const tooltip = [
      row.file.basename,
      `${segment.value ?? "Unset"} · ${localDate(segment.start)} → ${localDate(segment.end)}`,
      primaryAction,
    ].join("\n");
    content.setAttribute("aria-label", tooltip);
    applyTooltip(content, tooltip);
    content.addEventListener("click", (event) => {
      event.stopPropagation();
      this.activateTimelineBlock(row, dashboard, event);
    });
    content.addEventListener("contextmenu", (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      this.activateTimelineBlock(row, dashboard, event);
    });
    return content;
  }

  private isCtrlGesture(event: Event): boolean {
    const direct = event as MouseEvent;
    const source = (event as Event & { srcEvent?: MouseEvent }).srcEvent;
    return Boolean(direct.ctrlKey || source?.ctrlKey);
  }

  private activateTimelineBlock(
    row: TimelineRow,
    dashboard: DashboardSettings,
    event: Event
  ): void {
    // A block that survived several redraws still carries the dashboard it was
    // built with, which the settings tab may since have replaced.
    dashboard = this.host.getDashboard(this.dashboardId) ?? dashboard;
    const gesture = this.isCtrlGesture(event) ? "ctrl-click" : "click";
    const opensNote = dashboard.noteOpenGesture === gesture;
    const activationKey = `${row.file.path}:${opensNote ? "open" : "edit"}`;
    const now = Date.now();
    if (
      this.lastBlockActivation?.key === activationKey
      && now - this.lastBlockActivation.at < 250
    ) return;
    this.lastBlockActivation = { key: activationKey, at: now };

    if (opensNote) {
      void this.app.workspace.getLeaf(false).openFile(row.file);
    } else {
      openValuePicker(this.host, row.file, dashboard);
    }
  }

  private createRowLabel(row: TimelineRow, dashboard: DashboardSettings): HTMLElement {
    const label = document.createElement("div");
    label.className = "property-logs-row-label";
    const title = label.createEl("button", {
      text: row.file.basename,
      cls: "property-logs-row-title",
      attr: { type: "button" },
    });
    applyTooltip(title, `${row.file.basename}\nClick to open the note.`, "right");
    title.addEventListener("click", () => void this.app.workspace.getLeaf(false).openFile(row.file));

    const metadata = label.createDiv({ cls: "property-logs-row-metadata" });
    dashboard.rowProperties.forEach((key) => {
      const value = displayPropertyValue(
        Object.prototype.hasOwnProperty.call(row.frontmatter, key)
          ? row.frontmatter[key]
          : latestHistoryValue(row.history, key, this.host.getDashboardDateKey())
      );
      if (!value) return;
      metadata.createSpan({ text: `${key}: ${value}` });
    });
    if (row.parsed.issues.length > 0) {
      const warning = label.createSpan({ cls: "property-logs-row-warning" });
      applyTooltip(warning, row.parsed.issues.map((issue) => issue.message).join("\n"));
      setIcon(warning, "triangle-alert");
    }
    return label;
  }

  private renderNoDashboard(): void {
    const empty = this.containerEl.createDiv({ cls: "property-logs-empty-state" });
    empty.createEl("h3", { text: "No timeline dashboard yet" });
    empty.createEl("p", {
      text: "Create one in Property Logs settings to start visualizing property history.",
    });
  }

  private renderTimelineError(error: unknown): void {
    this.containerEl.querySelector(".property-logs-timeline-wrapper")?.remove();
    const empty = this.containerEl.createDiv({
      cls: "property-logs-empty-state property-logs-error-state",
    });
    empty.createEl("h3", { text: "The timeline could not be displayed" });
    empty.createEl("p", {
      text: error instanceof Error
        ? error.message
        : "Reload Property Logs and try opening this dashboard again.",
    });
  }

  private renderEmptyState(dashboard: DashboardSettings): void {
    const empty = this.containerEl.createDiv({ cls: "property-logs-empty-state" });
    empty.createEl("h3", { text: "No visible notes" });
    empty.createEl("p", {
      text: dashboard.trackedPropertyKey.trim()
        ? "Add a note or adjust this dashboard's scope and level mappings."
        : "Choose a tracked frontmatter property in this dashboard's settings.",
    });
    if (dashboard.trackedPropertyKey.trim() && !this.options.compact) {
      const button = empty.createEl("button", { text: "Add note", cls: "mod-cta" });
      button.addEventListener("click", () => new AddTopicModal(this.app, this.host, dashboard).open());
    }
  }
}
