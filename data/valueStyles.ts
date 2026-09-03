import { DEFAULT_PROPERTY_COLOR, normalizeTimelineColor } from "./colorPalette";
import type { TimelineLevel } from "./historyParser";

/**
 * Vault-wide defaults for a tracked property value. Dashboards may override
 * either half; anything a dashboard leaves unset falls back to these.
 */
export interface GlobalValueStyle {
  level: TimelineLevel | null;
  color: string | null;
}

export type GlobalValueStyles = Record<string, GlobalValueStyle>;

function toLevel(value: unknown): TimelineLevel | null {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 4
    ? Number(value) as TimelineLevel
    : null;
}

export function normalizeGlobalValueStyles(raw: unknown): GlobalValueStyles {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: GlobalValueStyles = {};
  for (const [value, style] of Object.entries(raw as Record<string, unknown>)) {
    if (!value.trim()) continue;
    if (!style || typeof style !== "object" || Array.isArray(style)) continue;
    const record = style as Record<string, unknown>;
    const color = typeof record.color === "string" && record.color.trim()
      ? normalizeTimelineColor(record.color, DEFAULT_PROPERTY_COLOR)
      : null;
    result[value] = { level: toLevel(record.level), color };
  }
  return result;
}

/** Global levels expressed as a plain mapping, for the history parser fallback chain. */
export function globalLevelMapping(styles: GlobalValueStyles): Record<string, TimelineLevel> {
  const mapping: Record<string, TimelineLevel> = {};
  for (const [value, style] of Object.entries(styles)) {
    if (style.level !== null) mapping[value] = style.level;
  }
  return mapping;
}

/** Dashboard value colors layered over the global ones. */
export function resolveValueColors(
  styles: GlobalValueStyles,
  overrides: Record<string, string>
): Record<string, string> {
  const colors: Record<string, string> = {};
  for (const [value, style] of Object.entries(styles)) {
    if (style.color) colors[value] = style.color;
  }
  for (const [value, color] of Object.entries(overrides)) {
    if (color) colors[value] = color;
  }
  return colors;
}

/** Every value that has either a global style or a dashboard-level mapping. */
export function knownValues(
  styles: GlobalValueStyles,
  ...mappings: Array<Record<string, unknown>>
): string[] {
  const values = new Set(Object.keys(styles));
  mappings.forEach((mapping) => Object.keys(mapping).forEach((value) => values.add(value)));
  return Array.from(values).sort((first, second) =>
    first.localeCompare(second, undefined, { numeric: true, sensitivity: "base" })
  );
}
