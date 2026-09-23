import type { FrameEvent } from "../bus/EventBus";
import type { HistoryStore } from "../history/HistoryStore";
import { decodeRequest, decodeResponse, type Response } from "../protocol/schema";
import type { ChannelIpc, OverlayStateIpc } from "../shared/telemetry-types";
import { abilityChannels, IntentModel, INTENT_PREFIX, readUnitCommands } from "./intent";

type Frame = Pick<FrameEvent, "kind" | "direction" | "loop" | "bytes">;

/**
 * Overlays the app derives from the game's own frames rather than from a
 * telemetry file, for one game.
 *
 * It is fed one frame at a time from either source: the bus while a game is
 * live, and the stored frames replayed in order when a recording opens. One
 * model, two sources, which is what keeps the live view and the history view
 * the same by construction. Nothing is written back into the game file, so
 * nothing here can damage one.
 */
export class GameOverlays {
  private channelNames = new Map<number, string>();
  private readonly intent = new IntentModel();

  static fromStore(store: HistoryStore): GameOverlays {
    const overlays = new GameOverlays();
    // Read as a list rather than "at loop 0": a bot that asks for data after
    // its first observation has it tagged with that observation's loop.
    for (const kind of ["data", "action"]) {
      const direction = kind === "data" ? "response" : "request";
      for (const frame of store.readFrames(kind, direction)) {
        overlays.addFrame({ kind: kind as FrameEvent["kind"], direction, loop: frame.loop, bytes: frame.bytes });
      }
    }
    return overlays;
  }

  /** Returns true when the channel list changed, which is what the renderer
   * has to be told about; everything else it picks up by asking for a loop. */
  addFrame(frame: Frame): boolean {
    if (frame.kind === "data" && frame.direction === "response") {
      this.channelNames = abilityChannels(decodeResponse(frame.bytes));
      return !this.intent.isEmpty;
    }
    if (frame.kind === "action" && frame.direction === "request") {
      return this.intent.add(readUnitCommands(decodeRequest(frame.bytes), frame.loop));
    }
    return false;
  }

  /** Intent lines are drawn against unit positions, so a caller with nothing
   * to draw can skip decoding an observation. */
  get needsObservation(): boolean {
    return !this.intent.isEmpty;
  }

  overlaysAt(loop: number, observation: Response | null): OverlayStateIpc[] {
    if (!observation || this.intent.isEmpty) return [];
    return this.intent.overlaysAt(loop, observation, this.channelOf);
  }

  channels(): ChannelIpc[] {
    const names = new Set(this.intent.abilities().map(this.channelOf));
    return [...names].map((ch) => ({
      ch,
      kind: "overlay",
      label: null,
      unit: null,
      range: null,
      defaultVisible: true,
      sticky: false,
      seriesNames: [],
    }));
  }

  /** A game with no data frame still gets its lines, under the ability id. */
  private readonly channelOf = (abilityId: number): string =>
    this.channelNames.get(abilityId) ?? `${INTENT_PREFIX}Ability ${abilityId}`;
}
