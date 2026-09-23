import WebSocket, { WebSocketServer } from "ws";
import { EventBus } from "../bus/EventBus";
import { decodeRequest, decodeResponse, encodeRequest, resultName } from "../protocol/schema";
import { isTerminalStatus, SC2_STATUS } from "../protocol/status";
import { classifyRequest } from "../state/frames";
import { FramePublisher } from "../state/FramePublisher";

/**
 * §1: the user picks this before a session; it is never detected from traffic.
 * A = the app creates the game and the bot only joins. B = the bot creates the
 * game itself (python-sc2's default) and the app only forwards.
 */
export type GameMode = "A" | "B";

/** One entry of `ResponseObservation.player_result`, normalized: the result is
 * the enum's name, e.g. "Victory", never the number the wire carries. */
export interface PlayerResult {
  player_id: number;
  result: string;
}

export interface GameProxyOptions {
  sessionId: string;
  bus: EventBus;
  mapPath: string;
  mode?: GameMode;
  /** Built-in AI opponent, Mode A only. Race and difficulty from sc2api.proto. */
  opponentRace?: number;
  opponentDifficulty?: number;
  botHost?: string;
  botPort?: number;
  sc2Host?: string;
  sc2Port?: number;
}

/**
 * The bot-facing proxy (plan §4). It relays every frame between the bot and
 * SC2 unchanged, in order, publishing each one to the event bus. It never
 * alters, delays, or reorders bot traffic, and never sends `step` or `action`
 * on the bot's behalf.
 *
 * Its own requests (`createGame` between games, `saveReplay` at the end) go
 * over a separate short-lived socket, never the relay. That is not merely
 * tidier: **SC2 accepts one client connection at a time**, verified by probe,
 * so those requests are only possible while no bot is attached. §4 expects
 * exactly that, since the bot is relaunched between games.
 *
 * One proxy serves a whole session across many games; `resetForNewGame()`
 * clears the per-game state between them.
 */
export class GameProxy {
  private readonly sessionId: string;
  private readonly bus: EventBus;
  private readonly mapPath: string;
  private readonly mode: GameMode;
  private readonly opponentRace: number;
  private readonly opponentDifficulty: number;
  private readonly botHost: string;
  private readonly botPort: number;
  private readonly sc2Host: string;
  private readonly sc2Port: number;
  /** The publish half, shared with the replay driver: loop tracking, the
   * store-once rule for `gameInfo`/`data`, and the bus emission. */
  private readonly frames: FramePublisher;
  private server: WebSocketServer | null = null;
  /** Once per game: a surrender puts `player_result` in every subsequent
   * observation, and the status stays `ended`, so both signals repeat. */
  private gameEndedEmitted = false;
  private lastStatus: number | null = null;
  private botSocket: WebSocket | null = null;
  private sc2Socket: WebSocket | null = null;
  /** The most recent `player_result`, kept rather than announced. See the
   * getter below for why it is not on `gameEnded`. */
  private playerResult: PlayerResult[] | null = null;
  private joinedPlayerId: number | null = null;

  constructor(options: GameProxyOptions) {
    this.sessionId = options.sessionId;
    this.bus = options.bus;
    this.mapPath = options.mapPath;
    this.mode = options.mode ?? "A";
    this.opponentRace = options.opponentRace ?? 2; // Zerg
    this.opponentDifficulty = options.opponentDifficulty ?? 2; // Easy
    this.botHost = options.botHost ?? "127.0.0.1";
    this.botPort = options.botPort ?? 5000;
    this.sc2Host = options.sc2Host ?? "127.0.0.1";
    this.sc2Port = options.sc2Port ?? 5001;
    this.frames = new FramePublisher(this.sessionId, this.bus);
  }

  /** True while a bot holds the relay open, which is exactly when the proxy
   * may not open a socket of its own. */
  get botConnected(): boolean {
    return this.botSocket !== null;
  }

  get currentLoop(): number {
    return this.frames.loop;
  }

  /**
   * The outcome SC2 last reported, or null for the endings that produce none:
   * a clean `leave_game` and a bot that vanishes both leave the game genuinely
   * without a result (§7.1).
   *
   * This is read at the end rather than carried on `gameEnded` on purpose.
   * `endGame` is debounced and first-signal-wins, so a status transition
   * arriving before the observation that carries the result would freeze an
   * empty payload into the event and lose an outcome the client did report.
   * A field updated by every observation cannot lose it.
   */
  get lastResult(): PlayerResult[] | null {
    return this.playerResult;
  }

