import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BotConnectionEvent,
  ClientStatusEvent,
  EventBus,
  FrameEvent,
  GameEndedEvent,
  GameEndReason,
} from "../bus/EventBus";
import { DockerManager, SECOND_CLIENT_PORT, type ContainerStatus } from "../docker/DockerManager";
import { gameFileName, replayPathFor, uniqueGamePath } from "../history/gameFiles";
import { HistoryStore } from "../history/HistoryStore";
import { GameMode, GameProxy, PlayerResult, Seat } from "../proxy/GameProxy";
import { SC2_STATUS, statusName } from "../protocol/status";
import { DEFAULT_AI, describeOpponent, type AiOpponent } from "../shared/ai-options";
import type { SeatStatusIpc, SessionPhase, SessionStatusIpc } from "../shared/ipc-types";

/**
 * The parts of the Docker manager a session needs. Declared as an interface so
 * the state machine can be driven without Docker, which is the only way to
 * test it deterministically (§7).
 */
export interface ClientHost {
  readonly hostPort: number;
  ensureClientReady(options?: { replaceRunning?: boolean }): Promise<{ ok: boolean; reason: string | null }>;
  stopContainer(): Promise<void>;
  /** Whether the container is still up, asked after a game between two bots:
   * it stops when either client dies (entrypoint.sh). */
  containerStatus(): Promise<ContainerStatus>;
}

/** The parts of the proxy a session needs, for the same reason. */
export interface GameHost {
  /** On every bus event the proxy emits, so two proxies can be told apart. */
  readonly sessionId: string;
  readonly botConnected: boolean;
  readonly currentLoop: number;
  /** The outcome, if the ending produced one. Read at the end of a game
   * rather than delivered with `gameEnded`; see `GameProxy.lastResult`. */
  readonly lastResult: PlayerResult[] | null;
  readonly botPlayerId: number | null;
  readonly botName: string | null;
  /** Players the running game reports (from its game_info), and players the
   * proxy asked for, so a map that dropped AIs can be noticed. */
  readonly playersInGame: number | null;
  readonly playersRequested: number;
  start(): Promise<void>;
  stop(): void;
  createGame(): Promise<void>;
  saveReplay(): Promise<Uint8Array | null>;
  leaveGame(): Promise<string | null>;
  resetForNewGame(): void;
}

/**
 * A game between two bots: what each bot is started with, ladder-style
 * (`--LadderServer --GamePort --StartPort`, as AI Arena passes them). Each
 * seat has its own proxy port in front of its own client, and both share the
 * start port the game's internal ports are counted from (5102 to 5105, inside
 * the container only).
 */
export const BVB_LADDER_SERVER = "127.0.0.1";
export const BVB_BOT_PORTS: Record<Seat, number> = { 1: 5000, 2: 5010 };
export const BVB_START_PORT = 5100;

interface SeatState {
  seat: Seat;
  host: GameHost;
  botConnected: boolean;
}

export interface SessionControllerOptions {
  bus: EventBus;
  /** Folder holding the Dockerfile, and the build context. */
  dockerfileDir: string;
  /** Host maps folder, mounted into the container. */
  mapsDir: string;
  /** Where per-game .sqlite files are written. */
  gamesDir: string;
  map: string;
  mode?: GameMode;
  /** Mode A: the built-in AIs to play against, one easy Zerg when absent. */
  opponents?: AiOpponent[];
  hostPort?: number;
  botPort?: number;
  /** BvB: whose view the first game shows and records. */
  watchSeat?: Seat;
  /** Injected in tests; a real manager and proxy are built when absent. */
  client?: ClientHost;
  game?: GameHost;
  /** BvB, in tests: the two seats' proxies, seat 1 first. */
  seatGames?: [GameHost, GameHost];
  /** A clock, so file names are predictable in tests. */
  now?: () => Date;
  /** Stamped into each game's `meta` (§6.3), so a file that will not open can
   * be traced to the build that wrote it. */
  appVersion?: string;
}

