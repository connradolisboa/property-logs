import {
  App,
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
  TFile,
  setIcon,
} from "obsidian";

import { EmbedOptions, parseEmbedOptions } from "../data/embedOptions";
import { periodRange, periodTitle } from "../data/periodic";
import { PeriodicNoteContext } from "../integrations/periodicNotes";
import { DashboardHost, DashboardTimeline } from "./DashboardTimeline";
import { applyTooltip } from "./tooltips";

/** Heights a compact timeline settles at, mirrored from DashboardTimeline. */
const DEFAULT_EMBED_HEIGHT = 420;
const MINIMAL_EMBED_HEIGHT = 220;

/** How far ahead of the viewport an embed starts building itself. */
const PRERENDER_MARGIN_PX = 600;

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
  private visibilityObserver: IntersectionObserver | null = null;
  private rendered = false;
  private unloaded = false;
  private options: EmbedOptions | null = null;

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
    // Live Preview renders this block inside the editor, where a mousedown
    // reaching CodeMirror moves the caret into the code block and unrenders the
    // dashboard, and a ctrl-click raises the editor's own context menu before a
    // block sees it. Keeping both gestures inside the embed lets clicking and
    // ctrl-clicking a block behave the way they do in the full dashboard.
    this.registerDomEvent(this.containerEl, "mousedown", (event) => event.stopPropagation());
    this.registerDomEvent(this.containerEl, "contextmenu", (event) => {
      if (event.ctrlKey) event.stopPropagation();
    });
    this.options = parseEmbedOptions(this.source);
    // Building the dashboard means resolving the host note's period through
    // the Journals plugin and then laying out every block, so the skeleton
    // goes up first, at the height the finished timeline will take. A note
    // holding several embeds then reads immediately, and nothing under them
    // moves as each one fills in.
    this.renderPlaceholder();
    // Virtual Content and collapsed sections can render this block while it is
    // detached or zero-width, which vis-timeline cannot measure, so the build
    // waits for real width — and, for an embed further down a long note, for
    // the reader to come near it.
    this.observeVisibility();
    this.observeSize();
  }

  onunload(): void {
    this.unloaded = true;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.visibilityObserver?.disconnect();
    this.visibilityObserver = null;
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
      if (this.visibilityObserver && !this.isNearViewport()) return;
      void this.renderEmbed();
    });
    this.resizeObserver.observe(this.containerEl);
  }

  /**
   * Holds an off-screen embed at its reserved height until the reader
   * approaches it. Without IntersectionObserver — and in a printed or exported
   * note — every embed builds as soon as it has width, as it always did.
   */
  private observeVisibility(): void {
    if (typeof IntersectionObserver === "undefined") {
      if (this.containerEl.clientWidth > 0) void this.renderEmbed();
      return;
    }
    this.visibilityObserver = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      if (this.rendered || this.containerEl.clientWidth <= 0) return;
      void this.renderEmbed();
    }, { rootMargin: `${PRERENDER_MARGIN_PX}px 0px` });
    this.visibilityObserver.observe(this.containerEl);
  }

  private isNearViewport(): boolean {
    const bounds = this.containerEl.getBoundingClientRect();
    return bounds.bottom >= -PRERENDER_MARGIN_PX
      && bounds.top <= window.innerHeight + PRERENDER_MARGIN_PX;
  }

  /** The height the finished timeline will take, held while it is built. */
  private reservedHeight(): number {
    if (this.options?.height) return this.options.height;
    return this.options?.minimal ? MINIMAL_EMBED_HEIGHT : DEFAULT_EMBED_HEIGHT;
  }

  private renderPlaceholder(): void {
    this.containerEl.empty();
    this.containerEl.style.minHeight = `${this.reservedHeight()}px`;
    const placeholder = this.containerEl.createDiv({ cls: "property-logs-loading" });
    for (let line = 0; line < 2; line++) {
      placeholder.createDiv({ cls: "property-logs-loading-line" });
    }
  }

  private async renderEmbed(): Promise<void> {
    this.rendered = true;
    this.visibilityObserver?.disconnect();
    this.visibilityObserver = null;
    const options = this.options ?? parseEmbedOptions(this.source);
    // The context lookup below can wait on the Journals plugin, so the
    // skeleton stays up until there is a timeline to put in its place.
    const context = await this.resolveContext(options.date, options.period);
    if (this.unloaded) return;
    this.containerEl.empty();
    this.containerEl.style.removeProperty("min-height");

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

    const embedBody = this.containerEl.createDiv({ cls: "property-logs-embed-body" });
    const timelineEl = embedBody.createDiv({ cls: "property-logs-embed-timeline" });
    if (options.minimal) {
      const openDashboard = embedBody.createEl("button", {
        cls: "property-logs-minimal-open-dashboard clickable-icon",
        attr: { type: "button" },
      });
      applyTooltip(openDashboard, `Open ${dashboard.name} dashboard`, "left");
      setIcon(openDashboard, "maximize-2");
      openDashboard.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.host.openDashboard(dashboard.id);
      });
    }
    this.timeline = new DashboardTimeline(this.app, this.host, timelineEl, {
      compact: true,
      minimal: options.minimal,
      showToolbar: options.minimal ? false : options.header,
      maxHeight: options.height,
      windowDays: options.windowDays,
      scroll: options.scroll,
      dashboardOverrides: {
        groupBy: options.groupBy ?? undefined,
        sortBy: options.sortBy ?? undefined,
        sortAscending: options.sortAscending ?? undefined,
      },
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
