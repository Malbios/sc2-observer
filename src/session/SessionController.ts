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
import { DockerManager } from "../docker/DockerManager";
import { gameFileName, replayPathFor } from "../history/gameFiles";
import { HistoryStore } from "../history/HistoryStore";
import { GameMode, GameProxy, PlayerResult } from "../proxy/GameProxy";
import { SC2_STATUS, statusName } from "../protocol/status";
import type { SessionPhase, SessionStatusIpc } from "../shared/ipc-types";

/**
 * The parts of the Docker manager a session needs. Declared as an interface so
 * the state machine can be driven without Docker, which is the only way to
 * test it deterministically (§7).
 */
export interface ClientHost {
  readonly hostPort: number;
  ensureClientReady(options?: { replaceRunning?: boolean }): Promise<{ ok: boolean; reason: string | null }>;
  stopContainer(): Promise<void>;
}

/** The parts of the proxy a session needs, for the same reason. */
export interface GameHost {
  readonly botConnected: boolean;
  readonly currentLoop: number;
  /** The outcome, if the ending produced one. Read at the end of a game
   * rather than delivered with `gameEnded`; see `GameProxy.lastResult`. */
  readonly lastResult: PlayerResult[] | null;
  readonly botPlayerId: number | null;
  start(): Promise<void>;
  stop(): void;
  createGame(): Promise<void>;
  saveReplay(): Promise<Uint8Array | null>;
  resetForNewGame(): void;
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
  opponentRace?: number;
  opponentDifficulty?: number;
  hostPort?: number;
  botPort?: number;
  /** Injected in tests; a real manager and proxy are built when absent. */
  client?: ClientHost;
  game?: GameHost;
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
  private readonly game: GameHost;
  /** Why the game that is finishing ended, held between the signal and the
   * write because `finishGame` runs after waiting for the bot to let go. */
  private endReason: GameEndReason | null = null;

  private phase: SessionPhase = "idle";
  private store: HistoryStore | null = null;
  private gameFile: string | null = null;
  private gamesPlayed = 0;
  private botConnected = false;
  private clientStatus: number | null = null;
  private error: string | null = null;
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

    this.client =
      options.client ??
      new DockerManager({
        bus: options.bus,
        dockerfileDir: options.dockerfileDir,
        mapsDir: options.mapsDir,
        hostPort: options.hostPort,
      });

    this.game =
      options.game ??
      new GameProxy({
        sessionId: `session-${Date.now()}`,
        bus: options.bus,
        mapPath: options.map,
        mode: this.mode,
        opponentRace: options.opponentRace,
        opponentDifficulty: options.opponentDifficulty,
        botPort: options.botPort,
        sc2Port: this.client.hostPort,
      });
  }

  get status(): SessionStatusIpc {
    return {
      phase: this.phase,
      mode: this.mode,
      map: this.map,
      gameFile: this.gameFile,
      gamesPlayed: this.gamesPlayed,
      loop: this.game.currentLoop,
      botConnected: this.botConnected,
      clientStatus: statusName(this.clientStatus),
      error: this.error,
    };
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
    const onFrame = (event: FrameEvent): void => {
      this.ensureStore().recordFrame(event);
    };
    const onStatus = (event: ClientStatusEvent): void => {
      this.clientStatus = event.status;
      if (event.status === SC2_STATUS.inGame && this.phase !== "ended") this.setPhase("inGame");
      else this.announce();
    };
    const onBot = (event: BotConnectionEvent): void => {
      this.botConnected = event.connected;
      if (!event.connected) this.releaseBotWaiters();
      this.announce();
    };
    const onEnded = (event: GameEndedEvent): void => {
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
    if (this.appVersion) store.setMeta("app_version", this.appVersion);
    this.store = store;
    this.gameFile = path;
    this.log(`recording to ${path}`);
    this.announce();
    return store;
  }

  /**
   * Names are per second, so two games that both start within one second
   * would otherwise open the same file and quietly merge into one recording.
   * That only happens when a game ends the instant it starts, which is exactly
   * the case worth being able to look at afterwards.
   */
  private nextGamePath(at: Date): string {
    const base = join(this.gamesDir, gameFileName(this.map, at));
    if (!existsSync(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = base.replace(/\.sqlite$/, `-${n}.sqlite`);
      if (!existsSync(candidate)) return candidate;
    }
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
      await this.game.start();
    } catch (err) {
      return this.fail(`The proxy could not start: ${(err as Error).message}`);
    }
    if (this.mode === "A") this.setPhase("gameCreated");
    this.log(this.mode === "A" ? "game created; waiting for the bot" : "waiting for the bot to create a game");
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

    if (this.mode === "A") {
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

    const results = this.game.lastResult;
    if (!results || results.length === 0) {
      store.setMeta("result", "unknown");
      return;
    }

    store.setMeta("player_result", JSON.stringify(results));
    const botPlayerId = this.game.botPlayerId;
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
    this.game.resetForNewGame();
    try {
      await this.game.createGame();
    } catch (err) {
      this.fail(`The next game could not be created: ${(err as Error).message}`);
      return;
    }
    this.setPhase("gameCreated");
    this.log("next game created; waiting for the bot");
  }

  /**
   * Waits for the bot to disconnect, with no timeout, on purpose. A bot paused
   * on a breakpoint after the game ends is still a bot the user is working on
   * (§4.2 forbids timeouts changing state), so the session waits for it or for
   * the user to stop the session, and says which it is waiting for.
   */
  private waitForBotGone(): Promise<void> {
    if (!this.botConnected) return Promise.resolve();
    this.log("waiting for the bot to disconnect before saving the replay");
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
    this.game.stop();

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
    this.botConnected = false;
    this.setPhase("stopped");
  }
}
