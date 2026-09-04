import { App, Menu, Platform, TFile, setIcon } from "obsidian";
import {
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

export interface DashboardHost extends TopicHost {
  getDashboards(): DashboardSettings[];
  getDashboard(id: string): DashboardSettings | undefined;
  openDashboard(id: string): Promise<void>;
  duplicateDashboard(id: string): Promise<DashboardSettings | null>;
  resolveHistoryKey(frontmatterKey: string): string;
  getDashboardHistoryKey(): string;
  getDashboardDateKey(): string;
  getGlobalValueStyles(): GlobalValueStyles;
  getJournalMarkers(): JournalMarkerStyle[];
  getPeriodicNotes(): PeriodicNotes;
  getJournalNoteIndex(): JournalNoteIndex;
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
  onOpenFullDashboard?: (dashboardId: string) => void;
}

interface TimelineRow {
  file: TFile;
  frontmatter: Record<string, unknown>;
  history: unknown;
  parsed: HistoryParserResult;
  level: TimelineLevel;
  recentChange: number;
}

/** Mutable collections owned by one vis-timeline instance.
 *
 * Journal notes arrive after the primary timeline has drawn. Keeping these
 * collections lets us attach them without tearing down a usable dashboard.
 */
interface RenderedTimelineData {
  items: TimelineItem[];
  groups: TimelineGroup[];
  journalItems: Map<string, JournalNote>;
  noteGroupIds: Map<string, string>;
}

const DAY_MS = 1000 * 60 * 60 * 24;

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

function rowGroupValue(row: TimelineRow, dashboard: DashboardSettings): string {
  if (dashboard.groupBy === "folder") return row.file.parent?.path || "Vault root";
  if (dashboard.groupBy === "level") return `Level ${row.level}`;
  const propertyKey = propertyKeyFromMode(dashboard.groupBy);
  if (propertyKey) return displayPropertyValue(row.frontmatter[propertyKey]) || "Unset";
  return "";
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

function centerOf(range: PeriodRange): Date {
  return new Date((range.start.getTime() + range.end.getTime()) / 2);
}

/**
 * Renders one dashboard into any container: the timeline view, and the
 * `property-logs` code block embedded in a periodic note.
 */
export class DashboardTimeline {
  private timeline: Timeline | null = null;
  private axis: PeriodAxis | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private renderToken = 0;
  private refreshTimer: number | null = null;
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
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
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
    this.timelineEl = null;
    this.dividersEl = null;
  }

  async render(): Promise<void> {
    const token = ++this.renderToken;
    this.destroyTimeline();
    this.containerEl.empty();
    this.labelFoldButtons = [];
    this.containerEl.addClass("property-logs-dashboard");
    this.containerEl.toggleClass("is-compact", this.options.compact === true);
    this.containerEl.toggleClass("is-minimal", this.options.minimal === true);
    this.containerEl.toggleClass("is-mobile-layout", Platform.isMobile);

    const dashboard = this.host.getDashboard(this.dashboardId) ?? this.host.getDashboards()[0];
    if (!dashboard) {
      this.renderNoDashboard();
      return;
    }
    this.dashboardId = dashboard.id;
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
    const visible = this.resolveWindow();

    if (this.options.showToolbar === false) header.remove();
    else if (this.options.compact) this.renderCompactHeader(header, dashboard);
    else this.renderToolbar(header, dashboard, this.collectProperties(rows, dashboard, files));
    loading.remove();

    if (rows.length === 0 && !dashboard.showJournalNotes) {
      this.renderEmptyState(dashboard);
      return;
    }

    try {
      const rendered = this.renderTimeline(rows, dashboard, visible);
      // Reading marked journal lines can involve disk reads. Do it after the
      // dashboard is interactive; the update below keeps its current window.
      void this.addJournalNotesAfterInitialDraw(token, dashboard, visible, rendered);
    } catch (error) {
      console.error("Property Logs could not render the timeline", error);
      this.renderTimelineError(error);
    }

    void this.refreshOpenableGranularities();
  }

  // ─── Data ──────────────────────────────────────────────────────────────────

  private buildRows(dashboard: DashboardSettings, files: TFile[]): TimelineRow[] {
    if (!dashboard.trackedPropertyKey.trim()) return [];
    const today = new Date();
    const trackedHistoryKey = this.host.resolveHistoryKey(dashboard.trackedPropertyKey);
    const dateKey = this.host.getDashboardDateKey();
    const historyKey = this.host.getDashboardHistoryKey();
    const globalStyles = this.host.getGlobalValueStyles();
    const globalLevels = globalLevelMapping(globalStyles);
    const valueColors = resolveValueColors(globalStyles, dashboard.valueColors);

    return files.flatMap((file) => {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as
        | Record<string, unknown>
        | undefined;
      const metadata = frontmatter ?? {};
      const history = collectCompatibleHistory(metadata, historyKey, dateKey);
      const parsed = reconstructHistorySegments({
        history,
        trackedHistoryKey,
        dateKey,
        creationDate: file.stat.ctime,
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
      if (parsed.segments.length === 0 && !parsed.malformed) return [];
      return [{
        file,
        frontmatter: metadata,
        history,
        parsed,
        level: parsed.currentLevel,
        recentChange: latestTrackedDate(history, trackedHistoryKey, dateKey),
      }];
    });
  }

  private collectProperties(
    rows: TimelineRow[],
    dashboard: DashboardSettings,
    files: TFile[]
  ): string[] {
    const properties = new Set<string>([
      dashboard.trackedPropertyKey,
      dashboard.colorProperty,
      ...dashboard.rowProperties,
    ].filter(Boolean));
    rows.forEach((row) => Object.keys(row.frontmatter).forEach((key) => properties.add(key)));
    files.forEach((file) => {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (frontmatter) Object.keys(frontmatter).forEach((key) => properties.add(key));
    });
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

  private async addJournalNotesAfterInitialDraw(
    token: number,
    dashboard: DashboardSettings,
    visible: PeriodRange,
    rendered: RenderedTimelineData
  ): Promise<void> {
    const notes = await this.collectJournalNotes(dashboard, visible);
    if (token !== this.renderToken || this.timeline === null) return;
    if (notes.length === 0) {
      // A dashboard that has no tracked rows uses journal notes as its only
      // possible content. Replace the temporary empty timeline with the normal
      // guidance once that lookup completes.
      if (rendered.items.length === 0) {
        this.destroyTimeline();
        this.containerEl.querySelector(".property-logs-timeline-wrapper")?.remove();
        this.renderEmptyState(dashboard);
      }
      return;
    }

    this.addJournalItems(
      rendered.items,
      rendered.journalItems,
      rendered.groups,
      notes,
      dashboard,
      rendered.noteGroupIds
    );
    // setData retains the timeline instance and, crucially, the user's current
    // pan/zoom position while vis-timeline incorporates the delayed notes.
    this.timeline.setData({ items: rendered.items as any, groups: rendered.groups as any });
    this.timeline.redraw();
    this.updateAxis();
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
      attr: { type: "button", title: `Open ${dashboard.name}` },
    });
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
      attr: {
        "aria-label": dashboard.sortAscending ? "Sort descending" : "Sort ascending",
        type: "button",
      },
    });
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
      attr: { type: "button", "aria-label": "Center today", title: "Center today" },
    });
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
      dashboard.collapsedLabels = !dashboard.collapsedLabels;
      this.applyLabelColumn(dashboard);
      void this.host.save();
    });
    if (cls) button.addClass(cls);
    this.labelFoldButtons.push(button);
    this.applyLabelColumn(dashboard);
  }

  /** Mirrors the folded state onto the container and every fold button on screen. */
  private applyLabelColumn(dashboard: DashboardSettings): void {
    const collapsed = dashboard.collapsedLabels;
    this.containerEl.toggleClass("is-labels-collapsed", collapsed);
    const label = collapsed ? "Unfold labels" : "Fold labels";
    this.labelFoldButtons.forEach((button) => {
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
      setIcon(button, collapsed ? "panel-left-open" : "panel-left-close");
    });
    // vis-timeline sizes the left panel from its own content width, so the
    // collapsed labels only take effect once it re-measures them.
    window.requestAnimationFrame(() => {
      this.timeline?.redraw();
      this.updateAxis(true);
      this.syncFloatingLabels();
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
      attr: { type: "button", "aria-label": label, title: label },
    });
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
    dashboard.foldedGroups = this.isFolded(dashboard, groupId)
      ? dashboard.foldedGroups.filter((id) => id !== groupId)
      : [...dashboard.foldedGroups, groupId];
    await this.host.save();
    this.refresh();
  }

  private renderTimeline(
    rows: TimelineRow[],
    dashboard: DashboardSettings,
    visible: PeriodRange
  ): RenderedTimelineData {
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

    const items: TimelineItem[] = [];
    const groups: TimelineGroup[] = [];
    const itemRows = new Map<string, TimelineRow>();
    this.groupLabelText.clear();
    const journalItems = new Map<string, JournalNote>();
    /** note path → the group that note occupies, for attaching linked journal notes. */
    const noteGroupIds = new Map<string, string>();
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
          this.groupLabelText.set(groupId, status);
          groups.push({
            id: groupId,
            content: this.createGroupLabel(
              dashboard,
              groupId,
              this.createStatusLabel(status, bucket.notes.size),
              foldable
            ),
            className: folded
              ? "property-logs-status-group is-folded"
              : "property-logs-status-group",
            order,
          });
          bucket.segments.forEach(({ row, segment, segmentIndex }) => {
            this.addSegmentItem(items, itemRows, row, dashboard, segment, segmentIndex, groupId, folded);
          });
        });
    } else {
      const buckets = new Map<string, TimelineRow[]>();
      if (dashboard.groupBy === "none") {
        buckets.set("", sortedRows);
      } else {
        sortedRows.forEach((row) => {
          const key = rowGroupValue(row, dashboard);
          const bucket = buckets.get(key) ?? [];
          bucket.push(row);
          buckets.set(key, bucket);
        });
      }

      let order = 0;
      Array.from(buckets.entries())
        .sort(([first], [second]) => compareText(first, second))
        .forEach(([bucket, bucketRows]) => {
          const parentId = `bucket:${bucket}`;
          const foldable = dashboard.groupBy !== "none" && bucketRows.length > 1;
          const folded = foldable && this.isFolded(dashboard, parentId);

          if (dashboard.groupBy !== "none") {
            this.groupLabelText.set(parentId, bucket || "All notes");
            const label = this.createGroupLabel(
              dashboard,
              parentId,
              this.createBucketLabel(bucket, bucketRows.length),
              foldable
            );
            groups.push({
              id: parentId,
              content: label,
              nestedGroups: folded ? undefined : bucketRows.map((row) => `note:${row.file.path}`),
              showNested: folded ? undefined : true,
              className: folded
                ? "property-logs-group-header is-folded"
                : "property-logs-group-header",
              order: order++,
            });
          }

          if (folded) {
            bucketRows.forEach((row) => {
              noteGroupIds.set(row.file.path, parentId);
              row.parsed.segments.forEach((segment, segmentIndex) => {
                this.addSegmentItem(
                  items, itemRows, row, dashboard, segment, segmentIndex, parentId, true
                );
              });
            });
            return;
          }

          bucketRows.forEach((row) => {
            const groupId = `note:${row.file.path}`;
            noteGroupIds.set(row.file.path, groupId);
            this.groupLabelText.set(groupId, row.file.basename);
            groups.push({
              id: groupId,
              content: this.createRowLabel(row, dashboard),
              className: row.parsed.malformed ? "property-logs-row-malformed" : "property-logs-row",
              order: order++,
            });
            row.parsed.segments.forEach((segment, segmentIndex) => {
              this.addSegmentItem(
                items, itemRows, row, dashboard, segment, segmentIndex, groupId, false
              );
            });
          });
        });
    }

    const options = this.timelineOptions(visible, dashboard.showPeriodAxis);
    // vis-timeline supports HTMLElement content at runtime, although the standalone
    // constructor's collection alias narrows item content to strings.
    this.timeline = new Timeline(timelineEl, items as any, groups as any, options);
    this.timeline.on("click", (properties: TimelineEventPropertiesResult) => {
      if (properties.item === null || properties.item === undefined) return;
      const id = String(properties.item);
      const journalNote = journalItems.get(id);
      if (journalNote) {
        this.activateJournalNote(journalNote, properties.event);
        return;
      }
      const row = itemRows.get(id);
      if (row) this.activateTimelineBlock(row, dashboard, properties.event);
    });
    this.timeline.on("contextmenu", (properties: TimelineEventPropertiesResult) => {
      if (!this.isCtrlGesture(properties.event)) return;
      properties.event.preventDefault();
      if (properties.item === null || properties.item === undefined) return;
      const row = itemRows.get(String(properties.item));
      if (row) this.activateTimelineBlock(row, dashboard, properties.event);
    });

    // Rows are rebuilt on any redraw, so the folded-column labels are restored
    // from the same signal that vis uses to announce it has finished one.
    this.timeline.on("changed", () => this.syncFloatingLabels());

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
    });

    this.observeResize(wrapper, initialTimeline);
    return { items, groups, journalItems, noteGroupIds };
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
      verticalScroll: true,
      moveable: interactive,
      zoomable: Platform.isMobile && interactive,
      zoomMin: 1000 * 60 * 60 * 24 * 7,
      zoomMax: 1000 * 60 * 60 * 24 * 365 * 20,
      margin: {
        item: { horizontal: 0, vertical: minimal ? 1 : compact ? 1 : 2 },
        axis: minimal ? 2 : compact ? 3 : 5,
      },
      groupOrder: (first, second) => (first.order ?? 0) - (second.order ?? 0),
      start: visible.start,
      end: visible.end,
    };
    if (compact) options.maxHeight = this.options.maxHeight ?? (minimal ? 220 : 420);
    else options.height = "100%";
    return options;
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

  private addSegmentItem(
    items: TimelineItem[],
    itemRows: Map<string, TimelineRow>,
    row: TimelineRow,
    dashboard: DashboardSettings,
    segment: TimelineSegment,
    segmentIndex: number,
    groupId: string,
    folded: boolean
  ): void {
    const id = `${row.file.path}:${segment.sourceIndex ?? `implicit-${segmentIndex}`}`;
    const isCurrent = segmentIndex === row.parsed.segments.length - 1;
    const startedToday = localDate(segment.start) === localDate(new Date());
    const end = segment.end.getTime() > segment.start.getTime()
      ? segment.end
      : addDays(segment.start, isCurrent && startedToday ? CURRENT_TODAY_OVERFLOW_DAYS : 1);
    const item: TimelineItem = {
      id,
      group: groupId,
      start: segment.start,
      end,
      type: "range",
      align: "auto",
      content: this.createSegmentContent(row, dashboard, segment, folded),
      selectable: false,
      editable: false,
      className: folded ? "property-logs-segment is-folded" : "property-logs-segment",
      style: timelineColorStyle(segment.color),
    };
    // A shared subgroup keeps every note of a folded group on one line.
    if (folded) (item as TimelineItem & { subgroup?: string }).subgroup = `${groupId}:folded`;
    items.push(item);
    itemRows.set(id, row);
  }

  private addJournalItems(
    items: TimelineItem[],
    journalItems: Map<string, JournalNote>,
    groups: TimelineGroup[],
    notes: JournalNote[],
    dashboard: DashboardSettings,
    noteGroupIds: Map<string, string>
  ): void {
    if (notes.length === 0) return;
    const markers = this.host.getJournalMarkers();
    const laneId = "journal:lane";
    let laneUsed = false;

    notes.forEach((note) => {
      const style = markerStyle(markers, note.marker);
      const targetGroup = this.resolveJournalGroup(note, noteGroupIds);
      const groupId = targetGroup ?? laneId;
      if (!targetGroup) laneUsed = true;
      const folded = this.isFolded(dashboard, groupId);
      const item: TimelineItem = {
        id: note.id,
        group: groupId,
        start: centerOf(note.range),
        type: "point",
        content: this.createJournalContent(note, style),
        selectable: false,
        editable: false,
        className: "property-logs-journal-note",
        style: timelineColorStyle(style.color),
      };
      if (folded) (item as TimelineItem & { subgroup?: string }).subgroup = `${groupId}:folded`;
      items.push(item);
      journalItems.set(note.id, note);
    });

    if (laneUsed) {
      const label = document.createElement("div");
      label.className = "property-logs-journal-lane-label";
      const icon = label.createSpan({ cls: "property-logs-journal-lane-icon" });
      setIcon(icon, "sticky-note");
      label.createSpan({ text: "Journal notes" });
      groups.unshift({
        id: laneId,
        content: label,
        className: "property-logs-journal-lane",
        order: -1,
      } as TimelineGroup);
    }
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
    content.title = `${style.label} · ${localDate(note.range.start)}\n${text}`;
    content.setAttribute("aria-label", `${style.label}: ${text}`);
    const icon = content.createSpan({ cls: "property-logs-journal-icon" });
    setIcon(icon, style.icon);
    content.createSpan({ text, cls: "property-logs-journal-text" });
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
    label.createSpan({
      text: String(noteCount),
      cls: "property-logs-status-count",
      attr: { "aria-label": `${noteCount} ${noteCount === 1 ? "note" : "notes"}` },
    });
    return label;
  }

  private createBucketLabel(bucket: string, noteCount: number): HTMLElement {
    const label = document.createElement("div");
    label.className = "property-logs-status-label";
    label.createSpan({ text: bucket || "All notes", cls: "property-logs-status-name" });
    label.createSpan({ text: String(noteCount), cls: "property-logs-status-count" });
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
      attr: {
        type: "button",
        "aria-expanded": String(!folded),
        "aria-label": folded ? "Unfold rows" : "Fold rows",
        title: folded ? "Unfold rows" : "Fold into one row",
      },
    });
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
    folded: boolean
  ): HTMLElement {
    const content = document.createElement("button");
    content.type = "button";
    content.className = folded
      ? "property-logs-segment-button is-folded"
      : "property-logs-segment-button";
    const primaryAction = dashboard.noteOpenGesture === "click"
      ? "Click to open note; Ctrl-click to change value."
      : "Click to change value; Ctrl-click to open note.";
    content.title = `${row.file.basename} — ${segment.value ?? "Unset"} — ${localDate(segment.start)} to ${localDate(segment.end)}. ${primaryAction}`;
    content.setAttribute(
      "aria-label",
      `${row.file.basename}: ${segment.value ?? "unset"}, level ${segment.level}. ${primaryAction}`
    );
    content.createSpan({ text: row.file.basename, cls: "property-logs-segment-title" });
    if (!folded) {
      dashboard.rowProperties.forEach((key) => {
        const value = displayPropertyValue(
          Object.prototype.hasOwnProperty.call(row.frontmatter, key)
            ? row.frontmatter[key]
            : latestHistoryValue(row.history, key, this.host.getDashboardDateKey())
        );
        if (value) content.createSpan({ text: value, cls: "property-logs-segment-meta" });
      });
    }
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
      warning.setAttribute("aria-label", "Timeline data warning");
      warning.setAttribute("title", row.parsed.issues.map((issue) => issue.message).join("\n"));
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