  /** Which player the bot joined as, from the join response the proxy relays.
   * Without it a result is a list of player ids with nothing saying which one
   * was ours. */
  get botPlayerId(): number | null {
    return this.joinedPlayerId;
  }

  private get sc2Url(): string {
    return `ws://${this.sc2Host}:${this.sc2Port}/sc2api`;
  }

  private connectSc2(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.sc2Url);
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
  }

  private async waitForSc2Ready(timeoutMs = 120_000, intervalMs = 1_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const ws = await this.connectSc2();
        ws.close();
        return;
      } catch (err) {
        if (Date.now() > deadline) {
          throw new Error(`SC2 did not accept a connection within ${timeoutMs}ms: ${(err as Error).message}`);
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
  }

  /**
   * One request on a socket of the proxy's own, opened and closed around it.
   * Only safe while no bot is attached, because the client accepts a single
   * connection at a time.
   */
  private async ownRequest(label: string, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.botConnected) {
      throw new Error(`refusing to send ${label} while a bot is connected: SC2 accepts one client at a time`);
    }
    const ws = await this.connectSc2();

    const responsePromise = new Promise<Uint8Array>((resolve, reject) => {
      ws.once("message", (data: Buffer) => resolve(data));
      ws.once("error", reject);
      ws.once("close", () => reject(new Error(`socket closed waiting for ${label}`)));
    });

    ws.send(encodeRequest(fields));
    const responseBytes = await responsePromise;
    ws.close();

    const response = decodeResponse(responseBytes);
    if (Array.isArray(response.error) && response.error.length > 0) {
      throw new Error(`${label} failed: ${JSON.stringify(response.error)}`);
    }
    this.noteStatus(response.status);
    return response;
  }

  /**
   * Mode A's game setup, and the same call the session controller makes for
   * each subsequent game. `create_game` is valid from `launched` and, for
   * singleplayer, from `ended`, so no container restart is needed between
   * games (verified in Phase 0 and again by the end-game probe).
   */
  async createGame(): Promise<void> {
    await this.ownRequest("createGame", {
      create_game: {
        local_map: { map_path: this.mapPath },
        player_setup: [
          { type: 1 /* Participant */ },
          { type: 2 /* Computer */, race: this.opponentRace, difficulty: this.opponentDifficulty },
        ],
        realtime: false,
      },
    });
  }

  /**
   * Asks the client for the finished game's replay. Returns the bytes, which
   * the caller writes: `ResponseSaveReplay.data` carries the whole file over
   * the wire, so nothing has to be mounted into the container.
   *
   * Valid from `ended` as well as `in_game`, measured rather than assumed.
   * Returns null instead of throwing, because failing to keep a replay is not
   * a reason to lose the game recording that is already on disk.
   */
  async saveReplay(): Promise<Uint8Array | null> {
    try {
      const response = await this.ownRequest("saveReplay", { save_replay: {} });
      const data = (response.save_replay as { data?: Uint8Array } | undefined)?.data;
      return data && data.length > 0 ? data : null;
    } catch {
      return null;
    }
  }

  /**
   * Clears everything that is true of one game rather than of the session, so
   * the next game on this proxy records its own `gameInfo`/`data` and starts
   * its loop axis at zero.
   */
  resetForNewGame(): void {
    this.frames.reset();
    this.gameEndedEmitted = false;
    this.lastStatus = null;
    // Game two inheriting game one's Victory is the same bug this method
    // exists for, one field along.
    this.playerResult = null;
    this.joinedPlayerId = null;
  }

  /**
   * Publishes a transition, and decides whether it ended the game.
   *
   * The test is *leaving* `in_game`, not arriving at any particular value.
   * A surrender lands on `ended`, but a clean `leave_game` goes straight back
   * to `launched` (§7.1), and treating only `ended` as terminal would miss it
   * and leave the session waiting for a game that is already over.
   */
  private noteStatus(status: unknown): void {
    if (typeof status !== "number" || status === this.lastStatus) return;
    const previous = this.lastStatus;
    this.lastStatus = status;
    this.bus.emit("clientStatus", { sessionId: this.sessionId, status, previous });

    const leftGame = previous === SC2_STATUS.inGame && status !== SC2_STATUS.inGame;
    if (leftGame || isTerminalStatus(status)) this.endGame("status");
  }

  private endGame(reason: "result" | "status" | "botClosed"): void {
    if (this.gameEndedEmitted) return;
    this.gameEndedEmitted = true;
    this.bus.emit("gameEnded", { sessionId: this.sessionId, loop: this.frames.loop, reason });
  }

  /**
   * The relay's response side: decode, publish to the bus, notice the game
   * ending. Public so tests can drive it from synthetic or recorded bytes
   * instead of a live game, which is what §7 asks for everything below the
   * viewer.
   */
  publishResponse(bytes: Uint8Array): void {
    const decoded = decodeResponse(bytes);
    this.frames.publish(bytes, decoded);

    // The join response is relayed like any other frame and stored as none:
    // `classifyResponse` gives it no kind. Reading the id off the decode that
    // already happened costs nothing and changes nothing on the wire.
    // Presence, not truthiness: player id 0 is a legal id, and proto2 makes
    // an unset field indistinguishable from a zero one under `if`.
    const join = decoded.join_game as Record<string, unknown> | undefined;
    if (join && Object.prototype.hasOwnProperty.call(join, "player_id")) {
      this.joinedPlayerId = Number(join["player_id"]);
    }

    const playerResult = decoded.observation?.player_result;
    if (Array.isArray(playerResult) && playerResult.length > 0) {
      // Every observation after a surrender repeats this, so it is assigned
      // rather than accumulated, and it keeps being assigned after the game
      // has been declared over.
      //
      // The entries are decoded messages, not plain data: `result` is the enum
      // number and an absent one reads as `Victory`, the first value, which is
      // the proto2 trap CLAUDE.md describes. Both are resolved here so nothing
      // downstream has to know it is holding a protobuf object.
      this.playerResult = playerResult.map((entry) => {
        const fields = entry as Record<string, unknown>;
        return {
          // An absent player_id decodes as 0, which is why the bot's own id is
          // taken from the join response rather than assumed to be first.
          player_id: Number(fields["player_id"]),
          result: Object.prototype.hasOwnProperty.call(fields, "result")
            ? resultName(Number(fields["result"]))
            : "unknown",
        };
      });
      this.endGame("result");
    }
    // After the result, so a frame carrying both is attributed to the result,
    // which is the more informative of the two.
    this.noteStatus(decoded.status);
  }

  private publishRequest(bytes: Uint8Array): void {
    const decoded = decodeRequest(bytes);
    const kind = classifyRequest(decoded);
    if (kind) this.frames.emit(kind, bytes, "request");
  }

  async start(): Promise<void> {
    await this.waitForSc2Ready();
    // Mode B's bot sends its own createGame, which is forwarded like any other
    // frame; sending one here first would take the client out of `launched`
    // and make the bot's request fail.
    if (this.mode === "A") await this.createGame();

    this.server = new WebSocketServer({ host: this.botHost, port: this.botPort });

    this.server.on("connection", async (botWs) => {
      // Attach the bot-side listener synchronously, before the `await`
      // below yields control. A frame arriving during that window would
      // otherwise fire 'message' with nobody listening yet and be silently
      // dropped forever (ws does not buffer for latecomer listeners),
      // hanging both sides -- found and fixed in the Phase 0 spike.
      const pending: Buffer[] = [];
      let sc2Ws: WebSocket | null = null;
      this.botSocket = botWs;
      this.bus.emit("botConnection", { sessionId: this.sessionId, connected: true, loop: this.frames.loop });

      botWs.on("message", (data: Buffer) => {
        this.publishRequest(data);
        if (sc2Ws) {
          sc2Ws.send(data);
        } else {
          pending.push(data);
        }
      });

      try {
        sc2Ws = await this.connectSc2();
        this.sc2Socket = sc2Ws;
      } catch (err) {
        botWs.close();
        return;
      }

      for (const data of pending.splice(0)) {
        sc2Ws.send(data);
      }

      sc2Ws.on("message", (data: Buffer) => {
        this.publishResponse(data);
        botWs.send(data);
      });

      const closeBoth = (): void => {
        const wasConnected = this.botSocket === botWs;
        botWs.close();
        sc2Ws?.close();
        if (!wasConnected) return;
        this.botSocket = null;
        this.sc2Socket = null;
        // A bot that vanishes mid-game is the only signal that game is over:
        // SC2 stays `in_game` forever with no status change and no
        // `player_result` (§7.1). If the game already ended this is just the
        // bot leaving between games, and endGame's guard swallows it.
        this.endGame("botClosed");
        this.bus.emit("botConnection", { sessionId: this.sessionId, connected: false, loop: this.frames.loop });
      };
      botWs.on("close", closeBoth);
      sc2Ws.on("close", closeBoth);
    });
  }

  /** Stops listening and drops any live relay, so the client is free for the
   * proxy's own socket again. */
  stop(): void {
    this.server?.close();
    this.server = null;
    this.botSocket?.close();
    this.sc2Socket?.close();
    this.botSocket = null;
    this.sc2Socket = null;
  }
}
