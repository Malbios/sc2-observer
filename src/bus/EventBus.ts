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

interface EventBusEvents {
  frame: [FrameEvent];
  gameEnded: [GameEndedEvent];
}

export class EventBus extends EventEmitter {
  override emit<K extends keyof EventBusEvents>(event: K, ...args: EventBusEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof EventBusEvents>(event: K, listener: (...args: EventBusEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
}
