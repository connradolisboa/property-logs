export interface HistorySource {
  historyKey: string;
  dateKey: string;
}

const KNOWN_HISTORY_SOURCES: HistorySource[] = [
  { historyKey: "statusHistory", dateKey: "dateSet" },
  { historyKey: "property_history", dateKey: "dateSet" },
  { historyKey: "status_history", dateKey: "dateSet" },
  { historyKey: "propertyLogs", dateKey: "dateLog" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalEntry(entry: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(entry).sort(([first], [second]) => first.localeCompare(second))
  ));
}

/**
 * Returns a read-only, normalized view of current and legacy Property Logs data.
 * The configured source remains first and remains the only write destination.
 */
export function collectCompatibleHistory(
  frontmatter: Record<string, unknown>,
  configuredHistoryKey: string,
  configuredDateKey: string
): unknown {
  const sources = [
    { historyKey: configuredHistoryKey, dateKey: configuredDateKey },
    ...KNOWN_HISTORY_SOURCES,
  ].filter((source, index, all) =>
    source.historyKey.trim()
    && source.dateKey.trim()
    && all.findIndex((candidate) =>
      candidate.historyKey === source.historyKey && candidate.dateKey === source.dateKey
    ) === index
  );

  const entries: unknown[] = [];
  const seenEntries = new Set<string>();
  let foundArray = false;

  for (const source of sources) {
    const rawHistory = frontmatter[source.historyKey];
    if (!Array.isArray(rawHistory)) continue;
    foundArray = true;

    for (const rawEntry of rawHistory) {
      if (!isRecord(rawEntry)) {
        entries.push(rawEntry);
        continue;
      }

      const normalized = { ...rawEntry };
      const dateValue = rawEntry[source.dateKey] ?? rawEntry[configuredDateKey];
      if (dateValue !== undefined) normalized[configuredDateKey] = dateValue;
      if (source.dateKey !== configuredDateKey) delete normalized[source.dateKey];

      const signature = canonicalEntry(normalized);
      if (seenEntries.has(signature)) continue;
      seenEntries.add(signature);
      entries.push(normalized);
    }
  }

  return foundArray ? entries : frontmatter[configuredHistoryKey];
}

export function historyContainsKey(history: unknown, key: string): boolean {
  return Array.isArray(history) && history.some((entry) =>
    isRecord(entry) && Object.prototype.hasOwnProperty.call(entry, key)
  );
}
