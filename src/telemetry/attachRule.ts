import type { HistoryStore } from "../history/HistoryStore";

/**
 * A game holds at most one telemetry file (§3.5). Changing it means taking the
 * current one out first (detach.ts), so a file can never go in twice and no
 * path comparison is needed to stop it.
 *
 * Each game has one bot seat today, so "one per game" is "one per player".
 * When two bots share a game this becomes one per seat. The store itself
 * still holds any number of streams, because that is what two seats need.
 *
 * Returns why an attach would be refused, or null when it may go ahead. The
 * attach picker, a dropped file, the live tailer and the import CLI all ask
 * here, so they cannot disagree.
 */
export function telemetryRefusal(store: HistoryStore): string | null {
  return store.streamCount() > 0
    ? "This game already has telemetry. Remove it first to attach a different file."
    : null;
}