/**
 * The session state machine (§4): `containerDown -> clientReady ->
 * gameCreated -> inGame -> ended`, and in Mode A back to `gameCreated` for the
 * next game.
 *
 * It owns the container, the proxy and one store per game, and it is the only
 * thing that knows a session is more than one game. Two rules it must not
 * break:
 *
 * - **It never starts, stops or restarts the bot.** The bot is the user's
 *   process, launched from their debugger; the app waits for it.
 * - **No timeout changes state** (§4.2). A bot sitting on a breakpoint is
 *   indistinguishable from a slow one, and guessing would end a game the user
 *   is still debugging. Everything here waits for an event or for the user.
 */
export class SessionController {
  private readonly bus: EventBus;
  private readonly gamesDir: string;
  private readonly map: string;
  private readonly mode: GameMode;
  private readonly now: () => Date;
  private readonly appVersion: string | null;
  private readonly client: ClientHost;
  /** One seat per bot: one for Mode A and B, two for a game between two
   * bots. Seat 1's proxy creates the games and saves the replays. */
  private readonly seats: SeatState[];
  /** BvB: the seat the current game shows and records, and the one the next
   * game will. A game file holds one bot's view, so a change waits for the
   * next game unless nothing has been recorded yet. */
  private watchSeat: Seat;
  private nextWatchSeat: Seat;
  /** Why the game that is finishing ended, held between the signal and the
   * write because `finishGame` runs after waiting for the bot to let go. */
  private endReason: GameEndReason | null = null;

  private phase: SessionPhase = "idle";
  private store: HistoryStore | null = null;
  private gameFile: string | null = null;
  private gamesPlayed = 0;
  private clientStatus: number | null = null;
  private error: string | null = null;
  /** Something the user should know that does not stop the session: a map
   * that left out some of the AIs asked for. Per game. */
  private warning: string | null = null;
  private readonly opponents: AiOpponent[];
  private stopping = false;
  /** Resolvers waiting for the bot to let go of the client. */
  private botGoneWaiters: (() => void)[] = [];
  private listeners: (() => void)[] = [];

  constructor(options: SessionControllerOptions) {
    this.bus = options.bus;
    this.gamesDir = options.gamesDir;
    this.map = options.map;
    this.mode = options.mode ?? "A";
    this.now = options.now ?? (() => new Date());
    this.appVersion = options.appVersion ?? null;

    this.opponents = options.opponents && options.opponents.length > 0 ? options.opponents : [DEFAULT_AI];
    this.watchSeat = options.watchSeat ?? 1;
    this.nextWatchSeat = this.watchSeat;

    this.client =
      options.client ??
      new DockerManager({
        bus: options.bus,
        dockerfileDir: options.dockerfileDir,
        mapsDir: options.mapsDir,
        hostPort: options.hostPort,
        clients: this.bvb ? 2 : 1,
      });

    const sessionId = `session-${Date.now()}`;
    if (this.bvb) {
      const proxyFor = (seat: Seat): GameHost =>
        new GameProxy({
          sessionId: `${sessionId}-p${seat}`,
          bus: options.bus,
          mapPath: options.map,
          mode: "BvB",
          seat,
          botPort: BVB_BOT_PORTS[seat],
          sc2Port: seat === 1 ? this.client.hostPort : SECOND_CLIENT_PORT,
        });
      const [one, two] = options.seatGames ?? [proxyFor(1), proxyFor(2)];
      this.seats = [
        { seat: 1, host: one, botConnected: false },
        { seat: 2, host: two, botConnected: false },
      ];
    } else {
      const host =
        options.game ??
        new GameProxy({
          sessionId,
          bus: options.bus,
          mapPath: options.map,
          mode: this.mode,
          opponents: this.opponents,
          botPort: options.botPort,
          sc2Port: this.client.hostPort,
        });
      this.seats = [{ seat: 1, host, botConnected: false }];
    }
  }

  private get bvb(): boolean {
    return this.mode === "BvB";
  }

  /** Seat 1: the proxy that creates each game and saves its replay. */
  private get game(): GameHost {
    return this.seats[0]!.host;
  }

