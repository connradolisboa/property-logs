import {
  App,
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
  TFile,
} from "obsidian";

import { parseEmbedOptions } from "../data/embedOptions";
import { periodRange, periodTitle } from "../data/periodic";
import { PeriodicNoteContext } from "../integrations/periodicNotes";
import { DashboardHost, DashboardTimeline } from "./DashboardTimeline";

/**
 * Renders a dashboard inside a note from a ```property-logs code block.
 *
 * The embed centers itself on the host note's period, which also makes it work
 * under Virtual Content: that plugin renders its markdown with the host note's
 * path as the source path, so the period resolves exactly as it does for a code
 * block typed into the note itself.
 */
export class DashboardEmbed extends MarkdownRenderChild {
  private timeline: DashboardTimeline | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private rendered = false;

  constructor(
    private readonly app: App,
    private readonly host: DashboardHost,
    containerEl: HTMLElement,
    private readonly source: string,
    private readonly sourcePath: string
  ) {
    super(containerEl);
  }

  async onload(): Promise<void> {
    this.containerEl.addClass("property-logs-embed");
    // Virtual Content and collapsed sections can render this block while it is
    // detached or zero-width, which vis-timeline cannot measure. Wait for real
    // width before building, then keep the timeline in sync with the note.
    if (this.containerEl.clientWidth > 0) await this.renderEmbed();
    else this.renderPlaceholder();
    this.observeSize();
  }

  onunload(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.timeline?.destroy();
    this.timeline = null;
  }

  refresh(): void {
    if (this.rendered) this.timeline?.refresh();
  }

  private observeSize(): void {
    if (typeof ResizeObserver === "undefined") return;
    this.resizeObserver = new ResizeObserver(() => {
      if (this.rendered || this.containerEl.clientWidth <= 0) return;
      void this.renderEmbed();
    });
    this.resizeObserver.observe(this.containerEl);
  }

  private renderPlaceholder(): void {
    this.containerEl.empty();
    const placeholder = this.containerEl.createDiv({ cls: "property-logs-loading" });
    for (let line = 0; line < 2; line++) {
      placeholder.createDiv({ cls: "property-logs-loading-line" });
    }
  }

  private async renderEmbed(): Promise<void> {
    this.rendered = true;
    const options = parseEmbedOptions(this.source);
    this.containerEl.empty();

    const dashboards = this.host.getDashboards();
    if (dashboards.length === 0) {
      this.renderMessage("Create a dashboard in Property Logs settings first.");
      return;
    }

    const needle = options.dashboard.trim().toLowerCase();
    const dashboard = needle
      ? dashboards.find((item) => item.id.toLowerCase() === needle)
        ?? dashboards.find((item) => item.name.toLowerCase() === needle)
      : dashboards[0];
    if (!dashboard) {
      this.renderMessage(`No dashboard named "${options.dashboard}".`);
      return;
    }

    if (options.errors.length > 0) {
      const warning = this.containerEl.createDiv({ cls: "property-logs-embed-warning" });
      options.errors.forEach((error) => warning.createDiv({ text: error }));
    }

    const context = await this.resolveContext(options.date, options.period);
    const timelineEl = this.containerEl.createDiv({ cls: "property-logs-embed-body" });
    this.timeline = new DashboardTimeline(this.app, this.host, timelineEl, {
      compact: true,
      minimal: options.minimal,
      showToolbar: options.minimal ? false : options.header,
      maxHeight: options.height,
      windowDays: options.windowDays,
    });
    this.timeline.setDashboardId(dashboard.id);
    this.timeline.setFocus(context
      ? {
          granularity: context.granularity,
          range: context.range,
          label: periodTitle(context.granularity, context.range.start),
        }
      : null);
    await this.timeline.render();
  }

  private async resolveContext(
    explicitDate: Date | null,
    explicitPeriod: PeriodicNoteContext["granularity"] | null
  ): Promise<PeriodicNoteContext | null> {
    const periodic = this.host.getPeriodicNotes();
    const weekStartsOn = this.host.getWeekStartsOn();

    if (explicitDate) {
      const granularity = explicitPeriod ?? "day";
      return {
        granularity,
        date: explicitDate,
        range: periodRange(granularity, explicitDate, weekStartsOn),
        source: "frontmatter",
      };
    }

    const file = this.app.vault.getAbstractFileByPath(this.sourcePath);
    if (!(file instanceof TFile)) return null;
    const context = await periodic.contextForFile(file);
    if (!context) return null;
    if (!explicitPeriod || explicitPeriod === context.granularity) return context;
    return {
      ...context,
      granularity: explicitPeriod,
      range: periodRange(explicitPeriod, context.date, weekStartsOn),
    };
  }

  private renderMessage(text: string): void {
    this.containerEl.createDiv({ cls: "property-logs-embed-warning", text });
  }
}

export const EMBED_CODE_BLOCK = "property-logs";

export function createEmbedProcessor(
  app: App,
  host: DashboardHost,
  register: (embed: DashboardEmbed) => void
) {
  return (source: string, element: HTMLElement, context: MarkdownPostProcessorContext) => {
    const embed = new DashboardEmbed(app, host, element, source, context.sourcePath);
    register(embed);
    context.addChild(embed);
  };
}
