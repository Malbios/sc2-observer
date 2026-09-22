/**
 * Acting on a game file from the catalog rather than from the viewer: tagging
 * it, and copying it somewhere else.
 *
 * Like `peek`, none of this goes through `HistoryStore`, which would migrate
 * the file it was handed. A tag is a `meta` upsert and an export is a file
 * copy; neither is a reason to rewrite someone's schema.
 *
 * Deleting is deliberately not here: it belongs to the process that can put
 * files in the recycle bin instead of unlinking them.
 */
import { copyFileSync, existsSync } from "node:fs";
import Database from "better-sqlite3";
import { replayPathFor } from "./gameFiles";

/**
 * Tags as they get stored: trimmed, empties dropped, and no two that differ
 * only in case. Order is the order they were given, because a person typing
 * "ladder, bug, zerg" means that list, not an alphabetical one.
 */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

/**
 * Writes the tags into the game's own `meta`, which is what makes them
 * survive the file being copied to another machine. Throws if the file cannot
 * be opened; the caller turns that into a message on the row.
 */
export function writeGameTags(filePath: string, tags: readonly string[]): string[] {
  const normalized = normalizeTags(tags);
  const db = new Database(filePath, { fileMustExist: true });
  try {
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      "tags",
      JSON.stringify(normalized),
    );
  } finally {
    db.close();
  }
  return normalized;
}

/**
 * Copies a game and its replay to a new path.
 *
 * The database is checkpointed first. Under WAL, rows live in the `-wal`
 * sidecar until something folds them into the main file, so copying the
 * `.sqlite` alone can hand someone a game missing its last minutes. A
 * TRUNCATE checkpoint folds them in, which makes the copy a single whole
 * file rather than a set the user has to keep together.
 *
 * Returns whether a replay went with it, so the caller can say "game and
 * replay" or just "game".
 */
export function exportGameTo(filePath: string, destination: string): boolean {
  const db = new Database(filePath, { fileMustExist: true });
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  copyFileSync(filePath, destination);

  const replay = replayPathFor(filePath);
  if (!existsSync(replay)) return false;
  copyFileSync(replay, replayPathFor(destination));
  return true;
}
