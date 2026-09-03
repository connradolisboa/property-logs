import { isSupportedTimelineColor } from "./colorPalette";

export type TimelineLevel = 0 | 1 | 2 | 3 | 4;

export type TimelineColorMode = "level" | "property";

export type HistoryParserIssueCode =
  | "history-not-array"
  | "entry-not-object"
  | "missing-date"
  | "invalid-date"
  | "future-date"
  | "invalid-value"
  | "invalid-level"
  | "unmapped-color";

export interface HistoryParserIssue {
  code: HistoryParserIssueCode;
  message: string;
  entryIndex?: number;
}

export interface TimelineSegment {
  start: Date;
  end: Date;
  value: string | null;
  level: TimelineLevel;
  color?: string;
  implicit: boolean;
  sourceIndex?: number;
}

export interface HistoryParserOptions {
  /** The configured history array read from Obsidian's metadata cache. */
  history: unknown;
  /** The resolved history-entry key, such as `relevantSet`. */
  trackedHistoryKey: string;
  dateKey: string;
  creationDate: Date | number | string;
  today: Date | number | string;
  levelMapping: Record<string, number>;
  defaultLevelForUnset: TimelineLevel;
  unmappedValueLevel: TimelineLevel;
  colorMode: TimelineColorMode;
  levelColors: Partial<Record<TimelineLevel, string>>;
  colorPropertyValue?: unknown;
  colorPropertyMap: Record<string, string>;
}

export interface HistoryParserResult {
  segments: TimelineSegment[];
  issues: HistoryParserIssue[];
  /** True when at least one entry owns the tracked key, even if that entry is malformed. */
  hasTrackedHistory: boolean;
  malformed: boolean;
  currentValue: string | null;
  currentLevel: TimelineLevel;
}

