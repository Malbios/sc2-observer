import type { HistoryStore } from "../history/HistoryStore";
import type { TelemetryStateIpc } from "../shared/telemetry-types";
import { TelemetryModel, type TelemetryState } from "./TelemetryModel";

/**
 * Answers "telemetry state at loop L" against a store, keeping the model
 * resolved in place between calls.
 *
 * Scrubbing forward one step should apply a handful of rows, not replay from a
 * checkpoint every frame, which is what the timeline does 22 times a second at
 * 1x. Rewinding, or jumping far ahead, restarts from the nearest checkpoint,
 * which is what bounds the work to §6.3's 500 loops instead of the whole game.
 */
export class TelemetryResolver {
  private readonly model = new TelemetryModel();
  /** The loop the model currently reflects; -1 means nothing applied yet. */
  private resolvedLoop = -1;

  constructor(private readonly store: HistoryStore) {}

  stateAt(loop: number): TelemetryStateIpc {
    const checkpoint = this.store.readCheckpointAtOrBefore(loop);
    const checkpointLoop = checkpoint ? checkpoint.loop : -1;

    // Rewinding always needs a restart, because applied messages cannot be
    // un-applied. Going forward only benefits from a checkpoint if one sits
    // between where the model is and where we are going.
    if (loop < this.resolvedLoop || checkpointLoop > this.resolvedLoop) {
      this.model.restore((checkpoint?.state as TelemetryState | undefined) ?? null);
      this.resolvedLoop = checkpointLoop;
    }

    if (loop > this.resolvedLoop) {
      for (const row of this.store.readTelemetryRange(this.resolvedLoop, loop)) {
        this.model.apply(row);
      }
      this.resolvedLoop = loop;
    }

    return this.model.stateAt(loop);
  }

  /** Call when rows have been added underneath, so the next read rebuilds. */
  invalidate(): void {
    this.model.reset();
    this.resolvedLoop = -1;
  }
}
