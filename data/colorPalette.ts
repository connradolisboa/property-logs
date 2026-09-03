import type { TimelineLevel } from "./historyParser";

export const COLOR_PALETTE = [
  { id: "slate", label: "Slate" },
  { id: "red", label: "Red" },
  { id: "orange", label: "Orange" },
  { id: "amber", label: "Amber" },
  { id: "green", label: "Green" },
  { id: "teal", label: "Teal" },
  { id: "blue", label: "Blue" },
  { id: "purple", label: "Purple" },
  { id: "pink", label: "Pink" },
] as const;

export type PaletteColorId = typeof COLOR_PALETTE[number]["id"];
export type PaletteColorValue = `palette:${PaletteColorId}`;

export const DEFAULT_LEVEL_COLORS: Record<TimelineLevel, PaletteColorValue> = {
  0: "palette:slate",
  1: "palette:red",
  2: "palette:amber",
  3: "palette:blue",
  4: "palette:green",
};

export const DEFAULT_PROPERTY_COLOR: PaletteColorValue = "palette:blue";

export function paletteValue(id: PaletteColorId): PaletteColorValue {
  return `palette:${id}`;
}

export function paletteId(value: string): PaletteColorId | null {
  if (!value.startsWith("palette:")) return null;
  const id = value.slice("palette:".length);
  return COLOR_PALETTE.some((color) => color.id === id)
    ? id as PaletteColorId
    : null;
}

export function isLegacyHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value);
}

export function isSupportedTimelineColor(value: string): boolean {
  return paletteId(value) !== null || isLegacyHexColor(value);
}

export function normalizeTimelineColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return isSupportedTimelineColor(trimmed) ? trimmed : fallback;
}

export function paletteCssColor(value: string): string | null {
  const id = paletteId(value);
  return id ? `var(--property-logs-palette-${id})` : null;
}

export function timelineColorStyle(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const id = paletteId(value);
  if (id) {
    return [
      `--property-logs-segment-color: var(--property-logs-palette-${id})`,
      `--property-logs-segment-text-color: var(--property-logs-palette-${id}-text)`,
    ].join("; ");
  }
  return isLegacyHexColor(value)
    ? `--property-logs-segment-color: ${value}`
    : undefined;
}
