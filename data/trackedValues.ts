/**
 * A frontmatter value as Property Logs compares and records it, or undefined
 * when the property is missing or empty (`status:`, `""`, `[]`).
 */
export function trackedValue(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw);
  return value === "" ? undefined : value;
}

export type TrackedOutcome = "unchanged" | "baseline" | "changed";

/**
 * What a property's current value means against what was last seen of the note.
 * A value is a change when it replaces a different one, or fills in a property
 * the note was last seen without. Otherwise it is the first sight of the note,
 * and the value only becomes the baseline.
 */
export function compareTracked(current: string, previous: string | undefined, seenWithout: boolean): TrackedOutcome {
  if (current === previous) return "unchanged";
  return previous !== undefined || seenWithout ? "changed" : "baseline";
}

function isAtOrInside(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

/**
 * Moves the entries for a renamed note, or for every note inside a renamed
 * folder, to their new paths. Returns whether anything moved.
 */
export function moveTrackedPaths<T>(map: Map<string, T>, oldPath: string, newPath: string): boolean {
  if (oldPath === newPath) return false;
  const moved = [...map].filter(([path]) => isAtOrInside(path, oldPath));
  for (const [path] of moved) map.delete(path);
  for (const [path, value] of moved) map.set(newPath + path.slice(oldPath.length), value);
  return moved.length > 0;
}

/** Drops the entries for a deleted note, or for every note inside a deleted folder. */
export function forgetTrackedPaths<T>(map: Map<string, T>, path: string): boolean {
  let forgot = false;
  for (const key of [...map.keys()]) {
    if (isAtOrInside(key, path)) {
      map.delete(key);
      forgot = true;
    }
  }
  return forgot;
}