  /** The seat whose view is recorded; the only seat outside a BvB game. */
  private get watched(): SeatState {
    return this.seats.find((state) => state.seat === this.watchSeat) ?? this.seats[0]!;
  }

  /**
   * Which seat an event came from. A session with one proxy takes every event
   * as its own, as it always has. With two, an event from a proxy this session
   * does not own is ignored.
   */
  private seatOf(sessionId: string): SeatState | null {
    if (!this.bvb) return this.seats[0]!;
    return this.seats.find((state) => state.host.sessionId === sessionId) ?? null;
  }

  /** BvB: the session id of the watched seat's proxy, so the live view shows
   * the same bot the recording holds. Null otherwise: take every frame. */
  get watchedSessionId(): string | null {
    return this.bvb ? this.watched.host.sessionId : null;
  }

  /** Each bot's name by player id, for the ones that joined under one. The
   * built-in AIs have none; the viewer calls them "Computer". */
  playerNames(): Map<number, string> {
    const names = new Map<number, string>();
    for (const state of this.seats) {
      const { botPlayerId, botName } = state.host;
      if (botPlayerId !== null && botName) names.set(botPlayerId, botName);
    }
    return names;
  }

  get status(): SessionStatusIpc {
    const seats: SeatStatusIpc[] | null = this.bvb
      ? this.seats.map((state) => ({
          seat: state.seat,
          ladderServer: BVB_LADDER_SERVER,
          gamePort: BVB_BOT_PORTS[state.seat],
          startPort: BVB_START_PORT,
          botConnected: state.botConnected,
          playerId: state.host.botPlayerId,
          name: state.host.botName,
        }))
      : null;
    return {
      phase: this.phase,
      mode: this.mode,
      map: this.map,
      gameFile: this.gameFile,
      gamesPlayed: this.gamesPlayed,
      loop: this.watched.host.currentLoop,
      botConnected: this.watched.botConnected,
      clientStatus: statusName(this.clientStatus),
      error: this.error,
      warning: this.warning,
      seats,
      watchSeat: this.bvb ? this.watchSeat : null,
      nextWatchSeat: this.bvb && this.nextWatchSeat !== this.watchSeat ? this.nextWatchSeat : null,
    };
  }

  /**
   * BvB: whose view to show and record. A game file holds one bot's view, so
   * this takes effect now only if nothing of the current game has been
   * recorded yet, and otherwise from the next game.
   */
  setWatchedSeat(seat: Seat): void {
    if (!this.bvb) return;
    this.nextWatchSeat = seat;
    if (!this.store) this.watchSeat = seat;
    this.log(this.watchSeat === seat ? `watching player ${seat}` : `player ${seat} will be watched from the next game`);
    this.announce();
  }

  /** The store the current game is being written to, for the IPC layer's
   * "active store" indirection. Null between games. */
  get activeStore(): HistoryStore | null {
    return this.store;
  }

  private log(line: string): void {
    this.bus.emit("dockerLog", { source: "session", line });
  }

  private announce(): void {
    this.bus.emit("sessionState", this.status);
  }

  private setPhase(phase: SessionPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.log(`phase: ${phase}`);
    this.announce();
  }

