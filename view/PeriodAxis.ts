import {
  PeriodGranularity,
  PeriodRange,
  axisGranularities,
  nextPeriodStart,
  periodLabel,
  periodRange,
  periodBoundaries,
  periodTitle,
} from "../data/periodic";

export interface PeriodAxisOptions {
  weekStartsOn: number;
  /** Granularities that have a periodic note to open. Others render as plain labels. */
  openable: Set<PeriodGranularity>;
  onOpenPeriod(granularity: PeriodGranularity, date: Date): void;
}

/**
 * A clickable calendar strip drawn above the timeline, plus the divider overlay
 * that lines up with it. Both are positioned from the visible window, which is
 * a linear time scale in vis-timeline, so a simple ratio is exact.
 */
export class PeriodAxis {
  private readonly rowsEl: HTMLElement;
  private readonly dividersEl: HTMLElement;
  private frame: number | null = null;
  private timer: number | null = null;
  private lastDrawAt = 0;
  private pending: { visible: PeriodRange; offsetLeft: number; width: number } | null = null;
  private focus: PeriodRange | null = null;

  constructor(
    private readonly axisEl: HTMLElement,
    dividersEl: HTMLElement,
    private options: PeriodAxisOptions
  ) {
    this.rowsEl = axisEl.createDiv({ cls: "property-logs-axis-rows" });
    this.dividersEl = dividersEl;
  }

  setOptions(options: Partial<PeriodAxisOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /** Marks the embedded note's own period so it reads as the anchor of the view. */
  setFocus(range: PeriodRange | null): void {
    this.focus = range;
  }

  scheduleUpdate(visible: PeriodRange, offsetLeft: number, width: number, immediate = false): void {
    this.pending = { visible, offsetLeft, width };
    if (immediate) {
      if (this.timer !== null) window.clearTimeout(this.timer);
      this.timer = null;
      if (this.frame !== null) window.cancelAnimationFrame(this.frame);
      this.frame = window.requestAnimationFrame(() => this.flush());
      return;
    }
    if (this.frame !== null || this.timer !== null) return;

    // Panning can emit rangechange much faster than the timeline can paint.
    // Redrawing this independent calendar at 12fps keeps it legible without
    // forcing layout for dozens of cells on every drag frame.
    const delay = Math.max(0, 80 - (performance.now() - this.lastDrawAt));
    if (delay > 0) {
      this.timer = window.setTimeout(() => {
        this.timer = null;
        this.frame = window.requestAnimationFrame(() => this.flush());
      }, delay);
    } else {
      this.frame = window.requestAnimationFrame(() => this.flush());
    }
  }

  private flush(): void {
    this.frame = null;
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    this.lastDrawAt = performance.now();
    this.update(pending.visible, pending.offsetLeft, pending.width);
  }

  update(visible: PeriodRange, offsetLeft: number, width: number): void {
    this.axisEl.style.setProperty("--property-logs-axis-offset", `${offsetLeft}px`);
    this.dividersEl.style.setProperty("--property-logs-axis-offset", `${offsetLeft}px`);
    this.rowsEl.empty();
    this.dividersEl.empty();
    if (width <= 0) return;

    const span = visible.end.getTime() - visible.start.getTime();
    if (span <= 0) return;
    const x = (date: Date) => ((date.getTime() - visible.start.getTime()) / span) * width;
    const [fine, coarse] = axisGranularities(span);
    const today = new Date();

    this.drawRow(coarse, visible, x, width, today, "coarse");
    this.drawRow(fine, visible, x, width, today, "fine");
    this.drawDividers(fine, coarse, visible, x, width);
  }

  private drawRow(
    granularity: PeriodGranularity,
    visible: PeriodRange,
    x: (date: Date) => number,
    width: number,
    today: Date,
    variant: "fine" | "coarse"
  ): void {
    const row = this.rowsEl.createDiv({
      cls: `property-logs-axis-row property-logs-axis-row-${variant}`,
    });
    const openable = this.options.openable.has(granularity);
    const todayRange = periodRange(granularity, today, this.options.weekStartsOn);

    for (const start of periodBoundaries(granularity, visible, this.options.weekStartsOn)) {
      const end = nextPeriodStart(granularity, start, this.options.weekStartsOn);
      if (end.getTime() <= visible.start.getTime()) continue;
      if (start.getTime() >= visible.end.getTime()) break;

      const left = Math.max(x(start), 0);
      const right = Math.min(x(end), width);
      const cellWidth = right - left;
      if (cellWidth < 6) continue;

      const cell = row.createEl(openable ? "button" : "div", {
        cls: "property-logs-axis-cell",
        attr: openable
          ? { type: "button", title: `Open ${periodTitle(granularity, start)}` }
          : { title: periodTitle(granularity, start) },
      });
      cell.style.left = `${left}px`;
      cell.style.width = `${cellWidth}px`;
      cell.toggleClass("is-today", start.getTime() === todayRange.start.getTime());
      cell.toggleClass(
        "is-focus",
        this.focus !== null
          && start.getTime() < this.focus.end.getTime()
          && end.getTime() > this.focus.start.getTime()
      );
      if (cellWidth >= 22) {
        cell.createSpan({ text: periodLabel(granularity, start) });
      }
      if (openable) {
        cell.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.options.onOpenPeriod(granularity, start);
        });
      }
    }
  }

  private drawDividers(
    fine: PeriodGranularity,
    coarse: PeriodGranularity,
    visible: PeriodRange,
    x: (date: Date) => number,
    width: number
  ): void {
    const coarseStarts = new Set(
      periodBoundaries(coarse, visible, this.options.weekStartsOn).map((date) => date.getTime())
    );
    const fineStarts = periodBoundaries(fine, visible, this.options.weekStartsOn);
    const minimumGap = width / 90;
    let lastX = Number.NEGATIVE_INFINITY;

    for (const start of fineStarts) {
      const position = x(start);
      if (position < 0 || position > width) continue;
      const strong = coarseStarts.has(start.getTime());
      if (!strong && position - lastX < minimumGap) continue;
      lastX = position;
      const divider = this.dividersEl.createDiv({
        cls: strong
          ? "property-logs-axis-divider is-strong"
          : "property-logs-axis-divider",
      });
      divider.style.left = `${position}px`;
    }

  }

  destroy(): void {
    if (this.frame !== null) window.cancelAnimationFrame(this.frame);
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.frame = null;
    this.timer = null;
    this.pending = null;
  }
}
