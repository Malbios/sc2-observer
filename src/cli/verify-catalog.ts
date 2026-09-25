/**
 * Checks the catalog's reader against real files in a temp folder.
 *
 * The listing is the one place in the app that opens files it did not write
 * and cannot assume anything about, so every way a game file can be
 * disappointing is a case here: written by a newer build, not a database at
 * all, never finished, still being written, or left with an orphaned WAL by a
 * writer that was killed. §6.4 wants all of those *listed*, not hidden and not
 * thrown, because they are the games most worth finding.
 *
 * Run with: node dist/cli/verify-catalog.js
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { CatalogStore } from "../history/CatalogStore";
import { exportGameTo, normalizeTags, writeGameTags } from "../history/manage";
import { HistoryStore, SCHEMA_VERSION } from "../history/HistoryStore";
import { listGames, peekGame } from "../history/peek";
import { gameFilesFor, replayPathFor } from "../history/gameFiles";
import { StreamIngest } from "../telemetry/ingest";
import { TELEMETRY_SCHEMA_VERSION } from "../shared/telemetry-types";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "ok  " : "FAIL"} ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  if (!pass) failures++;
}

function checkThat(label: string, actual: boolean): void {
  check(label, actual, true);
}

const frame = (loop: number) => ({
  sessionId: "test",
  loop,
  kind: "observation" as const,
  direction: "response" as const,
  bytes: new Uint8Array([1, 2, 3]),
});

/** A finished game: meta, frames, one telemetry stream, closed properly. */
function writeFinishedGame(filePath: string, options: { map: string; startedAt: string; result: string }): void {
  const store = new HistoryStore(filePath);
  store.setMeta("map", options.map);
  store.setMeta("mode", "A");
  store.setMeta("started_at", options.startedAt);
  store.setMeta("game_id", `id-${path.basename(filePath)}`);
  store.setMeta("source", "live");
  store.createStream({ name: "testbot", sourcePath: "run.ndjson", emitter: null, meta: null, channels: null });
  for (let loop = 0; loop <= 400; loop += 100) store.recordFrame(frame(loop));
  store.setMeta("result", options.result);
  store.setMeta("end_reason", "result");
  store.setMeta("ended_at", options.startedAt);
  store.flush();
  store.close();
}

