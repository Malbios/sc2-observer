import type {
  EntityData,
  EntityStateIpc,
  OverlayShape,
  OverlayStateIpc,
  SnapshotStateIpc,
  TelemetryStateIpc,
  TelemetryStyle,
} from "../shared/telemetry-types";

/**
 * The retention rules of plan §3.3, in one place.
 *
 * There is deliberately a single implementation fed two ways: the tailer
 * pushes messages in as they arrive, and the store replays them from the
 * nearest checkpoint when the timeline is scrubbed. That is what makes §3.6's
 * "the history browser is identical to the live view" true by construction
 * instead of by discipline.
 *
 * `series` and `event` messages are not state. They are append-only on the
 * time axis and are answered by range queries, so this model ignores them.
 */

export interface OverlayEntry {
  ch: string;
  loop: number;
  style: TelemetryStyle | null;
  ttl: number | null;
  shapes: OverlayShape[];
}
export interface SnapshotEntry {
  ch: string;
  loop: number;
  data: unknown;
}
export interface EntityEntry {
  ch: string;
  loop: number;
  /** Keyed by unit tag. Note that a JSON round-trip through a checkpoint turns
   * these keys into strings; lookups coerce, so both forms behave the same. */
  byTag: Record<number, EntityData>;
}

export interface TelemetryState {
  overlays: Record<string, OverlayEntry>;
  snapshots: Record<string, SnapshotEntry>;
  entities: Record<string, EntityEntry>;
}

/** The subset of a message this model cares about, so it can be fed equally
 * from a parsed line or a decompressed `telemetry` row. */
export interface ApplicableMessage {
  kind: string;
  loop: number;
  ch: string;
  style?: TelemetryStyle | null;
  ttl?: number | null;
  data: unknown;
}

export function emptyTelemetryState(): TelemetryState {
  return { overlays: {}, snapshots: {}, entities: {} };
}

export class TelemetryModel {
  private state: TelemetryState = emptyTelemetryState();

  apply(message: ApplicableMessage): void {
    switch (message.kind) {
      case "overlay":
        // Replaces the channel's previous content (§3.3).
        this.state.overlays[message.ch] = {
          ch: message.ch,
          loop: message.loop,
          style: message.style ?? null,
          ttl: message.ttl ?? null,
          shapes: (message.data ?? []) as OverlayShape[],
        };
        break;
      case "snapshot":
        this.state.snapshots[message.ch] = { ch: message.ch, loop: message.loop, data: message.data };
        break;
      case "entity": {
        // Replaces previous data for (ch, tag), not for the whole channel.
        const entity = message.data as EntityData;
        const existing = this.state.entities[message.ch];
        if (existing) {
          existing.byTag[entity.tag] = entity;
          existing.loop = message.loop;
        } else {
          this.state.entities[message.ch] = { ch: message.ch, loop: message.loop, byTag: { [entity.tag]: entity } };
        }
        break;
      }
      default:
        // series and event are append-only; nothing to retain.
        break;
    }
  }

  /** A detached copy, safe to store as a checkpoint. */
  capture(): TelemetryState {
    return JSON.parse(JSON.stringify(this.state)) as TelemetryState;
  }

  restore(state: TelemetryState | null | undefined): void {
    const source = state ?? emptyTelemetryState();
    this.state = {
      overlays: source.overlays ?? {},
      snapshots: source.snapshots ?? {},
      entities: source.entities ?? {},
    };
  }

  reset(): void {
    this.state = emptyTelemetryState();
  }

  /**
   * The resolved view at `loop`. The only thing decided here rather than at
   * apply time is ttl: an overlay is valid "until the channel is next written
   * or until `ttl` loops elapse" (§3.3), and whether it has elapsed depends on
   * where the cursor is, not on what has been applied.
   */
  stateAt(loop: number): TelemetryStateIpc {
    const overlays: OverlayStateIpc[] = [];
    for (const entry of Object.values(this.state.overlays)) {
      if (entry.ttl !== null && entry.loop + entry.ttl < loop) continue;
      overlays.push({ ch: entry.ch, loop: entry.loop, style: entry.style, shapes: entry.shapes });
    }
    const snapshots: SnapshotStateIpc[] = Object.values(this.state.snapshots).map((entry) => ({
      ch: entry.ch,
      loop: entry.loop,
      data: entry.data,
    }));
    const entities: EntityStateIpc[] = Object.values(this.state.entities).map((entry) => ({
      ch: entry.ch,
      loop: entry.loop,
      byTag: entry.byTag,
    }));
    return { loop, overlays, snapshots, entities };
  }
}
