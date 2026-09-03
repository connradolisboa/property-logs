import { ItemView, ViewStateResult, WorkspaceLeaf } from "obsidian";

import { DashboardHost, DashboardTimeline } from "./DashboardTimeline";

export const TIMELINE_VIEW_TYPE = "property-logs-timeline";

export type TimelineViewHost = DashboardHost;

/** The full-tab dashboard. All rendering lives in the shared DashboardTimeline. */
export class TimelineDashboardView extends ItemView {
  private dashboardId = "";
  private timeline: DashboardTimeline | null = null;

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
    await this.renderDashboard();
  }

  async onOpen(): Promise<void> {
    if (!this.dashboardId) this.dashboardId = this.host.getDashboards()[0]?.id ?? "";
    await this.renderDashboard();
  }

  async onClose(): Promise<void> {
    this.timeline?.destroy();
    this.timeline = null;
    this.contentEl.empty();
  }

  refresh(): void {
    this.timeline?.refresh();
  }

  private async renderDashboard(): Promise<void> {
    this.contentEl.addClass("property-logs-timeline-view");
    if (!this.timeline) {
      this.timeline = new DashboardTimeline(this.app, this.host, this.contentEl, {
        showToolbar: true,
        compact: false,
      });
    }
    this.timeline.setDashboardId(this.dashboardId);
    await this.timeline.render();
  }
}
