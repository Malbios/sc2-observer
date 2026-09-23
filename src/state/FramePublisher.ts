import type { EventBus } from "../bus/EventBus";
import type { FrameKind } from "../bus/EventBus";
import type { Response } from "../protocol/schema";
import { classifyResponse, LoopTracker } from "./frames";

/**
 * Turns decoded responses into bus frames, which is the half of the proxy's
 * publish path that has nothing to do with relaying a bot.
 *
 * It exists because the replay driver needs exactly this and none of the
 * relay around it: the same loop tracking (only observations carry
 * `game_loop`, so everything else is tagged with the last one seen), the same
 * rule that `gameInfo` and `data` are stored once per game (§6.3) however many
 * times they are asked for, and the same bus event, so a replay reaches the
 * viewer and the store down the identical path a live game does.
 *
 * Sharing it is not tidiness. Two copies of the store-once set and the loop
 * tracker would be two places for the bug `resetForNewGame` exists to prevent:
 * a second game whose early frames carry the first game's final loop.
 */
export class FramePublisher {
  private readonly loopTracker = new LoopTracker();
  private storedOnceKinds = new Set<FrameKind>();

  constructor(
    private readonly sessionId: string,
    private readonly bus: EventBus,
  ) {}

  /** The last observed loop, which is what every other frame is tagged with. */
  get loop(): number {
    return this.loopTracker.loop;
  }

  /**
   * Publishes one response and returns the loop it was tagged with. The bytes
   * are passed through untouched: they are what gets stored, and for the proxy
   * they are also what goes on to the bot.
   */
  publish(bytes: Uint8Array, decoded: Response): number {
    const loop = this.loopTracker.observe(decoded);
    const kind = classifyResponse(decoded);
    if (!kind) return loop;

    // gameInfo and data are static for the whole game (§6.3: "gameInfo and
    // data appear once") but some bots re-request them every step; only the
    // first copy is worth persisting.
    const storeOnce = kind === "gameInfo" || kind === "data";
    if (storeOnce && this.storedOnceKinds.has(kind)) return loop;

    this.bus.emit("frame", { sessionId: this.sessionId, loop, kind, direction: "response", bytes });
    if (storeOnce) this.storedOnceKinds.add(kind);
    return loop;
  }

  /** A frame the app did not decode itself, such as the proxy's copy of a
   * request going the other way. */
  emit(kind: FrameKind, bytes: Uint8Array, direction: "request" | "response"): void {
    this.bus.emit("frame", { sessionId: this.sessionId, loop: this.loopTracker.loop, kind, direction, bytes });
  }

  /** Back to an empty game: loop zero and nothing stored yet. */
  reset(): void {
    this.loopTracker.reset();
    this.storedOnceKinds = new Set();
  }
}
