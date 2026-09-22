import type { HistoryStore } from "../history/HistoryStore";
import { rebuildCheckpoints } from "./checkpoints";

/**
 * Takes one telemetry stream back out of a game (§3.5: "mis-attachment is
 * recoverable in the history UI").
 *
 * This exists as a function rather than as a method on the store because
 * removing the rows is only half of it. A checkpoint is the resolved state of
 * every stream at a loop, so every checkpoint in the file is wrong the instant
 * one stream leaves: the overlays and entities the departed stream had
 * established are baked into them, and nothing in the remaining messages will
 * ever take them out again. Rebuilding is not an optimization here, it is what
 * makes the answer correct.
 *
 * Returns false when the game has no such stream, which is what a second click
 * on a row that is already gone looks like.
 */
export function detachStream(store: HistoryStore, streamId: number): boolean {
  if (!store.deleteStream(streamId)) return false;
  rebuildCheckpoints(store);
  return true;
}