  /**
   * Subscribes to everything the machine reacts to. Frames go to whichever
   * store is current, which is why there is one handler for the whole session
   * rather than one per game: swapping subscriptions between games is how
   * frames get lost at exactly the moment a game starts.
   */
  private attach(): void {
    // In a game between two bots each proxy sees its own bot's view, fog and
    // all. Recording both would interleave two views into one file, so only
    // the watched seat's frames are kept.
    const onFrame = (event: FrameEvent): void => {
      const state = this.seatOf(event.sessionId);
      if (!state || state !== this.watched) return;
      this.ensureStore().recordFrame(event);
      // The proxy reads the player count off this same response just after
      // publishing it, so the check waits for that to have happened.
      if (event.kind === "gameInfo") queueMicrotask(() => this.checkPlayers());
    };
    const onStatus = (event: ClientStatusEvent): void => {
      const state = this.seatOf(event.sessionId);
      if (!state || state !== this.watched) return;
      this.clientStatus = event.status;
      if (event.status === SC2_STATUS.inGame && this.phase !== "ended") this.setPhase("inGame");
      else this.announce();
    };
    const onBot = (event: BotConnectionEvent): void => {
      const state = this.seatOf(event.sessionId);
      if (!state) return;
      state.botConnected = event.connected;
      if (!event.connected && this.seats.every((seat) => !seat.botConnected)) this.releaseBotWaiters();
      this.announce();
    };
    // The first seat to report the end ends the game for the session; the
    // other's report is swallowed by the phase guard. The next game still
    // waits for every bot to let go.
    const onEnded = (event: GameEndedEvent): void => {
      if (!this.seatOf(event.sessionId)) return;
      void this.onGameEnded(event.reason, event.loop);
    };

    this.bus.on("frame", onFrame);
    this.bus.on("clientStatus", onStatus);
    this.bus.on("botConnection", onBot);
    this.bus.on("gameEnded", onEnded);
    this.listeners = [
      () => void this.bus.off("frame", onFrame),
      () => void this.bus.off("clientStatus", onStatus),
      () => void this.bus.off("botConnection", onBot),
      () => void this.bus.off("gameEnded", onEnded),
    ];
  }

  private detach(): void {
    for (const off of this.listeners) off();
    this.listeners = [];
  }

  /**
   * The game file is created by the first frame of a game, not by creating the
   * game. In Mode A the app's `createGame` is answered on the proxy's own
   * socket and relays nothing, and in Mode B the app does not know a game has
   * begun until the bot's traffic starts; opening the file eagerly in either
   * case would leave an empty .sqlite behind whenever a session ends between
   * games.
   */
  private ensureStore(): HistoryStore {
    if (this.store) return this.store;
    // One reading of the clock for the name and the timestamp, so a file
    // called 12-00-00 does not say it started at 12-00-01.
    const at = this.now();
    const path = this.nextGamePath(at);
    const store = new HistoryStore(path);
    store.setMeta("map", this.map);
    store.setMeta("mode", this.mode);
    store.setMeta("started_at", at.toISOString());
    // Identity that survives the file being renamed or moved, which a path
    // does not, and which costs one line now against a migration later.
    store.setMeta("game_id", randomUUID());
    // §6.4 files a replay opened for viewing as a game too, with
    // `source = replay`. Phase 6 writes those; saying which kind this one is
    // now means nothing has to guess later.
    store.setMeta("source", "live");
    if (this.bvb) store.setMeta("watched_seat", String(this.watchSeat));
    // Who the bot played, by name. Player ids follow the order they were set
    // up in: the bot is 1, then each AI.
    if (this.mode === "A") {
      store.setMeta(
        "opponents",
        JSON.stringify(this.opponents.map((ai, index) => ({ player_id: index + 2, ...describeOpponent(ai) })))
      );
    }
    if (this.appVersion) store.setMeta("app_version", this.appVersion);
    this.store = store;
    this.gameFile = path;
    this.log(`recording to ${path}`);
    this.announce();
    return store;
  }

  /**
   * A map with fewer start locations than players drops the extra AIs, and
   * SC2 says nothing about it (measured on 4.10). The game's own game_info is
   * the only evidence, so it is compared here with what was asked for, and a
   * shortfall is said out loud and written into the game file.
   */
  private checkPlayers(): void {
    if (this.mode !== "A") return;
    const found = this.game.playersInGame;
    const asked = this.game.playersRequested;
    if (found === null || found >= asked) return;
    const missing = asked - found;
    this.warning =
      `This map has room for ${found} players, so ${missing} of the AIs asked for ${missing === 1 ? "was" : "were"} left out. ` +
      "Pick a map with more start locations, such as Flat64.";
    this.log(this.warning);
    this.store?.setMeta("warning", this.warning);
    this.announce();
  }

  private nextGamePath(at: Date): string {
    return uniqueGamePath(join(this.gamesDir, gameFileName(this.map, at)), existsSync);
  }

