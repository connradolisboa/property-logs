import { PeriodGranularity, isPeriodGranularity, parseDateString } from "./periodic";

export interface EmbedOptions {
  /** Dashboard name or id. Empty means the first configured dashboard. */
  dashboard: string;
  /** Explicit anchor date; null means "use the note's own period". */
  date: Date | null;
  /** Forces the period type instead of reading it from the note. */
  period: PeriodGranularity | null;
  /** Visible calendar span in days; null means the default for the period type. */
  windowDays: number | null;
  /** Maximum pixel height of the embedded timeline. */
  height: number | null;
  /** Draws the slim header with the dashboard name and zoom controls. */
  header: boolean;
  /** Shrinks the whole embed (no header, tighter rows, smaller text) for a low-profile footprint. */
  minimal: boolean;
  errors: string[];
}

const DURATION = /^(\d+(?:\.\d+)?)\s*(d|w|m|q|y|days?|weeks?|months?|quarters?|years?)$/i;

const DURATION_DAYS: Record<string, number> = {
  d: 1,
  w: 7,
  m: 30.44,
  q: 91.31,
  y: 365.25,
};

function parseDuration(value: string): number | null {
  const match = DURATION.exec(value.trim());
  if (!match) return null;
  const unit = match[2][0].toLowerCase();
  const days = Number(match[1]) * (DURATION_DAYS[unit] ?? 1);
  return days >= 1 ? Math.round(days) : null;
}

function parseBoolean(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "on", "1", "show"].includes(normalized)) return true;
  if (["false", "no", "off", "0", "hide", "none"].includes(normalized)) return false;
  return null;
}

/**
 * Parses the body of a ```property-logs code block. Unknown keys are reported
 * rather than ignored, so a typo in an embedded note is visible.
 */
export function parseEmbedOptions(source: string): EmbedOptions {
  const options: EmbedOptions = {
    dashboard: "",
    date: null,
    period: null,
    windowDays: null,
    height: null,
    header: true,
    minimal: false,
    errors: [],
  };

  source.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) return;
    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      options.errors.push(`Could not read "${trimmed}". Use key: value.`);
      return;
    }
    const key = trimmed.slice(0, separator).trim().toLowerCase();
    const value = trimmed.slice(separator + 1).trim();
    if (!value) return;

    switch (key) {
      case "dashboard":
        options.dashboard = value;
        break;
      case "date": {
        if (value.toLowerCase() === "auto") break;
        if (value.toLowerCase() === "today") {
          options.date = new Date();
          break;
        }
        const date = parseDateString(value);
        if (date) options.date = date;
        else options.errors.push(`"${value}" is not a YYYY-MM-DD date.`);
        break;
      }
      case "period": {
        if (value.toLowerCase() === "auto") break;
        if (isPeriodGranularity(value.toLowerCase())) {
          options.period = value.toLowerCase() as PeriodGranularity;
        } else {
          options.errors.push(`"${value}" is not a period type (day, week, month, quarter, year).`);
        }
        break;
      }
      case "zoom": {
        if (value.toLowerCase() === "auto") break;
        const duration = parseDuration(value);
        if (duration !== null) {
          options.windowDays = duration;
          break;
        }
        const plain = Number(value);
        if (Number.isFinite(plain) && plain >= 1) {
          options.windowDays = Math.round(plain);
          break;
        }
        options.errors.push(`"${value}" is not a zoom span such as 30d, 6w, or 1y.`);
        break;
      }
      case "height": {
        const height = Number(value.replace(/px$/i, ""));
        if (Number.isFinite(height) && height >= 80) options.height = Math.round(height);
        else options.errors.push(`"${value}" is not a height in pixels (minimum 80).`);
        break;
      }
      case "header": {
        const header = parseBoolean(value);
        if (header === null) options.errors.push(`"${value}" is not true or false.`);
        else options.header = header;
        break;
      }
      case "minimal": {
        const minimal = parseBoolean(value);
        if (minimal === null) options.errors.push(`"${value}" is not true or false.`);
        else options.minimal = minimal;
        break;
      }
      default:
        options.errors.push(`Unknown option "${key}".`);
    }
  });

  return options;
}
