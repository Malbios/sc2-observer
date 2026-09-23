import { EventEmitter } from "node:events";
import type { SessionStatusIpc } from "../shared/ipc-types";

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

/**
 * Where a replay being played through the client has got to.
 *
 * A replay is the one producer whose end is known in advance: §7's
 * `ResponseReplayInfo` gives the game's length in loops before the first step,
 * so this is a real fraction rather than a spinner. It is a separate event
 * from `sessionState` because a replay is not a session: no bot, no container
 * ownership, no next game.
 */
export interface ReplayProgressEvent {
  sessionId: string;
  loop: number;
  /** The replay's length from `replay_info`, or 0 when it did not say. */
  totalLoops: number;
  playing: boolean;
  finished: boolean;
  /** Set when the replay stopped because something went wrong. */
  error: string | null;
}

/** A line for the diagnostics panel (§4). `manager`, `session` and `history`
 * lines are the app's own narration of what it is doing and why it is
 * waiting; `build` and `container` are Docker's own output. */
export interface DockerLogEvent {
  source: "manager" | "session" | "history" | "build" | "container";
  line: string;
}

interface EventBusEvents {
  frame: [FrameEvent];
  sessionState: [SessionStatusIpc];
  gameEnded: [GameEndedEvent];
  clientStatus: [ClientStatusEvent];
  botConnection: [BotConnectionEvent];
  telemetry: [TelemetryAppendedEvent];
  replayProgress: [ReplayProgressEvent];
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
