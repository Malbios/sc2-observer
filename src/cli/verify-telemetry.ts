/**
 * Checks telemetry checkpointing, which is the one part of the telemetry path
 * that is a cache rather than data, and therefore the one part that can be
 * wrong without anything looking wrong.
 *
 * A checkpoint claims to be the resolved state of the whole game at a loop.
 * `checkpoints` is keyed by loop alone, while each `StreamIngest` owns its own
 * model, so a game with two telemetry files used to have each stream overwrite
 * the other's checkpoint with half the state. Everything the losing stream had
 * established before that loop then vanished from the view for the rest of the
 * game: no error, no rejected line, just an overlay that is there at loop 400
 * and gone at loop 600. A game takes one file per player (attachRule.ts), so
 * two bots in one game still means two streams, and this stays reachable.
 *
 * Run with: node dist/cli/verify-telemetry.js
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HistoryStore } from "../history/HistoryStore";
import { telemetryRefusal } from "../telemetry/attachRule";
import { detachStream } from "../telemetry/detach";
import { StreamIngest } from "../telemetry/ingest";
import { TelemetryResolver } from "../telemetry/TelemetryResolver";
import { TELEMETRY_SCHEMA_VERSION } from "../shared/telemetry-types";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "ok  " : "FAIL"} ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  if (!pass) failures++;
}

function line(fields: Record<string, unknown>): string {
  return JSON.stringify({ v: TELEMETRY_SCHEMA_VERSION, ...fields });
}

/**
 * One bot's file: an overlay set early, then series values every 50 loops out
 * to 1000. The overlay is the interesting part, because an overlay is retained
 * state (§3.3) and is therefore carried by checkpoints rather than re-sent.
 */
function feed(ingest: StreamIngest, name: string): void {
  let lineNo = 0;
  ingest.line(line({ kind: "hello", data: { name } }), ++lineNo);
  ingest.line(
    line({ kind: "overlay", loop: 10, ch: `${name}/plan`, data: [{ type: "point", pos: [1, 1] }] }),
    ++lineNo
  );
  for (let loop = 0; loop <= 1000; loop += 50) {
    ingest.line(line({ kind: "series", loop, ch: `${name}/econ`, data: loop }), ++lineNo);
  }
}

function overlaysAt(store: HistoryStore, loop: number): string[] {
  // A fresh resolver each time, so the answer is what a cold seek would give
  // rather than whatever the previous call left resolved in memory.
  return new TelemetryResolver(store)
    .stateAt(loop)
    .overlays.map((overlay) => overlay.ch)
    .sort();
}

