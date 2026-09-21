import type { HistoryStore } from "../history/HistoryStore";
import { TelemetryModel } from "./TelemetryModel";

/** §6.3's default: seeking to loop L then replays at most this many loops of
 * messages instead of the whole game. */
export const CHECKPOINT_EVERY = 500;

/**
 * Rebuilds every checkpoint in a game from the messages actually stored in it.
 *
 * A checkpoint claims to be the resolved telemetry state of the whole game at
 * a loop, and that is a claim only the merged message order can support. One
 * `StreamIngest` knows its own file and nothing else, so while a game has two
 * telemetry files there is no moment at which either of them can write a
 * truthful checkpoint: each would hold half the game, and since checkpoints
 * are keyed by loop alone, the second writer at loop 500 silently replaces the
 * first. Everything the losing stream had established before that loop then
 * disappears from the view for the rest of the game.
 *
 * So multi-stream games stop checkpointing as they are written and rebuild
 * here instead, in one pass over `telemetry ORDER BY loop, seq`, which is
 * exactly the order `TelemetryResolver` replays in. The work is bounded by
 * reading one checkpoint interval at a time rather than the whole game at
 * once.
 */
export function rebuildCheckpoints(store: HistoryStore): void {
  store.clearCheckpoints();

  const maxLoop = store.getTelemetryMaxLoop();
  if (maxLoop === null) return;

  const model = new TelemetryModel();
  let applied = -1;

  const captureAt = (loop: number): void => {
    for (const row of store.readTelemetryRange(applied, loop)) {
      model.apply(row);
    }
    applied = loop;
    store.recordCheckpoint(loop, model.capture());
  };

  for (let boundary = 0; boundary <= maxLoop; boundary += CHECKPOINT_EVERY) {
    captureAt(boundary);
  }
  // The closing one, so seeking to the end of a finished game does not replay
  // the tail from the last boundary.
  if (applied < maxLoop) captureAt(maxLoop);

  store.flush();
}
