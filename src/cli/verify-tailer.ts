/**
 * Deterministic check for the telemetry tailer. Everything below the viewer
 * layer is tested against bytes, never against a live game, so this drives
 * TelemetryTailer.poll() by hand instead of waiting on its timer: the
 * interesting questions are all about where a read boundary lands, and a test
 * that had to race a 150ms interval to ask them would be flaky about exactly
 * the thing it is checking.
 *
 * Run with: node dist/cli/verify-tailer.js
 */
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventBus } from "../bus/EventBus";
import { HistoryStore } from "../history/HistoryStore";
import { TelemetryTailer } from "../telemetry/TelemetryTailer";
import { TELEMETRY_SCHEMA_VERSION } from "../shared/telemetry-types";

/** Non-ASCII on purpose: a bot's log line can carry any of it, and it is what
 * makes a read boundary land inside a character rather than between two. */
const WIDE = "äöテスト";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const pass = actual === expected;
  console.log(`${pass ? "ok  " : "FAIL"} ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  if (!pass) failures++;
}

/** One `event` message, which is the kind whose payload is easiest to read
 * back out of the store without decompressing anything. */
function eventLine(loop: number, msg: string): string {
  return `${JSON.stringify({
    v: TELEMETRY_SCHEMA_VERSION,
    kind: "event",
    loop,
    ch: "test/log",
    data: { msg, level: "info" },
  })}\n`;
}

function main(): void {
  const scratch = mkdtempSync(path.join(tmpdir(), "spectator-tailer-"));
  try {
    runChecks(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

function runChecks(scratch: string): void {
  const watched = path.join(scratch, "telemetry");
  const store = new HistoryStore(path.join(scratch, "game.sqlite"));
  const bus = new EventBus();
  let announcements = 0;
  bus.on("telemetry", () => announcements++);

  const file = path.join(watched, "run.ndjson");
  const tailer = new TelemetryTailer(store, bus, watched);

  // A watched folder that does not exist yet is not an error: the bot has not
  // started, and the tailer has to survive until it does.
  tailer.poll();
  check("missing folder is tolerated", announcements, 0);

  mkdirSync(watched, { recursive: true });
  writeFileSync(path.join(watched, "notes.txt"), "not telemetry\n");
  writeFileSync(file, eventLine(10, "first") + eventLine(20, "second"));

  tailer.poll();
  check("two complete lines ingested", store.readEvents({}).length, 2);
  check("the growth was announced once", announcements, 1);
  check("non-ndjson files are ignored", tailer.status().files.length, 1);

  // A poll that finds nothing new must stay silent, or the renderer re-queries
  // the whole game 7 times a second for as long as the folder is watched.
  tailer.poll();
  check("an idle poll announces nothing", announcements, 1);

  // The emitter is mid-write: the line has no newline yet. Reading it as if it
  // were complete would reject it, and the rejection would be permanent.
  const half = eventLine(30, "third");
  appendFileSync(file, half.slice(0, 12));
  tailer.poll();
  check("a half-written line is held, not rejected", store.readEvents({}).length, 2);
  check("a half-written line announces nothing", announcements, 1);
  check("a half-written line is not a rejection", tailer.status().files[0]!.rejectedCount, 0);

  appendFileSync(file, half.slice(12));
  tailer.poll();
  check("the line lands once it is finished", store.readEvents({}).length, 3);

  // A read boundary can also fall inside a character, not just inside a line.
  // Splitting one UTF-8 sequence across two polls is the case a naive
  // buffer.toString() per read turns into a replacement character.
  const text = eventLine(40, WIDE);
  const wide = Buffer.from(text, "utf8");
  // One byte into the first multi-byte character, so the first read is
  // guaranteed to end on an incomplete sequence rather than on a lucky offset.
  const cut = Buffer.byteLength(text.slice(0, text.indexOf(WIDE)), "utf8") + 1;
  appendFileSync(file, wide.subarray(0, cut));
  tailer.poll();
  appendFileSync(file, wide.subarray(cut));
  tailer.poll();
  const events = store.readEvents({});
  check("a split multi-byte character survives", events.length, 4);
  check("its text is intact", events[3]!.msg, WIDE);

  // Blank lines are not rejections (§3.4 says nothing about them, and an
  // emitter that flushes an empty buffer produces them), but garbage is.
  appendFileSync(file, "\n" + "{not json}\n" + eventLine(50, "after the bad line"));
  tailer.poll();
  check("a rejected line does not stop the stream", store.readEvents({}).length, 5);
  check("the rejection is counted", tailer.status().files[0]!.rejectedCount, 1);

  // A second emitter writing into the same folder is a second stream, not a
  // continuation of the first.
  writeFileSync(path.join(watched, "other.ndjson"), eventLine(60, "from the other bot"));
  tailer.poll();
  check("a new file is picked up", tailer.status().files.length, 2);
  check("both streams exist", store.getStreams().length, 2);

  // Killing the emitter mid-write leaves the trailing partial line unwritten
  // for good; stopping must still close the streams cleanly.
  appendFileSync(file, eventLine(70, "never finished").slice(0, 20));
  tailer.poll();
  tailer.stop();
  check("the abandoned partial line is not ingested", store.readEvents({}).length, 6);
  check("stopping records each stream's totals", store.getStreams()[0]!.lastLoop, 50);
  tailer.stop();
  check("stopping twice changes nothing", store.readEvents({}).length, 6);

  // Re-watching the same folder must not re-import what is already there: a
  // second pass would duplicate every row.
  const again = new TelemetryTailer(store, bus, watched);
  again.poll();
  check("already-imported files are skipped", again.status().skippedCount, 2);
  check("nothing was duplicated", store.readEvents({}).length, 6);
  again.stop();

  store.close();

  checkAutoAttachIgnoreList(scratch);
}

/**
 * §3.5's auto-attach. A live game watches the folder every previous run also
 * wrote into, so the ignore list is the whole mechanism: without it, game two
 * opens with game one's telemetry already in it, on game one's loop axis,
 * which looks exactly like a bot reporting nonsense.
 *
 * The list is names, not times. An earlier version asked "has this file been
 * written to since the game started", which compares a millisecond timestamp
 * against an mtime Windows keeps to about 16ms: this same check passed and
 * failed on alternate runs, and in a real game it would have dropped a bot's
 * telemetry for good, silently, about as often as a coin lands heads.
 */
function checkAutoAttachIgnoreList(scratch: string): void {
  const watched = path.join(scratch, "auto");
  mkdirSync(watched, { recursive: true });
  const store = new HistoryStore(path.join(scratch, "auto.sqlite"));
  const bus = new EventBus();

  const old = path.join(watched, "previous-run.ndjson");
  writeFileSync(old, eventLine(10, "from the last game"));

  // What the session does when it starts waiting for a bot: the folder as it
  // stands now is everything that cannot belong to the game about to start.
  const census = readdirSync(watched).map((name) => path.join(watched, name));

  const fresh = path.join(watched, "this-run.ndjson");
  writeFileSync(fresh, eventLine(20, "from this game"));

  const tailer = new TelemetryTailer(store, bus, watched, census);
  tailer.poll();
  check("a file from an earlier run is skipped", tailer.status().skippedCount, 1);
  check("the file this game's bot wrote is taken", tailer.status().files.length, 1);
  check("only this game's telemetry is stored", store.readEvents({}).length, 1);
  check("and it is the right line", store.readEvents({})[0]!.msg, "from this game");

  // The old file growing again changes nothing: it is another game's stream,
  // whatever it does now.
  appendFileSync(old, eventLine(11, "a late line from the last game"));
  tailer.poll();
  check("an ignored file is still ignored when it grows", store.readEvents({}).length, 1);

  // Case folding matters here: on Windows the census and the directory
  // listing can disagree about case for the same file.
  tailer.stop();
  const store2 = new HistoryStore(path.join(scratch, "auto-case.sqlite"));
  const shouted = new TelemetryTailer(store2, bus, watched, census.map((p) => p.toUpperCase()));
  shouted.poll();
  check("the ignore list is not case-sensitive on Windows", shouted.status().skippedCount, process.platform === "win32" ? 1 : 0);
  shouted.stop();

  // The same folder with no list is the manual watch, which takes both.
  const store3 = new HistoryStore(path.join(scratch, "auto-manual.sqlite"));
  const manual = new TelemetryTailer(store3, bus, watched);
  manual.poll();
  check("watching by hand takes every file", manual.status().files.length, 2);
  manual.stop();

  store.close();
  store2.close();
  store3.close();
}

main();
