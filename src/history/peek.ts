/**
 * Reading a game file without opening it as a recording (§6.4).
 *
 * `new HistoryStore(path)` is the wrong tool for a listing: it creates the
 * file if it is missing, migrates it to the current schema, and throws on a
 * file stamped newer than this build. Listing fifty games through it would
 * rewrite all fifty and die on the first one it could not understand, which is
 * exactly the game the catalog exists to show.
 *
 * So a peek opens the file itself, reads what it needs, and closes it. It
 * still opens read-write, which sounds wrong and is not: a game whose writer
 * was killed leaves an orphaned `-wal`, and the first connection afterwards
 * has to *recover* it, which is a write. A `{readonly: true}` handle fails
 * with SQLITE_READONLY_RECOVERY on precisely the incomplete games this list is
 * supposed to surface.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import type { GameFileState, GameSummaryIpc } from "../shared/ipc-types";
import { replayPathFor } from "./gameFiles";
import { describeOutcome } from "./outcome";
import { SCHEMA_VERSION } from "./HistoryStore";

/** A game file and everything beside it that belongs to it. A live game keeps
 * most of itself in the WAL, so the main file's size alone would report a
 * game in progress as a few empty pages. */
function sizeOnDisk(filePath: string): number {
  let total = 0;
  for (const path of [filePath, `${filePath}-wal`]) {
    try {
      total += statSync(path).size;
    } catch {
      // Missing sidecars are the normal case; a missing main file is caught
      // by the open below.
    }
  }
  return total;
}

function emptyRow(filePath: string, state: GameFileState, problem: string | null): GameSummaryIpc {
  return {
    filePath,
    fileName: basename(filePath),
    state,
    problem,
    sizeBytes: sizeOnDisk(filePath),
    map: null,
    mode: null,
    source: null,
    startedAt: null,
    endedAt: null,
    result: null,
    outcome: null,
    endReason: null,
    maxLoop: null,
    botNames: [],
    tags: [],
    hasReplay: existsSync(replayPathFor(filePath)),
    gameId: null,
  };
}

/** Tags are a JSON array in `meta` so they travel with the game (§6.4 wants
 * them searchable; a tag that lives only in a catalog is lost the moment the
 * file is copied to another machine). Anything else in that key is ignored
 * rather than shown as a broken row. */
function parseTags(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((tag): tag is string => typeof tag === "string");
  } catch {
    return [];
  }
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return row !== undefined;
}

function maxLoopIn(db: Database.Database, table: string): number | null {
  if (!tableExists(db, table)) return null;
  const row = db.prepare(`SELECT MAX(loop) AS loop FROM ${table}`).get() as { loop: number | null };
  return row.loop;
}

/**
 * One row for one game file. Never throws: a file that cannot be read is a
 * row that says so.
 */
export function peekGame(filePath: string): GameSummaryIpc {
  let db: Database.Database;
  try {
    db = new Database(filePath, { fileMustExist: true });
  } catch (err) {
    return emptyRow(filePath, "unreadable", (err as Error).message);
  }

  try {
    if (!tableExists(db, "meta")) {
      return emptyRow(filePath, "unreadable", "no meta table: this is not a Spectator game file");
    }

    const meta = new Map<string, string>();
    for (const row of db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[]) {
      meta.set(row.key, row.value);
    }

    const row = emptyRow(filePath, "ok", null);
    row.map = meta.get("map") ?? null;
    row.mode = meta.get("mode") ?? null;
    row.source = meta.get("source") ?? null;
    row.startedAt = meta.get("started_at") ?? null;
    row.endedAt = meta.get("ended_at") ?? null;
    row.result = meta.get("result") ?? null;
    row.outcome = describeOutcome(meta);
    row.endReason = meta.get("end_reason") ?? null;
    row.gameId = meta.get("game_id") ?? null;
    row.tags = parseTags(meta.get("tags"));

    const version = Number(meta.get("schema_version") ?? 0);
    if (version > SCHEMA_VERSION) {
      // The tables this build does know about may mean something else in a
      // newer one, so nothing below `meta` is read. The row exists so the
      // file is visible and its reason is on it.
      row.state = "newer";
      row.problem = `written by a newer build (schema ${version}, this build understands ${SCHEMA_VERSION})`;
      return row;
    }

    // A `meta` table alone is not a game: the catalog file has one too, and so
    // would any database that happens to be called .sqlite. `frames` is
    // created by the first migration, so every game file has one even before
    // its first frame arrives. Checked after the version, so a newer build's
    // file is never called damaged for a table this build expects.
    if (!tableExists(db, "frames")) {
      return emptyRow(filePath, "unreadable", "no frames table: this is not a Spectator game file");
    }

    const frameLoop = maxLoopIn(db, "frames");
    const telemetryLoop = maxLoopIn(db, "telemetry");
    row.maxLoop =
      frameLoop === null && telemetryLoop === null ? null : Math.max(frameLoop ?? 0, telemetryLoop ?? 0);

    if (tableExists(db, "streams")) {
      const names = db.prepare("SELECT name FROM streams ORDER BY id").all() as { name: string }[];
      row.botNames = names.map((entry) => entry.name);
    }

    // §6.4: a game with no `ended_at` is listed as incomplete rather than
    // hidden or repaired. It is either being played right now or its writer
    // was killed, and the catalog cannot tell those apart from the file alone.
    if (!row.endedAt) row.state = "incomplete";
    return row;
  } catch (err) {
    return emptyRow(filePath, "unreadable", (err as Error).message);
  } finally {
    db.close();
  }
}

/** When a row belongs in the list, for a file that never got far enough to
 * record when it started. */
function sortKey(row: GameSummaryIpc): string {
  if (row.startedAt) return row.startedAt;
  try {
    return statSync(row.filePath).mtime.toISOString();
  } catch {
    return "";
  }
}

/**
 * Every game in a folder, newest first.
 *
 * The folder is read on every call rather than cached. Games arrive from
 * outside the app (the `session` CLI writes wherever it is told, files get
 * deleted in Explorer), and under WAL there is no staleness key that works: a
 * game being played grows in its `-wal` while the `.sqlite`'s size and mtime
 * never move. A cache with no key is not a cache. A peek is an index seek and
 * a handful of small reads; if a folder ever gets big enough for that to
 * matter, a cache goes behind this same signature, measured rather than
 * assumed.
 */
export function listGames(dir: string): GameSummaryIpc[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // A games folder that does not exist yet is an empty list, not an error:
    // it is the normal state before the first session.
    return [];
  }

  const rows = names
    .filter((name) => name.toLowerCase().endsWith(".sqlite"))
    .map((name) => peekGame(join(dir, name)));
  return rows.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
}