  /**
   * Brings up the container and the proxy. In Mode A the first game is created
   * here; in Mode B the app waits for the bot to create its own, so the
   * session sits at `clientReady` until one connects.
   */
  async start(): Promise<boolean> {
    if (this.phase !== "idle") return false;
    this.stopping = false;
    this.error = null;
    this.attach();
    this.setPhase("containerDown");

    // A container that is still up when a session starts was left by one that
    // did not stop cleanly, so its client may already be in or creating a
    // game. Start from a known state instead of guessing.
    const ready = await this.client.ensureClientReady({ replaceRunning: true });
    if (!ready.ok) return this.fail(ready.reason ?? "The SC2 client could not be started.");
    if (this.stopping) return false;
    this.setPhase("clientReady");

    try {
      // Seat 1 first: its start creates the game seat 2's bot will join.
      for (const state of this.seats) await state.host.start();
    } catch (err) {
      return this.fail(`The proxy could not start: ${(err as Error).message}`);
    }
    if (this.mode === "A" || this.bvb) this.setPhase("gameCreated");
    this.log(
      this.bvb ? "game created; waiting for both bots" : this.mode === "A" ? "game created; waiting for the bot" : "waiting for the bot to create a game"
    );
    return true;
  }

  private fail(reason: string): boolean {
    this.error = reason;
    this.log(`failed: ${reason}`);
    this.setPhase("failed");
    return false;
  }

  /**
   * One game is over, by whichever of the three signals reached the proxy
   * first. Everything after this point needs the client to itself, so it waits
   * for the bot to let go before asking for the replay or creating the next
   * game: SC2 accepts a single client connection at a time.
   */
  private async onGameEnded(reason: GameEndReason, loop: number): Promise<void> {
    if (this.phase !== "gameCreated" && this.phase !== "inGame" && this.phase !== "clientReady") return;
    this.endReason = reason;
    this.log(`game over at loop ${loop} (${reason})`);
    this.setPhase("ended");

    await this.waitForBotGone();
    if (this.stopping) return;

    await this.finishGame();
    if (this.stopping) return;

    if (this.bvb) {
      // Both clients have to leave the finished game, or the next create_game
      // crashes the host client. A dead client stops the whole container
      // (entrypoint.sh), which is how that case is told apart here.
      for (const state of this.seats) {
        const problem = await state.host.leaveGame();
        if (problem) this.log(`player ${state.seat}'s client did not leave the game: ${problem}`);
      }
      // Stopping the session removes the container too, and can land while
      // the clients are leaving; that is the user stopping, not a client dying.
      const container = await this.client.containerStatus();
      if (this.stopping) return;
      if (container !== "running") {
        this.fail("An SC2 client stopped, and the container with it. Start the session again.");
        return;
      }
      this.watchSeat = this.nextWatchSeat;
      await this.beginNextGame();
    } else if (this.mode === "A") {
      await this.beginNextGame();
    } else {
      // Mode B's next game is the bot's to create. Reset now so its first
      // frames are recorded as a new game rather than continuing this one.
      this.game.resetForNewGame();
      this.setPhase("clientReady");
      this.log("waiting for the bot to create the next game");
    }
  }

