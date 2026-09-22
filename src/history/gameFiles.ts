/**
 * How a game's two files are named. This sits in `history/` rather than with
 * the session controller that writes them, because the catalog reads them and
 * pulling the session controller (and with it Docker and the proxy) into a
 * file listing would be the wrong dependency entirely.
 */

/**
 * A game file per game, named for when its first frame arrived and the map it
 * was played on. The map name loses its extension and anything that is not
 * alphanumeric, because it ends up in a file name on Windows.
 */
export function gameFileName(map: string, at: Date): string {
  const stamp = at.toISOString().replace("T", "_").replace(/[:.]/g, "-").slice(0, 19);
  const name = map.replace(/\.SC2Map$/i, "").replace(/[^A-Za-z0-9]+/g, "") || "game";
  return `${stamp}-${name}.sqlite`;
}

/** The replay lands beside its recording and shares its name, so a pair is
 * obvious from a directory listing. */
export function replayPathFor(gameFilePath: string): string {
  return gameFilePath.replace(/\.sqlite$/i, ".SC2Replay");
}

/** SQLite's WAL sidecars. They are part of the game on disk: a copy without
 * them can be missing the last rows, and a delete without them leaves the next
 * file of that name to inherit them. */
export function sidecarPathsFor(gameFilePath: string): string[] {
  return [`${gameFilePath}-wal`, `${gameFilePath}-shm`];
}

/**
 * Every file that is part of one game, in the order a delete should take
 * them: the sidecars before the database they belong to, so a delete
 * interrupted half way leaves a game that still opens rather than a database
 * whose WAL outlived it.
 *
 * Which of these exist is the caller's problem; this says what to look for.
 */
export function gameFilesFor(gameFilePath: string): string[] {
  return [...sidecarPathsFor(gameFilePath), gameFilePath, replayPathFor(gameFilePath)];
}