interface ParsedChange {
  date: Date;
  value: string;
  sourceIndex: number;
}

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function parseDate(value: Date | number | string): Date | null {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }

  if (typeof value === "number") {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

function normalizeScalar(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return null;
}

function resolveLevel(
  value: string,
  options: HistoryParserOptions,
  issues: HistoryParserIssue[],
  entryIndex?: number
): TimelineLevel {
  if (!hasOwn(options.levelMapping, value)) return options.unmappedValueLevel;

  const configuredLevel = options.levelMapping[value];
  if (
    Number.isInteger(configuredLevel) &&
    configuredLevel >= 0 &&
    configuredLevel <= 4
  ) {
    return configuredLevel as TimelineLevel;
  }

  issues.push({
    code: "invalid-level",
    entryIndex,
    message: `Value "${value}" has an invalid configured level; using the unmapped-value level.`,
  });
  return options.unmappedValueLevel;
}

function resolvePropertyColorKey(
  value: unknown,
  colorPropertyMap: Record<string, string>
): string | null {
  if (Array.isArray(value)) {
    const candidates = value
      .map(normalizeScalar)
      .filter((candidate): candidate is string => candidate !== null);
    return candidates.find((candidate) => hasOwn(colorPropertyMap, candidate))
      ?? candidates[0]
      ?? null;
  }
  return normalizeScalar(value);
}

function resolveColor(
  level: TimelineLevel,
  options: HistoryParserOptions,
  issues: HistoryParserIssue[],
  entryIndex?: number
): string | undefined {
  if (options.colorMode === "level") {
    const color = options.levelColors[level]?.trim();
    if (color && isSupportedTimelineColor(color)) return color;
    issues.push({
      code: "unmapped-color",
      entryIndex,
      message: `Level ${level} does not have a configured color.`,
    });
    return undefined;
  }

  const colorKey = resolvePropertyColorKey(
    options.colorPropertyValue,
    options.colorPropertyMap
  );
  const color = colorKey === null
    ? undefined
    : options.colorPropertyMap[colorKey]?.trim();
  if (color && isSupportedTimelineColor(color)) return color;

  issues.push({
    code: "unmapped-color",
    entryIndex,
    message: colorKey === null
      ? "The note does not have a usable color-property value."
      : `Color-property value "${colorKey}" does not have a configured color.`,
  });
  return undefined;
}

/**
 * Reconstructs visible timeline segments from cached frontmatter history.
 *
 * This function is deliberately independent of Obsidian. The view is responsible
 * for reading metadata-cache values and resolving a frontmatter property such as
 * `relevant` to its configured history key such as `relevantSet`.
 */
export function reconstructHistorySegments(
  options: HistoryParserOptions
): HistoryParserResult {
  const issues: HistoryParserIssue[] = [];
  const today = parseDate(options.today);
  const creationDate = parseDate(options.creationDate);

  if (!today) {
    throw new Error("History parser requires a valid `today` date.");
  }
  if (!creationDate) {
    throw new Error("History parser requires a valid note creation date.");
  }
  if (!options.trackedHistoryKey.trim()) {
    throw new Error("History parser requires a tracked history key.");
  }
  if (!options.dateKey.trim()) {
    throw new Error("History parser requires a date key.");
  }

  if (options.history !== undefined && options.history !== null && !Array.isArray(options.history)) {
    issues.push({
      code: "history-not-array",
      message: "The configured history property is not an array.",
    });
    return {
      segments: [],
      issues,
      hasTrackedHistory: false,
      malformed: true,
      currentValue: null,
      currentLevel: options.defaultLevelForUnset,
    };
  }

  const rawHistory = Array.isArray(options.history) ? options.history : [];
  const changes: ParsedChange[] = [];
  let hasTrackedHistory = false;

  rawHistory.forEach((rawEntry, entryIndex) => {
    if (!isRecord(rawEntry)) {
      issues.push({
        code: "entry-not-object",
        entryIndex,
        message: `History entry ${entryIndex + 1} is not an object.`,
      });
      return;
    }

    if (!hasOwn(rawEntry, options.trackedHistoryKey)) return;
    hasTrackedHistory = true;

    if (!hasOwn(rawEntry, options.dateKey)) {
      issues.push({
        code: "missing-date",
        entryIndex,
        message: `History entry ${entryIndex + 1} has "${options.trackedHistoryKey}" but no "${options.dateKey}".`,
      });
      return;
    }

    const dateValue = rawEntry[options.dateKey];
    const date = dateValue instanceof Date || typeof dateValue === "number" || typeof dateValue === "string"
      ? parseDate(dateValue)
      : null;
    if (!date) {
      issues.push({
        code: "invalid-date",
        entryIndex,
        message: `History entry ${entryIndex + 1} has an invalid "${options.dateKey}" date.`,
      });
      return;
    }
    if (date.getTime() > today.getTime()) {
      issues.push({
        code: "future-date",
        entryIndex,
        message: `History entry ${entryIndex + 1} is dated after today.`,
      });
      return;
    }

    const value = normalizeScalar(rawEntry[options.trackedHistoryKey]);
    if (value === null) {
      issues.push({
        code: "invalid-value",
        entryIndex,
        message: `History entry ${entryIndex + 1} has a non-scalar "${options.trackedHistoryKey}" value.`,
      });
      return;
    }

    changes.push({ date, value, sourceIndex: entryIndex });
  });

  changes.sort((a, b) =>
    a.date.getTime() - b.date.getTime() || a.sourceIndex - b.sourceIndex
  );

  const segments: TimelineSegment[] = [];
  let currentValue: string | null = null;
  let currentLevel = options.defaultLevelForUnset;
  if (!hasTrackedHistory) {
    const level = options.defaultLevelForUnset;
    if (level !== 0) {
      segments.push({
        start: creationDate,
        end: today,
        value: null,
        level,
        color: resolveColor(level, options, issues),
        implicit: true,
      });
    }
  } else {
    changes.forEach((change, index) => {
      const level = resolveLevel(change.value, options, issues, change.sourceIndex);
      if (index === changes.length - 1) {
        currentValue = change.value;
        currentLevel = level;
      }
      if (level === 0) return;

      segments.push({
        start: change.date,
        end: changes[index + 1]?.date ?? today,
        value: change.value,
        level,
        color: resolveColor(level, options, issues, change.sourceIndex),
        implicit: false,
        sourceIndex: change.sourceIndex,
      });
    });
  }

  return {
    segments,
    issues,
    hasTrackedHistory,
    malformed: issues.some((issue) => issue.code !== "unmapped-color"),
    currentValue,
    currentLevel,
  };
}
