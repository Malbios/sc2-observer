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

/**
 * How the app found out a game was over. Three separate signals, because SC2
 * does not give one reliable one: a surrender produces `player_result`, a
 * `leave_game` only moves the status, and a bot that simply vanishes produces
 * neither and leaves the client in `in_game` forever (§7.1).
 */
export type GameEndReason = "result" | "status" | "botClosed";

export interface GameEndedEvent {
  sessionId: string;
  loop: number;
  reason: GameEndReason;
}

/** A `Response.status` transition. Only emitted when the value changes. */
export interface ClientStatusEvent {
  sessionId: string;
  status: number;
  previous: number | null;
}

/**
 * The bot attaching to or leaving the proxy's port. Separate from
 * `gameEnded` on purpose: a bot disconnecting after a finished game is
 * routine (§4 expects it to be relaunched between games), while one
 * disconnecting mid-game is how that game ends.
 */
export interface BotConnectionEvent {
  sessionId: string;
  connected: boolean;
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

/** A line of Docker output, for the diagnostics panel (§4). `manager` lines
 * are the app's own narration; the other two are Docker's. */
export interface DockerLogEvent {
  source: "manager" | "build" | "container";
  line: string;
}

interface EventBusEvents {
  frame: [FrameEvent];
  gameEnded: [GameEndedEvent];
  clientStatus: [ClientStatusEvent];
  botConnection: [BotConnectionEvent];
  telemetry: [TelemetryAppendedEvent];
  dockerLog: [DockerLogEvent];
}

export class EventBus extends EventEmitter {
  override emit<K extends keyof EventBusEvents>(event: K, ...args: EventBusEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof EventBusEvents>(event: K, listener: (...args: EventBusEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
}
