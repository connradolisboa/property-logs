import type { TimelineColorMode, TimelineLevel } from "./historyParser";
import {
  DEFAULT_LEVEL_COLORS,
  DEFAULT_PROPERTY_COLOR,
  normalizeTimelineColor,
} from "./colorPalette";

export interface DashboardPropertyRule {
  key: string;
  value: string;
}

export interface DashboardScopeFilter {
  includedFolders: string[];
  includedTags: string[];
  includedProperties: DashboardPropertyRule[];
  excludedFolders: string[];
  excludedTags: string[];
  excludedProperties: DashboardPropertyRule[];
}

export type DashboardGroupBy = "status" | "none" | "folder" | "level" | `property:${string}`;
export type DashboardSortBy = "alphabetical" | "level" | "recent" | `property:${string}`;
export type NoteOpenGesture = "click" | "ctrl-click";

export interface DashboardSettings {
  id: string;
  name: string;
  trackedPropertyKey: string;
  levelMapping: Record<string, TimelineLevel>;
  defaultLevelForUnset: TimelineLevel;
  unmappedValueLevel: TimelineLevel;
  colorMode: TimelineColorMode;
  levelColors: Record<TimelineLevel, string>;
  colorProperty: string;
  colorPropertyMap: Record<string, string>;
  scopeFilter: DashboardScopeFilter;
  rowProperties: string[];
  groupBy: DashboardGroupBy;
  sortBy: DashboardSortBy;
  sortAscending: boolean;
  noteOpenGesture: NoteOpenGesture;
}

export interface DashboardFileData {
  path: string;
  tags: Set<string>;
  frontmatter?: Record<string, unknown>;
}

const EMPTY_SCOPE: DashboardScopeFilter = {
  includedFolders: [],
  includedTags: [],
  includedProperties: [],
  excludedFolders: [],
  excludedTags: [],
  excludedProperties: [],
};

function level(value: unknown, fallback: TimelineLevel): TimelineLevel {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 4
    ? Number(value) as TimelineLevel
    : fallback;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function rules(value: unknown): DashboardPropertyRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.key !== "string") return [];
    return [{
      key: record.key,
      value: typeof record.value === "string" ? record.value : "",
    }];
  });
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function levelMap(value: unknown): Record<string, TimelineLevel> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, TimelineLevel> = {};
  for (const [key, rawLevel] of Object.entries(value as Record<string, unknown>)) {
    if (Number.isInteger(rawLevel) && Number(rawLevel) >= 0 && Number(rawLevel) <= 4) {
      result[key] = Number(rawLevel) as TimelineLevel;
    }
  }
  return result;
}

export function createDashboardSettings(id: string, name = "Dashboard"): DashboardSettings {
  return {
    id,
    name,
    trackedPropertyKey: "status",
    levelMapping: {},
    defaultLevelForUnset: 0,
    unmappedValueLevel: 0,
    colorMode: "level",
    levelColors: { ...DEFAULT_LEVEL_COLORS },
    colorProperty: "tags",
    colorPropertyMap: {},
    scopeFilter: {
      includedFolders: [...EMPTY_SCOPE.includedFolders],
      includedTags: [...EMPTY_SCOPE.includedTags],
      includedProperties: [...EMPTY_SCOPE.includedProperties],
      excludedFolders: [...EMPTY_SCOPE.excludedFolders],
      excludedTags: [...EMPTY_SCOPE.excludedTags],
      excludedProperties: [...EMPTY_SCOPE.excludedProperties],
    },
    rowProperties: [],
    groupBy: "status",
    sortBy: "alphabetical",
    sortAscending: true,
    noteOpenGesture: "ctrl-click",
  };
}

