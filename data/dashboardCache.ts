import type { TFile } from "obsidian";

interface ScanEntry {
  generation: number;
  value: unknown;
}

interface FileEntry {
  mtime: number;
  key: string;
  value: unknown;
}

/**
 * Memoizes the vault work a dashboard would otherwise redo on every render.
 *
 * Two kinds of result live here. Vault-wide scans — which files a scope holds,
 * which properties they carry — stay valid until anything in the vault
 * changes, so they carry a generation that every invalidation bumps: several
 * embeds on one page then share a single walk instead of taking one each, and
 * the second pass a render makes for its journal notes reuses the first.
 *
 * Per-file results — a parsed history, a file's scope data — survive edits to
 * every other file, so they carry the mtime and the settings signature they
 * were computed under and are dropped one path at a time.
 */
export class DashboardDataCache {
  private generation = 0;
  private readonly scans = new Map<string, ScanEntry>();
  private readonly files = new Map<string, Map<string, FileEntry>>();

  /** Everything is stale: the file list changed, or a setting behind it did. */
  invalidateAll(): void {
    this.generation++;
    this.scans.clear();
    this.files.clear();
  }

  /** One note changed: its own results go, the vault-wide scans go, the rest stays. */
  invalidateFile(path: string): void {
    this.generation++;
    this.scans.clear();
    this.files.delete(path);
  }

  /** A vault-wide result, recomputed once per change to the vault. */
  scan<T>(key: string, compute: () => T): T {
    const cached = this.scans.get(key);
    if (cached && cached.generation === this.generation) return cached.value as T;
    const value = compute();
    this.scans.set(key, { generation: this.generation, value });
    return value;
  }

  /** A per-file result, recomputed when that file is written or `key` changes. */
  forFile<T>(namespace: string, file: TFile, key: string, compute: () => T): T {
    let entries = this.files.get(file.path);
    const cached = entries?.get(namespace);
    if (cached && cached.mtime === file.stat.mtime && cached.key === key) return cached.value as T;
    const value = compute();
    if (!entries) {
      entries = new Map<string, FileEntry>();
      this.files.set(file.path, entries);
    }
    entries.set(namespace, { mtime: file.stat.mtime, key, value });
    return value;
  }
}
