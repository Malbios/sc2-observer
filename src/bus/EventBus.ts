import { EventEmitter } from "node:events";

export type FrameKind = "gameInfo" | "data" | "observation" | "action";
export type FrameDirection = "request" | "response";

export interface FrameEvent {
  sessionId: string;
  loop: number;
  kind: FrameKind;
  direction: FrameDirection;
  bytes: Uint8Array;
}

export interface GameEndedEvent {
  sessionId: string;
  loop: number;
}

/** Emitted when a tailed telemetry file has grown and the new rows are in the
 * store. It says how much, not what: consumers re-query by loop, which is what
 * keeps the live view and the history view on one code path (§4). */
export interface TelemetryAppendedEvent {
  /** The watched folder the growth was seen in. */
  dir: string;
  /** Messages ingested from that folder so far, across every file in it. */
  messageCount: number;
  /** Highest loop seen so far, or null if no message has carried one yet. */
  lastLoop: number | null;
}

interface EventBusEvents {
  frame: [FrameEvent];
  gameEnded: [GameEndedEvent];
  telemetry: [TelemetryAppendedEvent];
}

export class EventBus extends EventEmitter {
  override emit<K extends keyof EventBusEvents>(event: K, ...args: EventBusEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof EventBusEvents>(event: K, listener: (...args: EventBusEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
}
