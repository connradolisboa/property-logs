import {
  ItemView,
  Notice,
  TFile,
  ViewStateResult,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
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
import { AddTopicModal, TopicHost } from "../modals/AddTopicModal";
import { openValuePicker } from "../modals/SetValueModal";

export const TIMELINE_VIEW_TYPE = "property-logs-timeline";

export interface TimelineViewHost extends TopicHost {
  getDashboards(): DashboardSettings[];
  getDashboard(id: string): DashboardSettings | undefined;
  openDashboard(id: string): Promise<void>;
  resolveHistoryKey(frontmatterKey: string): string;
  getDashboardHistoryKey(): string;
  getDashboardDateKey(): string;
  save(): Promise<void>;
}

interface TimelineRow {
  file: TFile;
  frontmatter: Record<string, unknown>;
  history: unknown;
  parsed: HistoryParserResult;
  level: TimelineLevel;
  recentChange: number;
}

function localDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function latestTrackedDate(
  history: unknown,
  historyKey: string,
  dateKey: string
): number {
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

function addOneDay(date: Date): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + 1);
  return next;
}

export class TimelineDashboardView extends ItemView {
  private dashboardId = "";
  private timeline: Timeline | null = null;
  private renderToken = 0;
  private refreshTimer: number | null = null;
  private lastBlockActivation: { key: string; at: number } | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly host: TimelineViewHost) {
    super(leaf);
  }

  getViewType(): string {
    return TIMELINE_VIEW_TYPE;
  }

  getDisplayText(): string {
    const dashboard = this.host.getDashboard(this.dashboardId);
    return dashboard?.name ?? "Property Logs Timeline";
  }

  getIcon(): string {
    return "chart-gantt";
  }

  getState(): Record<string, unknown> {
    return { dashboardId: this.dashboardId };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    if (state && typeof state === "object" && !Array.isArray(state)) {
      const id = (state as Record<string, unknown>).dashboardId;
      if (typeof id === "string") this.dashboardId = id;
    }
    await this.render();
  }

  async onOpen(): Promise<void> {
    if (!this.dashboardId) this.dashboardId = this.host.getDashboards()[0]?.id ?? "";
    await this.render();
  }

  async onClose(): Promise<void> {
    this.renderToken++;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.destroyTimeline();
    this.contentEl.empty();
  }

  refresh(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.render();
    }, 100);
  }

  private destroyTimeline(): void {
    this.timeline?.destroy();
    this.timeline = null;
  }

  private async render(): Promise<void> {
    const token = ++this.renderToken;
    this.destroyTimeline();
    this.contentEl.empty();
    this.contentEl.addClass("property-logs-timeline-view");

    const dashboard = this.host.getDashboard(this.dashboardId)
      ?? this.host.getDashboards()[0];
    if (!dashboard) {
      this.renderNoDashboard();
      return;
    }
    this.dashboardId = dashboard.id;

    const toolbar = this.contentEl.createDiv({ cls: "property-logs-toolbar" });
    const loading = this.contentEl.createDiv({ cls: "property-logs-loading" });
    loading.createDiv({ cls: "property-logs-loading-line" });
    loading.createDiv({ cls: "property-logs-loading-line" });
    loading.createDiv({ cls: "property-logs-loading-line" });
    loading.setAttribute("role", "status");
    loading.setAttribute("aria-label", "Loading timeline");

    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    if (token !== this.renderToken) return;

    const rows = this.buildRows(dashboard);
    const properties = this.collectProperties(rows, dashboard);
    this.renderToolbar(toolbar, dashboard, properties);
    loading.remove();

    if (rows.length === 0) {
      this.renderEmptyState(dashboard);
      return;
    }
    try {
      this.renderTimeline(rows, dashboard);
    } catch (error) {
      console.error("Property Logs could not render the timeline", error);
      this.renderTimelineError(error);
    }
  }

  private buildRows(dashboard: DashboardSettings): TimelineRow[] {
    if (!dashboard.trackedPropertyKey.trim()) return [];
    const today = new Date();
    const trackedHistoryKey = this.host.resolveHistoryKey(dashboard.trackedPropertyKey);
    const dateKey = this.host.getDashboardDateKey();
    const historyKey = this.host.getDashboardHistoryKey();

    return this.host.getDashboardFiles(dashboard).flatMap((file) => {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
      const metadata = frontmatter ?? {};
      const history = collectCompatibleHistory(metadata, historyKey, dateKey);
      const parsed = reconstructHistorySegments({
        history,
        trackedHistoryKey,
        dateKey,
        creationDate: file.stat.ctime,
        today,
        levelMapping: dashboard.levelMapping,
        defaultLevelForUnset: dashboard.defaultLevelForUnset,
        unmappedValueLevel: dashboard.unmappedValueLevel,
        colorMode: dashboard.colorMode,
        levelColors: dashboard.levelColors,
        colorPropertyValue: metadata[dashboard.colorProperty],
        colorPropertyMap: dashboard.colorPropertyMap,
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

  private collectProperties(rows: TimelineRow[], dashboard: DashboardSettings): string[] {
    const properties = new Set<string>([
      dashboard.trackedPropertyKey,
      dashboard.colorProperty,
      ...dashboard.rowProperties,
    ].filter(Boolean));
    rows.forEach((row) => Object.keys(row.frontmatter).forEach((key) => properties.add(key)));
    this.host.getDashboardFiles(dashboard).forEach((file) => {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (frontmatter) Object.keys(frontmatter).forEach((key) => properties.add(key));
    });
    return Array.from(properties).sort(compareText);
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
      dashboards.forEach((item) => selector.createEl("option", {
        text: item.name,
        value: item.id,
      }));
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
    ], async (value) => {
      dashboard.colorMode = value === "property" ? "property" : "level";
      await this.host.save();
      this.refresh();
    });

    this.renderTimelineControls(toolbar);

    const add = toolbar.createEl("button", {
      text: "Add note",
      cls: "mod-cta property-logs-add-topic",
      attr: { type: "button" },
    });
    add.addEventListener("click", () => new AddTopicModal(this.app, this.host, dashboard).open());
  }

  private renderTimelineControls(toolbar: HTMLElement): void {
    const controls = toolbar.createDiv({ cls: "property-logs-timeline-controls" });
    const zoomOut = controls.createEl("button", {
      cls: "clickable-icon",
      attr: { type: "button", "aria-label": "Zoom out", title: "Zoom out" },
    });
    setIcon(zoomOut, "zoom-out");
    zoomOut.addEventListener("click", () => {
      this.timeline?.zoomOut(0.35, this.timelineAnimation());
    });

    const today = controls.createEl("button", {
      cls: "property-logs-today-button",
      attr: { type: "button", "aria-label": "Center today", title: "Center today" },
    });
    setIcon(today, "calendar-days");
    today.createSpan({ text: "Today" });
    today.addEventListener("click", () => this.centerToday());

    const zoomIn = controls.createEl("button", {
      cls: "clickable-icon",
      attr: { type: "button", "aria-label": "Zoom in", title: "Zoom in" },
    });
    setIcon(zoomIn, "zoom-in");
    zoomIn.addEventListener("click", () => {
      this.timeline?.zoomIn(0.35, this.timelineAnimation());
    });
  }

  private timelineAnimation(): TimelineAnimationOptions {
    return {
      animation: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? false
        : { duration: 180, easingFunction: "easeInOutQuad" },
    };
  }

  private centerToday(animate = true): void {
    if (!this.timeline) return;
    const visible = this.timeline.getWindow();
    const duration = visible.end.getTime() - visible.start.getTime();
    const center = Date.now();
    this.timeline.setWindow(
      new Date(center - duration / 2),
      new Date(center + duration / 2),
      animate ? this.timelineAnimation() : { animation: false }
    );
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
    options.forEach(([optionValue, text]) => select.createEl("option", {
      value: optionValue,
      text,
    }));
    select.value = value;
    select.addEventListener("change", () => void onChange(select.value));
  }

  private renderTimeline(rows: TimelineRow[], dashboard: DashboardSettings): void {
    const timelineEl = this.contentEl.createDiv({ cls: "property-logs-timeline" });
    const items: TimelineItem[] = [];
    const groups: TimelineGroup[] = [];
    const itemRows = new Map<string, TimelineRow>();
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
          first.level - second.level || compareText(firstStatus, secondStatus)
        )
        .forEach(([status, bucket], order) => {
          const groupId = `status:${status}`;
          groups.push({
            id: groupId,
            content: this.createStatusLabel(status, bucket.notes.size),
            className: "property-logs-status-group",
            order,
          });
          bucket.segments.forEach(({ row, segment, segmentIndex }) => {
            this.addSegmentItem(items, itemRows, row, dashboard, segment, segmentIndex, groupId);
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
      Array.from(buckets.entries()).sort(([first], [second]) => compareText(first, second)).forEach(([bucket, bucketRows]) => {
        const childIds: string[] = [];
        if (dashboard.groupBy !== "none") {
          const parentId = `bucket:${bucket}`;
          bucketRows.forEach((row) => childIds.push(`note:${row.file.path}`));
          groups.push({
            id: parentId,
            content: bucket,
            nestedGroups: childIds,
            showNested: true,
            className: "property-logs-group-header",
            order: order++,
          });
        }

        bucketRows.forEach((row) => {
          const groupId = `note:${row.file.path}`;
          groups.push({
            id: groupId,
            content: this.createRowLabel(row, dashboard),
            className: row.parsed.malformed ? "property-logs-row-malformed" : "property-logs-row",
            order: order++,
          });
          row.parsed.segments.forEach((segment, segmentIndex) => {
            this.addSegmentItem(items, itemRows, row, dashboard, segment, segmentIndex, groupId);
          });
        });
      });
    }

    const today = new Date();
    // Dashboard-control changes rebuild the timeline. Start each rebuilt view
    // centered on today so a group/sort/color change does not pin today to an edge.
    const initialWindowDuration = 1000 * 60 * 60 * 24 * 90;
    const windowStart = new Date(today.getTime() - initialWindowDuration / 2);
    const windowEnd = new Date(today.getTime() + initialWindowDuration / 2);
    const options: TimelineOptions = {
      autoResize: true,
      width: "100%",
      height: "100%",
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
      horizontalScroll: true,
      verticalScroll: true,
      moveable: true,
      zoomable: false,
      zoomMin: 1000 * 60 * 60 * 24 * 7,
      zoomMax: 1000 * 60 * 60 * 24 * 365 * 20,
      margin: { item: { horizontal: 0, vertical: 4 }, axis: 8 },
      groupOrder: (first, second) => (first.order ?? 0) - (second.order ?? 0),
    };
    // vis-timeline supports HTMLElement content at runtime, although the standalone
    // constructor's collection alias narrows item content to strings.
    this.timeline = new Timeline(timelineEl, items as any, groups as any, options);
    this.timeline.on("click", (properties: TimelineEventPropertiesResult) => {
      if (properties.item === null || properties.item === undefined) return;
      const row = itemRows.get(String(properties.item));
      if (row) this.activateTimelineBlock(row, dashboard, properties.event);
    });
    this.timeline.on("contextmenu", (properties: TimelineEventPropertiesResult) => {
      if (!this.isCtrlGesture(properties.event)) return;
      properties.event.preventDefault();
      if (properties.item === null || properties.item === undefined) return;
      const row = itemRows.get(String(properties.item));
      if (row) this.activateTimelineBlock(row, dashboard, properties.event);
    });
    // Setting the initial range in the constructor can leave vis-timeline's root
    // hidden when its first range-change event fires before Obsidian lays out the
    // ItemView. Build it visibly first, then apply the desired window.
    this.timeline.setWindow(windowStart, windowEnd, { animation: false });
    const initialTimeline = this.timeline;
    window.requestAnimationFrame(() => {
      if (this.timeline !== initialTimeline) return;
      this.timeline.redraw();
      // vis-timeline can adjust its range during the first visible layout pass.
      // Recenter after that pass so today stays in the middle on dashboard open
      // and after rebuilding for dashboard-control changes.
      this.centerToday(false);
    });
  }

  private addSegmentItem(
    items: TimelineItem[],
    itemRows: Map<string, TimelineRow>,
    row: TimelineRow,
    dashboard: DashboardSettings,
    segment: TimelineSegment,
    segmentIndex: number,
    groupId: string
  ): void {
    const id = `${row.file.path}:${segment.sourceIndex ?? `implicit-${segmentIndex}`}`;
    const end = segment.end.getTime() <= segment.start.getTime()
      ? addOneDay(segment.start)
      : segment.end;
    items.push({
      id,
      group: groupId,
      start: segment.start,
      end,
      type: "range",
      align: "auto",
      content: this.createSegmentContent(row, dashboard, segment),
      selectable: false,
      editable: false,
      className: "property-logs-segment",
      style: timelineColorStyle(segment.color),
    });
    itemRows.set(id, row);
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

  private createSegmentContent(
    row: TimelineRow,
    dashboard: DashboardSettings,
    segment: TimelineSegment
  ): HTMLElement {
    const content = document.createElement("button");
    content.type = "button";
    content.className = "property-logs-segment-button";
    const primaryAction = dashboard.noteOpenGesture === "click"
      ? "Click to open note; Ctrl-click to change value."
      : "Click to change value; Ctrl-click to open note.";
    content.title = `${row.file.basename} — ${segment.value ?? "Unset"} — ${localDate(segment.start)} to ${localDate(segment.end)}. ${primaryAction}`;
    content.setAttribute(
      "aria-label",
      `${row.file.basename}: ${segment.value ?? "unset"}, level ${segment.level}. ${primaryAction}`
    );
    content.createSpan({ text: row.file.basename, cls: "property-logs-segment-title" });
    dashboard.rowProperties.forEach((key) => {
      const value = displayPropertyValue(
        Object.prototype.hasOwnProperty.call(row.frontmatter, key)
          ? row.frontmatter[key]
          : latestHistoryValue(row.history, key, this.host.getDashboardDateKey())
      );
      if (value) content.createSpan({ text: value, cls: "property-logs-segment-meta" });
    });
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
          : latestHistoryValue(
              row.history,
              key,
              this.host.getDashboardDateKey()
            )
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
    const empty = this.contentEl.createDiv({ cls: "property-logs-empty-state" });
    empty.createEl("h3", { text: "No timeline dashboard yet" });
    empty.createEl("p", { text: "Create one in Property Logs settings to start visualizing property history." });
  }

  private renderTimelineError(error: unknown): void {
    this.contentEl.querySelector(".property-logs-timeline")?.remove();
    const empty = this.contentEl.createDiv({ cls: "property-logs-empty-state property-logs-error-state" });
    empty.createEl("h3", { text: "The timeline could not be displayed" });
    empty.createEl("p", {
      text: error instanceof Error
        ? error.message
        : "Reload Property Logs and try opening this dashboard again.",
    });
  }

  private renderEmptyState(dashboard: DashboardSettings): void {
    const empty = this.contentEl.createDiv({ cls: "property-logs-empty-state" });
    empty.createEl("h3", { text: "No visible notes" });
    empty.createEl("p", {
      text: dashboard.trackedPropertyKey.trim()
        ? "Add a note or adjust this dashboard's scope and level mappings."
        : "Choose a tracked frontmatter property in this dashboard's settings.",
    });
    if (dashboard.trackedPropertyKey.trim()) {
      const button = empty.createEl("button", { text: "Add note", cls: "mod-cta" });
      button.addEventListener("click", () => new AddTopicModal(this.app, this.host, dashboard).open());
    }
  }
}