function main(): void {
  const scratch = mkdtempSync(path.join(tmpdir(), "spectator-telemetry-"));
  try {
    checkOneStream(scratch);
    checkTwoStreams(scratch);
    checkDetach(scratch);
    checkAttachRule(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

/** One file per game, and removing it is what makes room for another. The
 * picker, a dropped file, the tailer and the import CLI all ask this. */
function checkAttachRule(scratch: string): void {
  const store = new HistoryStore(path.join(scratch, "rule.sqlite"));
  check("an empty game takes a file", telemetryRefusal(store), null);

  const ingest = new StreamIngest(store, "C:/data/telemetry/mine.ndjson", "mine");
  feed(ingest, "mine");
  const { streamId } = ingest.finish();
  check("a game with a file refuses another", typeof telemetryRefusal(store), "string");

  detachStream(store, streamId!);
  check("removing it makes room again", telemetryRefusal(store), null);
  store.close();
}

/** The common case, and the fast path: one file checkpoints as it is written
 * and must keep doing so. */
function checkOneStream(scratch: string): void {
  const store = new HistoryStore(path.join(scratch, "one.sqlite"));
  const ingest = new StreamIngest(store, path.join(scratch, "solo.ndjson"), "solo");
  feed(ingest, "solo");
  store.flush();

  check(
    "one stream checkpoints while it is being written",
    store.readCheckpointAtOrBefore(600)?.loop,
    500
  );
  check("its overlay survives the checkpoint", overlaysAt(store, 900), ["solo/plan"]);

  ingest.finish();
  check("and the closing checkpoint lands on the last loop", store.readCheckpointAtOrBefore(2000)?.loop, 1000);
  store.close();
}

/** Two files in one game: the case that was silently losing half the state. */
function checkTwoStreams(scratch: string): void {
  const store = new HistoryStore(path.join(scratch, "two.sqlite"));
  const alpha = new StreamIngest(store, path.join(scratch, "alpha.ndjson"), "alpha");
  const bravo = new StreamIngest(store, path.join(scratch, "bravo.ndjson"), "bravo");

  feed(alpha, "alpha");
  feed(bravo, "bravo");
  store.flush();

  check("both streams are attached", store.streamCount(), 2);
  // Before either stream closes there is nothing a single stream could write
  // that would be true of the game, so it writes nothing and the resolver
  // replays. Slower, and right.
  check("a shared game writes no checkpoint while it is live", store.readCheckpointAtOrBefore(600), undefined);
  check("both overlays are in the live state at 600", overlaysAt(store, 600), ["alpha/plan", "bravo/plan"]);

  alpha.finish();
  bravo.finish();

  check("closing rebuilds the checkpoints", store.readCheckpointAtOrBefore(600)?.loop, 500);
  // The regression itself: at loop 100 both overlays were always visible,
  // because nothing had been restored from a checkpoint yet. Past the first
  // boundary the clobbered stream used to disappear.
  check("both overlays survive at 100", overlaysAt(store, 100), ["alpha/plan", "bravo/plan"]);
  check("both overlays survive past the first checkpoint", overlaysAt(store, 600), ["alpha/plan", "bravo/plan"]);
  check("both overlays survive to the end", overlaysAt(store, 900), ["alpha/plan", "bravo/plan"]);

  // A rebuilt checkpoint has to be the state at its own loop, not a later one:
  // the overlay arrives at loop 10, so a checkpoint at 0 must not contain it.
  const atZero = store.readCheckpointAtOrBefore(0);
  check("the checkpoint at loop 0 predates the overlays", JSON.stringify(atZero?.state).includes("/plan"), false);

  store.close();
}

/**
 * §3.5's recovery: a file attached to the wrong game has to be removable
 * again. The interesting part is the checkpoints, which hold the departed
 * stream's overlays as resolved state; nothing in the remaining messages
 * would ever remove them, so a detach that only deleted rows would leave a
 * ghost on the map for the rest of the game.
 */
function checkDetach(scratch: string): void {
  const store = new HistoryStore(path.join(scratch, "detach.sqlite"));
  const mine = new StreamIngest(store, path.join(scratch, "mine.ndjson"), "mine");
  const foreign = new StreamIngest(store, path.join(scratch, "foreign.ndjson"), "foreign");
  feed(mine, "mine");
  feed(foreign, "foreign");
  mine.finish();
  foreign.finish();

  check("both streams are in the game to begin with", overlaysAt(store, 900), ["foreign/plan", "mine/plan"]);
  const foreignId = store.getStreams().find((stream) => stream.name === "foreign")!.id;

  check("the stream is detached", detachStream(store, foreignId), true);
  check("only one stream is left", store.streamCount(), 1);
  check("its overlay is gone from the resolved state", overlaysAt(store, 900), ["mine/plan"]);
  check("and gone from the checkpoints too", JSON.stringify(store.readCheckpointAtOrBefore(900)?.state).includes("foreign"), false);
  check("the remaining stream keeps its own overlay at every loop", overlaysAt(store, 100), ["mine/plan"]);
  check("its series are still charted", store.readSeries("mine/econ", "econ").loops.length > 0, true);
  check("the departed stream's series are not", store.readSeries("foreign/econ", "econ").loops.length, 0);
  check("checkpoints are rebuilt, not just dropped", store.readCheckpointAtOrBefore(600)?.loop, 500);

  check("detaching it again is refused rather than fatal", detachStream(store, foreignId), false);

  // The last stream can go too, which is what recovering a game that was
  // given entirely the wrong file looks like.
  const mineId = store.getStreams()[0]!.id;
  check("the last stream can be detached as well", detachStream(store, mineId), true);
  check("leaving no telemetry", overlaysAt(store, 900), []);
  check("and no checkpoints to replay from", store.readCheckpointAtOrBefore(900), undefined);

  store.close();
}

main();