function main(): void {
  const dir = mkdtempSync(path.join(tmpdir(), "spectator-catalog-"));
  try {
    // -- a finished game ---------------------------------------------------
    {
      const file = path.join(dir, "2026-01-01_00-00-00-Torches.sqlite");
      writeFinishedGame(file, { map: "Torches.SC2Map", startedAt: "2026-01-01T00:00:00.000Z", result: "Victory" });
      writeFileSync(replayPathFor(file), Buffer.from([1, 2, 3, 4]));

      const row = peekGame(file);
      check("a finished game reads as ok", row.state, "ok");
      check("with no problem to report", row.problem, null);
      check("its map", row.map, "Torches.SC2Map");
      check("its result", row.result, "Victory");
      check("why it ended", row.endReason, "result");
      check("the bot that played it", row.botNames, ["testbot"]);
      check("its last loop", row.maxLoop, 400);
      check("its replay is beside it", row.hasReplay, true);
      checkThat("its size is the bytes on disk", row.sizeBytes >= statSync(file).size);

      // Opening a WAL database creates `-wal` and `-shm` beside it. Closing it
      // takes them away again, and a peek that did not would leave two extra
      // files per game in a folder it only meant to read.
      check("a peek leaves no sidecars behind", existsSync(`${file}-wal`) || existsSync(`${file}-shm`), false);
    }

    // -- a peek writes nothing ---------------------------------------------
    {
      // The whole reason peek exists: `new HistoryStore(path)` would create a
      // file that is not there and migrate one that is.
      const missing = path.join(dir, "not-a-game.sqlite");
      const row = peekGame(missing);
      check("a file that is not there is unreadable", row.state, "unreadable");
      checkThat("and says why", (row.problem ?? "").length > 0);
      check("and peeking did not create it", existsSync(missing), false);
    }

    // -- a file written by a newer build ------------------------------------
    {
      const file = path.join(dir, "2026-01-02_00-00-00-Future.sqlite");
      writeFinishedGame(file, { map: "Future.SC2Map", startedAt: "2026-01-02T00:00:00.000Z", result: "Defeat" });
      const db = new Database(file);
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION + 5));
      db.close();

      const row = peekGame(file);
      check("a newer file is listed, not thrown", row.state, "newer");
      checkThat("with the version on the row", (row.problem ?? "").includes(String(SCHEMA_VERSION + 5)));
      check("meta is still readable", row.map, "Future.SC2Map");

      // And the file is left exactly as it was found: a peek that "helpfully"
      // migrated it would make it unopenable by the build that wrote it.
      const after = new Database(file);
      const version = after.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
      after.close();
      check("a peek does not migrate it", version.value, String(SCHEMA_VERSION + 5));
    }

    // -- something that is not a database ----------------------------------
    {
      const file = path.join(dir, "2026-01-03_00-00-00-Garbage.sqlite");
      writeFileSync(file, "this is not a database, it is a text file\n");
      const row = peekGame(file);
      check("a file that is not a database is unreadable", row.state, "unreadable");
      checkThat("with a reason", (row.problem ?? "").length > 0);
    }

    // -- a database that is not a game file ---------------------------------
    {
      const file = path.join(dir, "2026-01-04_00-00-00-Empty.sqlite");
      const db = new Database(file);
      db.exec("CREATE TABLE something (x INTEGER)");
      db.close();
      const row = peekGame(file);
      check("a database with no meta table is unreadable", row.state, "unreadable");
    }

    // -- a game that is still being played ----------------------------------
    {
      const file = path.join(dir, "2026-01-05_00-00-00-Live.sqlite");
      const store = new HistoryStore(file);
      store.setMeta("map", "Live.SC2Map");
      store.setMeta("started_at", "2026-01-05T00:00:00.000Z");
      for (let loop = 0; loop <= 200; loop += 100) store.recordFrame(frame(loop));
      store.flush();

      // Peeked while the writer still holds it open, which is what the
      // catalog does to the game being played right now.
      const row = peekGame(file);
      check("a game with no ended_at is incomplete", row.state, "incomplete");
      check("and its flushed frames are visible", row.maxLoop, 200);
      check("with no result to show", row.result, null);

      // A live game lives in its WAL: the main file barely moves, which is
      // why the row's size counts the sidecar.
      checkThat("its size includes the WAL", row.sizeBytes > statSync(file).size);
      store.close();
    }

    // -- a writer that was killed, leaving an orphaned WAL -------------------
    {
      // Copying an open database and its WAL reproduces what a killed process
      // leaves behind: rows that exist only in the sidecar, and a main file
      // that no connection has checkpointed. The first reader has to recover
      // it, which is a write, which is why peek does not open read-only.
      // The source sits outside the listed folder, so only the copy is a row.
      const source = path.join(dir, "scratch", "killed-source.sqlite");
      const store = new HistoryStore(source);
      store.setMeta("map", "Killed.SC2Map");
      store.setMeta("started_at", "2026-01-06T00:00:00.000Z");
      for (let loop = 0; loop <= 300; loop += 100) store.recordFrame(frame(loop));
      store.flush();

      const orphan = path.join(dir, "2026-01-06_00-00-00-Killed.sqlite");
      copyFileSync(source, orphan);
      copyFileSync(`${source}-wal`, `${orphan}-wal`);
      store.close();

      checkThat("the copy really does carry an unchecked WAL", statSync(`${orphan}-wal`).size > 0);
      const row = peekGame(orphan);
      check("a killed game is listed", row.state, "incomplete");
      check("and the rows in its WAL are read", row.maxLoop, 300);

      // And it opens for real afterwards, which is the point of listing it.
      const reopened = new HistoryStore(orphan);
      check("it opens as a recording too", reopened.getMaxLoop(), 300);
      reopened.close();
    }

    // -- the listing --------------------------------------------------------
    {
      const rows = listGames(dir);
      const names = rows.map((row) => row.fileName);
      check("every game file in the folder is listed", names.length, 6);
      check("including the ones that could not be read", rows.filter((row) => row.state === "unreadable").length, 2);
      check("replays are not listed as games", names.filter((name) => name.endsWith(".SC2Replay")).length, 0);
      check("nor are WAL sidecars", names.filter((name) => name.includes("-wal")).length, 0);
      check("nor anything in a subfolder", names.filter((name) => name.includes("killed-source")).length, 0);

      // Files with no `started_at` have nothing to sort by but their mtime, so
      // only the dated ones can be asserted against each other.
      const dated = rows.filter((row) => row.startedAt).map((row) => row.startedAt!);
      check("games are listed newest first", dated, [...dated].sort().reverse());
      check("and all four dated games are there", dated.length, 4);
    }

    check("a folder that does not exist is an empty list", listGames(path.join(dir, "nope")), []);

    // -- tags travel with the game ------------------------------------------
    {
      const file = path.join(dir, "2026-01-01_00-00-00-Torches.sqlite");
      const store = new HistoryStore(file);
      store.setMeta("tags", JSON.stringify(["ladder", "zerg opener"]));
      store.close();
      check("tags come off the game file", peekGame(file).tags, ["ladder", "zerg opener"]);

      const broken = new Database(file);
      broken.prepare("UPDATE meta SET value = ? WHERE key = 'tags'").run("not json");
      broken.close();
      check("a tag value that is not a list is ignored, not fatal", peekGame(file).tags, []);
    }

    // -- tags as they are stored --------------------------------------------
    {
      check("tags are trimmed and emptied out", normalizeTags([" ladder ", "", "   "]), ["ladder"]);
      check("and deduplicated regardless of case", normalizeTags(["Bug", "bug", "BUG"]), ["Bug"]);
      check("in the order they were typed", normalizeTags(["zerg", "ladder", "bug"]), ["zerg", "ladder", "bug"]);

      const file = path.join(dir, "extra", "tagged.sqlite");
      writeFinishedGame(file, { map: "Tagged.SC2Map", startedAt: "2026-02-01T00:00:00.000Z", result: "Victory" });
      writeGameTags(file, ["  ladder", "Ladder", "bug "]);
      check("written tags come back off the file", peekGame(file).tags, ["ladder", "bug"]);
    }

    // -- a game whose telemetry outruns its frames ---------------------------
    {
      // The Phase 3 debt: messages past the last recorded frame were stored
      // where no amount of scrubbing could reach them, because the timeline's
      // range came from frames alone.
      const file = path.join(dir, "extra", "late-telemetry.sqlite");
      const store = new HistoryStore(file);
      store.setMeta("map", "Late.SC2Map");
      store.setMeta("started_at", "2026-02-02T00:00:00.000Z");
      for (let loop = 0; loop <= 400; loop += 100) store.recordFrame(frame(loop));
      const ingest = new StreamIngest(store, path.join(dir, "extra", "late.ndjson"), "late");
      ingest.line(JSON.stringify({ v: TELEMETRY_SCHEMA_VERSION, kind: "hello", data: { name: "late" } }), 1);
      ingest.line(
        JSON.stringify({ v: TELEMETRY_SCHEMA_VERSION, kind: "series", loop: 900, ch: "late/econ", data: 7 }),
        2,
      );
      ingest.finish();
      store.setMeta("ended_at", "2026-02-02T00:10:00.000Z");
      store.flush();
      store.close();

      check("the last loop counts telemetry, not just frames", peekGame(file).maxLoop, 900);
    }

    // -- export --------------------------------------------------------------
    {
      const source = path.join(dir, "2026-01-01_00-00-00-Torches.sqlite");
      const destination = path.join(dir, "exported", "copy.sqlite");
      mkdirSync(path.dirname(destination), { recursive: true });

      check("the replay goes with the game", exportGameTo(source, destination), true);
      const copy = peekGame(destination);
      check("the copy is a game in its own right", copy.state, "ok");
      check("with the same outcome", copy.result, "Victory");
      check("and the same frames", copy.maxLoop, 400);
      check("and its replay beside it", copy.hasReplay, true);

      // Exporting checkpoints the source first, so the copy is one whole file
      // rather than a database whose last rows are still in a sidecar the
      // user was never told to take.
      check("the copy needs no sidecar", existsSync(`${destination}-wal`), false);

      const noReplay = path.join(dir, "exported", "no-replay.sqlite");
      check("a game with no replay exports anyway", exportGameTo(path.join(dir, "extra", "tagged.sqlite"), noReplay), false);
      check("and still opens", peekGame(noReplay).state, "ok");
    }

    // -- what belongs to one game on disk ------------------------------------
    {
      const files = gameFilesFor("C:/games/a.sqlite");
      check(
        "a game is four files, sidecars first",
        files,
        ["C:/games/a.sqlite-wal", "C:/games/a.sqlite-shm", "C:/games/a.sqlite", "C:/games/a.SC2Replay"],
      );
    }

    // -- the catalog file ---------------------------------------------------
    {
      const file = path.join(dir, "catalog", "catalog.sqlite");
      const catalog = new CatalogStore(file);
      check("an unset setting is undefined", catalog.getSetting("gamesDir"), undefined);
      catalog.setSetting("gamesDir", "C:/games");
      catalog.setSetting("gamesDir", "C:/other");
      check("a setting is remembered, last write winning", catalog.getSetting("gamesDir"), "C:/other");
      catalog.close();

      const reopened = new CatalogStore(file);
      check("and survives a restart", reopened.getSetting("gamesDir"), "C:/other");
      reopened.clearSetting("gamesDir");
      check("clearing it is not the same as emptying it", reopened.getSetting("gamesDir"), undefined);
      reopened.close();

      // It has a `meta` table like a game file does, so "is this a game?" has
      // to rest on something a game always has and this never does.
      check("a catalog file does not read as a game", peekGame(file).state, "unreadable");
    }

    // -- who won, by name --------------------------------------------------
    {
      // The list names the winner rather than one player's Victory or
      // Defeat, from what each kind of file already records.
      const withMeta = (name: string, meta: Record<string, string>): string => {
        const file = path.join(dir, `${name}.sqlite`);
        writeFinishedGame(file, { map: "Torches.SC2Map", startedAt: "2026-02-01T00:00:00.000Z", result: "unknown" });
        const store = new HistoryStore(file);
        for (const [key, value] of Object.entries(meta)) store.setMeta(key, value);
        store.close();
        return file;
      };
      const results = (a: string, b: string): string =>
        JSON.stringify([{ player_id: 1, result: a }, { player_id: 2, result: b }]);

      const replay = peekGame(
        withMeta("replay", {
          source: "replay",
          players: JSON.stringify([
            { playerId: 1, name: "VeTerran-extended", race: "Terran" },
            { playerId: 2, name: "Creepy_macro", race: "Zerg" },
          ]),
          player_result: results("Victory", "Defeat"),
        })
      );
      check("a replay names its winner", replay.outcome?.text, "VeTerran-extended won");
      check("and lists every player for the tooltip", replay.outcome?.detail, "VeTerran-extended: Victory\nCreepy_macro: Defeat");

      const againstAi = peekGame(
        withMeta("against-ai", {
          players: JSON.stringify([{ seat: null, player_id: 1, name: "MyBot", result: "Defeat" }]),
          opponents: JSON.stringify([{ player_id: 2, race: "Zerg", difficulty: "Easy", build: "RandomBuild" }]),
          player_result: results("Defeat", "Victory"),
        })
      );
      check("a built-in AI that won is named by its setup", againstAi.outcome?.text, "Computer (Easy Zerg) won");

      const older = peekGame(withMeta("older", { bot_player_id: "1", player_result: results("Victory", "Defeat") }));
      check("an older live game with no names still says the bot won", older.outcome?.text, "the bot won");

      const tie = peekGame(withMeta("tie", { player_result: results("Tie", "Tie") }));
      check("a tie says so", tie.outcome?.text, "Tie");

      const unnamed = peekGame(withMeta("unnamed", { source: "replay", player_result: results("Defeat", "Victory") }));
      check("a player with no name is Player N", unnamed.outcome?.text, "Player 2 won");

      const noResult = peekGame(withMeta("no-result", {}));
      check("a game with no result names no winner", noResult.outcome, null);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall catalog checks passed");
}

main();
