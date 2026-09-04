import { TooltipPlacement, setTooltip } from "obsidian";

/**
 * One hover delay for every hint the plugin shows. Obsidian's own default is
 * slow for a dashboard whose blocks are deliberately clipped: reading a row
 * means sweeping across it, so the hint has to arrive almost immediately.
 */
export const TOOLTIP_DELAY_MS = 90;

/**
 * Attaches a hint through Obsidian's tooltip so it is themed and positioned
 * like every other one in the app, but on our own, shorter delay.
 *
 * The browser's native `title` popup is removed on the way past: it cannot be
 * retimed, and leaving it in place stacks a second, late tooltip on the first.
 */
export function applyTooltip(
  el: HTMLElement,
  text: string,
  placement: TooltipPlacement = "top"
): void {
  el.removeAttribute("title");
  if (typeof setTooltip === "function") {
    setTooltip(el, text, {
      delay: TOOLTIP_DELAY_MS,
      placement,
      classes: ["property-logs-tooltip"],
    });
    return;
  }
  // Older Obsidian builds without the tooltip helper still get something.
  el.setAttribute("aria-label", text);
}
