import type { HistoryStore } from "../history/HistoryStore";

/**
 * A game holds at most one telemetry file per player (§3.5). Changing it means
 * taking the current one out first (detach.ts), so a file can never go in
 * twice and no path comparison is needed to stop it.
 *
 * `seat` is the player in a game between two bots, and null in every other
 * game, where the one bot's file is the game's file. A game between two bots
 * cannot take a file without knowing whose it is, because its channels are
 * filed under that player (ingest.ts).
 *
 * Returns why an attach would be refused, or null when it may go ahead. The
 * attach picker, a dropped file, the live tailer and the import CLI all ask
 * here, so they cannot disagree.
 */
export function telemetryRefusal(store: HistoryStore, seat: number | null = null): string | null {
  const betweenBots = store.getMeta("mode") === "BvB";
  if (betweenBots && seat === null) {
    return "This game is between two bots. Say which player the telemetry file belongs to.";
  }
  const taken = store.getStreams().some((stream) => (stream.seat ?? null) === seat);
  if (!taken) return null;
  return seat === null
    ? "This game already has telemetry. Remove it first to attach a different file."
    : `Player ${seat} already has telemetry. Remove it first to attach a different file.`;
}