export function normalizeDashboardSettings(
  raw: unknown,
  fallbackId: string,
  fallbackName: string
): DashboardSettings {
  const defaults = createDashboardSettings(fallbackId, fallbackName);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaults;

  const value = raw as Record<string, unknown>;
  const rawScope = value.scopeFilter && typeof value.scopeFilter === "object" && !Array.isArray(value.scopeFilter)
    ? value.scopeFilter as Record<string, unknown>
    : {};
  const rawLevelColors = stringMap(value.levelColors);
  const groupBy = typeof value.groupBy === "string" && (
    value.groupBy === "status" ||
    value.groupBy === "none" ||
    value.groupBy === "folder" ||
    value.groupBy === "level" ||
    value.groupBy.startsWith("property:")
  ) ? value.groupBy as DashboardGroupBy : defaults.groupBy;
  const sortBy = typeof value.sortBy === "string" && (
    value.sortBy === "alphabetical" ||
    value.sortBy === "level" ||
    value.sortBy === "recent" ||
    value.sortBy.startsWith("property:")
  ) ? value.sortBy as DashboardSortBy : defaults.sortBy;

  return {
    id: typeof value.id === "string" && value.id ? value.id : defaults.id,
    name: typeof value.name === "string" && value.name ? value.name : defaults.name,
    trackedPropertyKey: typeof value.trackedPropertyKey === "string"
      ? value.trackedPropertyKey
      : defaults.trackedPropertyKey,
    levelMapping: levelMap(value.levelMapping),
    defaultLevelForUnset: level(value.defaultLevelForUnset, defaults.defaultLevelForUnset),
    unmappedValueLevel: level(value.unmappedValueLevel, defaults.unmappedValueLevel),
    colorMode: value.colorMode === "property" ? "property" : "level",
    levelColors: {
      0: normalizeTimelineColor(rawLevelColors["0"], DEFAULT_LEVEL_COLORS[0]),
      1: normalizeTimelineColor(rawLevelColors["1"], DEFAULT_LEVEL_COLORS[1]),
      2: normalizeTimelineColor(rawLevelColors["2"], DEFAULT_LEVEL_COLORS[2]),
      3: normalizeTimelineColor(rawLevelColors["3"], DEFAULT_LEVEL_COLORS[3]),
      4: normalizeTimelineColor(rawLevelColors["4"], DEFAULT_LEVEL_COLORS[4]),
    },
    colorProperty: typeof value.colorProperty === "string"
      ? value.colorProperty
      : defaults.colorProperty,
    colorPropertyMap: Object.fromEntries(
      Object.entries(stringMap(value.colorPropertyMap)).map(([key, color]) => [
        key,
        normalizeTimelineColor(color, DEFAULT_PROPERTY_COLOR),
      ])
    ),
    scopeFilter: {
      includedFolders: strings(rawScope.includedFolders),
      includedTags: strings(rawScope.includedTags),
      includedProperties: rules(rawScope.includedProperties),
      excludedFolders: strings(rawScope.excludedFolders),
      excludedTags: strings(rawScope.excludedTags),
      excludedProperties: rules(rawScope.excludedProperties),
    },
    rowProperties: strings(value.rowProperties),
    groupBy,
    sortBy,
    sortAscending: typeof value.sortAscending === "boolean" ? value.sortAscending : true,
    noteOpenGesture: value.noteOpenGesture === "click" ? "click" : "ctrl-click",
  };
}

function folderMatches(path: string, folders: string[]): boolean {
  const slash = path.lastIndexOf("/");
  const folder = slash === -1 ? "" : path.slice(0, slash);
  return folders.some((candidate) => {
    const normalized = candidate.replace(/^\/+|\/+$/g, "");
    return folder === normalized || folder.startsWith(`${normalized}/`);
  });
}

function scalarValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(scalarValues);
  if (typeof value === "string") return [value];
  if (typeof value === "number" && Number.isFinite(value)) return [String(value)];
  if (typeof value === "boolean") return [String(value)];
  return [];
}

function propertyRuleMatches(
  frontmatter: Record<string, unknown> | undefined,
  rule: DashboardPropertyRule
): boolean {
  const key = rule.key.trim();
  if (!key || !frontmatter || !Object.prototype.hasOwnProperty.call(frontmatter, key)) return false;
  if (!rule.value.trim()) return frontmatter[key] !== null && frontmatter[key] !== undefined;
  return scalarValues(frontmatter[key]).includes(rule.value.trim());
}

/** Exclusions always win. Active inclusion categories are ANDed; values within a category are ORed. */
export function isFileInDashboardScope(
  file: DashboardFileData,
  scope: DashboardScopeFilter
): boolean {
  const normalizedTags = new Set(Array.from(file.tags, (tag) => tag.replace(/^#/, "")));
  const excluded = folderMatches(file.path, scope.excludedFolders)
    || scope.excludedTags.some((tag) => normalizedTags.has(tag.replace(/^#/, "")))
    || scope.excludedProperties.some((rule) => propertyRuleMatches(file.frontmatter, rule));
  if (excluded) return false;

  const folderIncluded = scope.includedFolders.length === 0
    || folderMatches(file.path, scope.includedFolders);
  const tagIncluded = scope.includedTags.length === 0
    || scope.includedTags.some((tag) => normalizedTags.has(tag.replace(/^#/, "")));
  const propertyIncluded = scope.includedProperties.length === 0
    || scope.includedProperties.some((rule) => propertyRuleMatches(file.frontmatter, rule));

  return folderIncluded && tagIncluded && propertyIncluded;
}

export function displayPropertyValue(value: unknown): string {
  return scalarValues(value).join(", ");
}