  /**
   * Writes what the catalog will show about how this game went (§6.3's
   * `meta` holds the result; §6.4's `incomplete` is the absence of an
   * `ended_at`).
   *
   * Two of the three endings produce no result at all: a clean `leave_game`
   * and a bot that vanishes leave SC2 with nothing to report. Those games get
   * `result = unknown` and an `end_reason` that says which it was, rather than
   * a winner invented from the fact that somebody stopped playing. The raw
   * array is kept beside the resolved answer so a game whose player ids never
   * lined up can still be looked at.
   */
  private writeOutcome(store: HistoryStore): void {
    if (this.endReason) store.setMeta("end_reason", this.endReason);

    // Either seat's proxy may have seen the result; the watched one first.
    const watched = this.watched.host;
    const results = watched.lastResult ?? this.seats.map((state) => state.host.lastResult).find((r) => r && r.length > 0) ?? null;

    // Which bot was which, and the name each joined under, so a recording
    // can name a unit's owner. Every game, not only BvB: a one-bot game has
    // one entry, with no seat.
    const players = this.seats.map((state) => ({
      seat: this.bvb ? state.seat : null,
      player_id: state.host.botPlayerId,
      name: state.host.botName,
      result: results?.find((entry) => entry.player_id === state.host.botPlayerId)?.result ?? "unknown",
    }));
    store.setMeta("players", JSON.stringify(players));

    if (!results || results.length === 0) {
      store.setMeta("result", "unknown");
      return;
    }

    store.setMeta("player_result", JSON.stringify(results));
    const botPlayerId = watched.botPlayerId;
    if (botPlayerId !== null) store.setMeta("bot_player_id", String(botPlayerId));

    const ours = botPlayerId === null ? undefined : results.find((entry) => entry.player_id === botPlayerId);
    store.setMeta("result", ours ? ours.result : "unknown");
  }

  /** Asks for the replay, closes the game file, and counts the game. The
   * recording is closed even when the replay fails: a missing .SC2Replay is an
   * inconvenience, an unflushed .sqlite is lost work. */
  private async finishGame(): Promise<void> {
    const store = this.store;
    if (!store) return;

    const replay = await this.game.saveReplay();
    if (replay && this.gameFile) {
      const path = replayPathFor(this.gameFile);
      try {
        writeFileSync(path, replay);
        this.log(`replay saved to ${path} (${replay.length} bytes)`);
      } catch (err) {
        this.log(`replay could not be written: ${(err as Error).message}`);
      }
    } else {
      this.log("no replay was returned by the client");
    }

    this.writeOutcome(store);
    store.setMeta("ended_at", this.now().toISOString());
    store.flush();
    store.close();
    this.store = null;
    this.gameFile = null;
    this.endReason = null;
    this.gamesPlayed += 1;
    this.announce();
  }

  private async beginNextGame(): Promise<void> {
    for (const state of this.seats) state.host.resetForNewGame();
    this.warning = null;
    try {
      await this.game.createGame();
    } catch (err) {
      this.fail(`The next game could not be created: ${(err as Error).message}`);
      return;
    }
    this.setPhase("gameCreated");
    this.log(this.bvb ? "next game created; waiting for both bots" : "next game created; waiting for the bot");
  }

  /**
   * Waits for the bot to disconnect, with no timeout, on purpose. A bot paused
   * on a breakpoint after the game ends is still a bot the user is working on
   * (§4.2 forbids timeouts changing state), so the session waits for it or for
   * the user to stop the session, and says which it is waiting for.
   */
  private waitForBotGone(): Promise<void> {
    if (this.seats.every((state) => !state.botConnected)) return Promise.resolve();
    this.log(this.bvb ? "waiting for both bots to disconnect before saving the replay" : "waiting for the bot to disconnect before saving the replay");
    return new Promise((resolve) => this.botGoneWaiters.push(resolve));
  }

  private releaseBotWaiters(): void {
    const waiters = this.botGoneWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  /**
   * Ends the session and leaves nothing running: the relay drops, the current
   * recording is closed with whatever it has, and the container goes away.
   * Keeping the container alive would save eight seconds on the next start and
   * cost a stray container after every quit.
   */
  async stop(): Promise<void> {
    if (this.phase === "idle" || this.phase === "stopped") return;
    this.stopping = true;
    this.releaseBotWaiters();
    this.detach();
    for (const state of this.seats) state.host.stop();

    if (this.store) {
      // A game abandoned by stopping the session is still a finished file, and
      // it records the same things as one that ended on its own: usually no
      // result, which is the truth about it.
      this.writeOutcome(this.store);
      this.store.setMeta("ended_at", this.now().toISOString());
      this.store.flush();
      this.store.close();
      this.store = null;
      this.gameFile = null;
      this.endReason = null;
    }

    await this.client.stopContainer();
    for (const state of this.seats) state.botConnected = false;
    this.setPhase("stopped");
  }
}
