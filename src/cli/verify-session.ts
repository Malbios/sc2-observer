/**
 * Checks the session state machine without Docker, SC2 or a bot.
 *
 * The controller's whole job is sequencing things that each take seconds and
 * only exist together: a container, a client that accepts one connection, a
 * bot that comes and goes, and a file per game. Finding out live that the
 * second game overwrote the first one's file, or that a replay was requested
 * while the bot still held the socket, costs a full game each time. The
 * container and the proxy go in behind interfaces so all of that can be driven
 * in milliseconds; the store is the real one, writing real files to a temp
 * folder, because that is the part where being wrong is expensive.
 *
 * Run with: node dist/cli/verify-session.js
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { EventBus } from "../bus/EventBus";
import { SC2_STATUS } from "../protocol/status";
import { gameFileName, replayPathFor } from "../history/gameFiles";
import { ClientHost, GameHost, SessionController } from "../session/SessionController";
import type { SessionPhase } from "../shared/ipc-types";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "ok  " : "FAIL"} ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  if (!pass) failures++;
}

/** Lets every pending microtask and immediate run, so the controller's async
 * reaction to a bus event has finished before the next assertion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

// -- fakes -----------------------------------------------------------------

class FakeClient implements ClientHost {
  readonly hostPort = 5001;
  ready = true;
  reason: string | null = null;
  ensureCalls = 0;
  stopCalls = 0;
  replaceRequested: boolean | undefined = undefined;

  async ensureClientReady(options: { replaceRunning?: boolean } = {}): Promise<{ ok: boolean; reason: string | null }> {
    this.ensureCalls++;
    this.replaceRequested = options.replaceRunning;
    return { ok: this.ready, reason: this.reason };
  }

  async stopContainer(): Promise<void> {
    this.stopCalls++;
  }

  /** What `docker inspect` would say after a game; "exited" stands for a
   * client that died and took the container with it. */
  container: "running" | "exited" | "missing" = "running";

  async containerStatus(): Promise<"running" | "exited" | "missing"> {
    return this.container;
  }
}

class FakeGame implements GameHost {
  /** Shared between the seats of one session, so the test can see the order
   * of the calls that need a client to themselves across both proxies. */
  constructor(
    readonly sessionId = "s",
    private readonly calls: string[] = []
  ) {}
  botConnected = false;
  currentLoop = 0;
  lastResult: { player_id: number; result: string }[] | null = null;
  botPlayerId: number | null = null;
  botName: string | null = null;
  leaveCalls = 0;
  startCalls = 0;
  stopCalls = 0;
  createCalls = 0;
  resetCalls = 0;
  replayCalls = 0;
  /** What the client would answer; null stands for a failed save. */
  replay: Uint8Array | null = new Uint8Array([1, 2, 3, 4]);
  /** Order of the calls that need the client to themselves, so the test can
   * see that no bot was attached at the time. */
  exclusiveCallsWhileBotAttached = 0;

  async start(): Promise<void> {
    this.startCalls++;
  }

  stop(): void {
    this.stopCalls++;
  }

  async createGame(): Promise<void> {
    this.createCalls++;
    this.calls.push(`${this.sessionId}:create`);
    if (this.botConnected) this.exclusiveCallsWhileBotAttached++;
  }

  async saveReplay(): Promise<Uint8Array | null> {
    this.replayCalls++;
    this.calls.push(`${this.sessionId}:replay`);
    if (this.botConnected) this.exclusiveCallsWhileBotAttached++;
    return this.replay;
  }

  async leaveGame(): Promise<string | null> {
    this.leaveCalls++;
    this.calls.push(`${this.sessionId}:leave`);
    if (this.botConnected) this.exclusiveCallsWhileBotAttached++;
    return null;
  }

  resetForNewGame(): void {
    this.resetCalls++;
    // The real proxy clears these here, and a game inheriting the last one's
    // result is the bug this method exists for.
    this.lastResult = null;
    this.botPlayerId = null;
    this.botName = null;
  }
}

interface Harness {
  bus: EventBus;
  client: FakeClient;
  game: FakeGame;
  controller: SessionController;
  gamesDir: string;
  phases: SessionPhase[];
  frame(loop: number): void;
  botJoins(): void;
  botLeaves(): void;
  status(value: number): void;
  ends(reason: "result" | "status" | "botClosed", loop: number): void;
  files(): string[];
}

function harness(mode: "A" | "B" = "A"): Harness {
  const bus = new EventBus();
  const client = new FakeClient();
  const game = new FakeGame();
  const gamesDir = mkdtempSync(join(tmpdir(), "spectator-session-"));

  // A clock that advances a second per reading, so two games in one run get
  // two names without the test having to wait for a real second to pass.
  let seconds = 0;
  const now = (): Date => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds++));

  const phases: SessionPhase[] = [];
  bus.on("sessionState", (state) => {
    if (phases[phases.length - 1] !== state.phase) phases.push(state.phase);
  });

  const controller = new SessionController({
    bus,
    dockerfileDir: "unused",
    mapsDir: "unused",
    gamesDir,
    map: "TorchesAIE.SC2Map",
    mode,
    client,
    game,
    now,
  });

  return {
    bus,
    client,
    game,
    controller,
    gamesDir,
    phases,
    frame(loop: number): void {
      game.currentLoop = loop;
      bus.emit("frame", {
        sessionId: "s",
        loop,
        kind: "observation",
        direction: "response",
        bytes: new Uint8Array([0x08, loop & 0x7f]),
      });
    },
    botJoins(): void {
      game.botConnected = true;
      bus.emit("botConnection", { sessionId: "s", connected: true, loop: game.currentLoop });
    },
    botLeaves(): void {
      game.botConnected = false;
      bus.emit("botConnection", { sessionId: "s", connected: false, loop: game.currentLoop });
    },
    status(value: number): void {
      bus.emit("clientStatus", { sessionId: "s", status: value, previous: null });
    },
    ends(reason: "result" | "status" | "botClosed", loop: number): void {
      bus.emit("gameEnded", { sessionId: "s", loop, reason });
    },
    files(): string[] {
      return readdirSync(gamesDir).sort();
    },
  };
}

function metaOf(path: string): Record<string, string> {
  const db = new Database(path, { readonly: true });
  const rows = db.prepare("select key, value from meta").all() as { key: string; value: string }[];
  db.close();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function frameCount(path: string): number {
  const db = new Database(path, { readonly: true });
  const row = db.prepare("select count(*) c from frames").get() as { c: number };
  db.close();
  return row.c;
}

// -- checks ----------------------------------------------------------------

function checkNaming(): void {
  const at = new Date(Date.UTC(2026, 8, 21, 12, 33, 53, 235));
  check("a game file is named for its map and second", gameFileName("TorchesAIE.SC2Map", at), "2026-09-21_12-33-53-TorchesAIE.sqlite");
  check("a map name with spaces loses them", gameFileName("Ancient Cistern LE.SC2Map", at), "2026-09-21_12-33-53-AncientCisternLE.sqlite");
  check("the replay sits beside its recording", replayPathFor("C:/games/a.sqlite"), "C:/games/a.SC2Replay");
}

async function checkStartup(): Promise<void> {
  const h = harness("A");
  const started = await h.controller.start();
  check("Mode A starts", started, true);
  check("Mode A creates the first game", h.game.createCalls, 0); // the proxy's own start() does it
  check("the proxy was started once", h.game.startCalls, 1);
  check("Mode A reaches gameCreated", h.controller.status.phase, "gameCreated");
  check("the phases so far", h.phases, ["containerDown", "clientReady", "gameCreated"]);
  check("no file exists before the first frame", h.files(), []);
  check("the container was brought up once", h.client.ensureCalls, 1);
  check("a leftover container is replaced, not reused", h.client.replaceRequested, true);
  await h.controller.stop();

  const b = harness("B");
  await b.controller.start();
  check("Mode B waits at clientReady", b.controller.status.phase, "clientReady");
  check("Mode B does not create a game", b.game.createCalls, 0);
  await b.controller.stop();
}

async function checkFailedStartup(): Promise<void> {
  const h = harness("A");
  h.client.ready = false;
  h.client.reason = "Docker was not found on PATH. Install Docker Desktop.";
  const started = await h.controller.start();
  check("a session with no Docker does not start", started, false);
  check("the failure is reported as a phase", h.controller.status.phase, "failed");
  check("the reason is carried to the UI", h.controller.status.error, h.client.reason);
  check("the proxy is never started without a client", h.game.startCalls, 0);
  check("no game file is left behind", h.files(), []);
}

async function checkOneGame(): Promise<void> {
  const h = harness("A");
  await h.controller.start();
  h.botJoins();
  h.status(SC2_STATUS.inGame);
  check("a joined bot puts the session in game", h.controller.status.phase, "inGame");

  h.frame(0);
  h.frame(100);
  const gameFile = h.controller.status.gameFile;
  check("the first frame opens a file", gameFile !== null, true);
  check("exactly one game file exists", h.files().filter((f) => f.endsWith(".sqlite")).length, 1);

  // What the client reported, and which player the bot joined as, both known
  // by the time the game ends.
  h.game.botPlayerId = 1;
  h.game.lastResult = [
    { player_id: 1, result: "Defeat" },
    { player_id: 2, result: "Victory" },
  ];
  h.ends("result", 100);
  await settle();
  check("the session is in the ended phase", h.controller.status.phase, "ended");
  check("no replay is requested while the bot holds the client", h.game.replayCalls, 0);
  check("no next game is created while the bot holds the client", h.game.createCalls, 0);

  h.botLeaves();
  await settle();
  check("the replay is requested once the bot is gone", h.game.replayCalls, 1);
  check("nothing exclusive ran while a bot was attached", h.game.exclusiveCallsWhileBotAttached, 0);
  check("the replay is written beside the recording", existsSync(replayPathFor(gameFile!)), true);
  check("the replay holds what the client returned", Array.from(readFileSync(replayPathFor(gameFile!))), [1, 2, 3, 4]);

  const meta = metaOf(gameFile!);
  check("the recording knows its map", meta.map, "TorchesAIE.SC2Map");
  check("the recording knows its mode", meta.mode, "A");
  check("the recording is closed with an end time", typeof meta.ended_at, "string");
  check("the frames were flushed", frameCount(gameFile!), 2);
  check("the game is counted", h.controller.status.gamesPlayed, 1);

  // The catalog's headline column: the bot's own outcome, not the list of
  // everyone's, and the reason it ended beside it.
  check("the recording knows how it ended", meta.end_reason, "result");
  check("the result is the bot's own", meta.result, "Defeat");
  check("the bot's player id is recorded", meta.bot_player_id, "1");
  check("the raw result is kept too", JSON.parse(meta.player_result ?? "[]").length, 2);
  check("the game has an id of its own", typeof meta.game_id, "string");
  check("the game says where it came from", meta.source, "live");

  check("Mode A creates the next game", h.game.createCalls, 1);
  check("the proxy is reset before it does", h.game.resetCalls, 1);
  check("the session is waiting for the next bot", h.controller.status.phase, "gameCreated");
  check("the next game has no file yet", h.controller.status.gameFile, null);

  // -- the second game, which is the bug resetForNewGame exists for --------
  h.botJoins();
  h.status(SC2_STATUS.inGame);
  h.frame(0);
  h.ends("botClosed", 0);
  h.botLeaves();
  await settle();
  check("the second game got its own file", h.files().filter((f) => f.endsWith(".sqlite")).length, 2);
  check("both games were counted", h.controller.status.gamesPlayed, 2);
  check("the proxy was reset once per finished game", h.game.resetCalls, 2);

  // A bot that vanished produces no result at all, and the second game must
  // not inherit the first one's Defeat.
  const second = metaOf(join(h.gamesDir, h.files().filter((f) => f.endsWith(".sqlite")).sort()[1]!));
  check("a game with no outcome says so", second.result, "unknown");
  check("and records why it ended", second.end_reason, "botClosed");
  check("no result is carried over from the last game", second.player_result, undefined);
  check("each game gets its own id", second.game_id === meta.game_id, false);

  await h.controller.stop();
}

async function checkRepeatedEndSignals(): Promise<void> {
  const h = harness("A");
  await h.controller.start();
  h.botJoins();
  h.status(SC2_STATUS.inGame);
  h.frame(10);
  // A surrender repeats player_result in every later observation, so the
  // proxy debounces; the controller must not rely on that alone.
  h.ends("result", 10);
  h.ends("result", 11);
  h.ends("status", 12);
  h.botLeaves();
  await settle();
  check("one game ends once however many signals arrive", h.controller.status.gamesPlayed, 1);
  check("one replay was requested", h.game.replayCalls, 1);
  check("one next game was created", h.game.createCalls, 1);
  await h.controller.stop();
}

async function checkNoReplay(): Promise<void> {
  const h = harness("A");
  h.game.replay = null;
  await h.controller.start();
  h.botJoins();
  h.frame(5);
  const gameFile = h.controller.status.gameFile!;
  h.ends("status", 5);
  h.botLeaves();
  await settle();
  check("a failed replay leaves no file", h.files().some((f) => f.endsWith(".SC2Replay")), false);
  check("a failed replay still closes the recording", typeof metaOf(gameFile).ended_at, "string");
  check("a failed replay still counts the game", h.controller.status.gamesPlayed, 1);
  check("a failed replay does not stop the next game", h.game.createCalls, 1);
  await h.controller.stop();
}

async function checkStopWhileWaiting(): Promise<void> {
  const h = harness("A");
  await h.controller.start();
  h.botJoins();
  h.frame(7);
  const gameFile = h.controller.status.gameFile!;
  h.ends("result", 7);
  await settle();
  check("the session is waiting on the bot", h.controller.status.phase, "ended");

  await h.controller.stop();
  await settle();
  check("stopping does not ask a still-attached bot's client for a replay", h.game.replayCalls, 0);
  check("stopping does not start another game", h.game.createCalls, 0);
  check("stopping closes the recording it had", typeof metaOf(gameFile).ended_at, "string");
  check("stopping keeps what was recorded", frameCount(gameFile), 1);
  check("stopping removes the container", h.client.stopCalls, 1);
  check("stopping drops the relay", h.game.stopCalls, 1);
  check("the final phase is stopped", h.controller.status.phase, "stopped");

  // A stopped session is deaf: a late frame must not resurrect it.
  h.frame(8);
  check("a frame after stopping opens no new file", h.files().filter((f) => f.endsWith(".sqlite")).length, 1);
}

async function checkModeBNextGame(): Promise<void> {
  const h = harness("B");
  await h.controller.start();
  h.botJoins();
  h.status(SC2_STATUS.inGame);
  h.frame(20);
  h.ends("botClosed", 20);
  h.botLeaves();
  await settle();
  check("Mode B never creates a game itself", h.game.createCalls, 0);
  check("Mode B resets for the bot's next game", h.game.resetCalls, 1);
  check("Mode B goes back to waiting", h.controller.status.phase, "clientReady");

  h.botJoins();
  h.frame(0);
  check("Mode B's second game gets its own file", h.files().filter((f) => f.endsWith(".sqlite")).length, 2);
  await h.controller.stop();
}

// -- a game between two bots ------------------------------------------------

interface SeatDriver {
  game: FakeGame;
  frame(loop: number): void;
  joins(): void;
  leaves(): void;
  ends(reason: "result" | "status" | "botClosed", loop: number): void;
}

function botVsBot(): {
  bus: EventBus;
  client: FakeClient;
  controller: SessionController;
  calls: string[];
  seats: [SeatDriver, SeatDriver];
  files(): string[];
} {
  const bus = new EventBus();
  const client = new FakeClient();
  const calls: string[] = [];
  const one = new FakeGame("p1", calls);
  const two = new FakeGame("p2", calls);
  const gamesDir = mkdtempSync(join(tmpdir(), "spectator-bvb-"));
  let seconds = 0;
  const controller = new SessionController({
    bus,
    dockerfileDir: "unused",
    mapsDir: "unused",
    gamesDir,
    map: "TorchesAIE.SC2Map",
    mode: "BvB",
    client,
    seatGames: [one, two],
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds++)),
  });
  const driver = (game: FakeGame): SeatDriver => ({
    game,
    frame(loop: number): void {
      game.currentLoop = loop;
      bus.emit("frame", { sessionId: game.sessionId, loop, kind: "observation", direction: "response", bytes: new Uint8Array([0x08, loop & 0x7f]) });
    },
    joins(): void {
      game.botConnected = true;
      bus.emit("botConnection", { sessionId: game.sessionId, connected: true, loop: game.currentLoop });
    },
    leaves(): void {
      game.botConnected = false;
      bus.emit("botConnection", { sessionId: game.sessionId, connected: false, loop: game.currentLoop });
    },
    ends(reason, loop): void {
      bus.emit("gameEnded", { sessionId: game.sessionId, loop, reason });
    },
  });
  return {
    bus,
    client,
    controller,
    calls,
    seats: [driver(one), driver(two)],
    files: () => readdirSync(gamesDir).sort().map((name) => join(gamesDir, name)),
  };
}

async function checkBotVsBot(): Promise<void> {
  const h = botVsBot();
  const [p1, p2] = h.seats;
  await h.controller.start();
  check("both proxies are started", [p1.game.startCalls, p2.game.startCalls], [1, 1]);
  check("the game is created and waits for both bots", h.controller.status.phase, "gameCreated");
  check(
    "each seat is told how to start its bot",
    h.controller.status.seats?.map((seat) => [seat.seat, seat.ladderServer, seat.gamePort, seat.startPort]),
    [
      [1, "127.0.0.1", 5000, 5100],
      [2, "127.0.0.1", 5010, 5100],
    ]
  );
  check("player 1 is watched by default", h.controller.status.watchSeat, 1);

  // Each proxy sees its own bot's view. Only the watched one is recorded.
  p1.joins();
  p2.joins();
  p2.frame(1);
  check("the unwatched seat's frames open no file", h.files().length, 0);
  p1.frame(1);
  p1.frame(9);
  p2.frame(9);
  p1.frame(17);
  const [first] = h.files().filter((f) => f.endsWith(".sqlite"));
  check("the watched seat's frames open the game file", first !== undefined, true);

  // Asking for player 2 mid-game waits for the next game: one file, one view.
  h.controller.setWatchedSeat(2);
  check("a switch mid-game waits for the next game", [h.controller.status.watchSeat, h.controller.status.nextWatchSeat], [1, 2]);

  p1.game.botPlayerId = 1;
  p1.game.botName = "MyBot";
  p2.game.botPlayerId = 2;
  p2.game.botName = "OtherBot";
  p1.game.lastResult = [
    { player_id: 1, result: "Defeat" },
    { player_id: 2, result: "Victory" },
  ];
  p1.ends("result", 17);
  p2.ends("result", 17);
  p1.leaves();
  await settle();
  check("one bot gone is not enough", h.controller.status.phase, "ended");
  check("no replay while the other bot still holds its client", p1.game.replayCalls, 0);

  p2.leaves();
  await settle();
  check("the replay is saved, both clients leave, then the next game", h.calls, ["p1:replay", "p1:leave", "p2:leave", "p1:create"]);
  check("nothing that needs a client ran while a bot held it", p1.game.exclusiveCallsWhileBotAttached + p2.game.exclusiveCallsWhileBotAttached, 0);
  check("the next game is waiting for both bots", h.controller.status.phase, "gameCreated");
  check("and it watches player 2", h.controller.status.watchSeat, 2);

  // Counted once the file is closed, which is when the store has written it.
  check("the watched seat's frames are recorded, and only those", frameCount(first!), 3);
  const meta = metaOf(first!);
  check("the file says it was a game between two bots", [meta.mode, meta.watched_seat], ["BvB", "1"]);
  check("the result is the watched player's", [meta.bot_player_id, meta.result], ["1", "Defeat"]);
  check("and it says which bot was which", JSON.parse(meta.players!), [
    { seat: 1, player_id: 1, name: "MyBot", result: "Defeat" },
    { seat: 2, player_id: 2, name: "OtherBot", result: "Victory" },
  ]);

  // The second game records player 2's view.
  p1.joins();
  p2.joins();
  p1.frame(3);
  p2.frame(3);
  const second = h.files().filter((f) => f.endsWith(".sqlite") && f !== first);
  check("the next game gets its own file", second.length, 1);
  await h.controller.stop();
  check("which holds player 2's view", [frameCount(second[0]!), metaOf(second[0]!).watched_seat], [1, "2"]);
  check("stopping stops both proxies", [p1.game.stopCalls, p2.game.stopCalls], [1, 1]);
}

/** A dead client stops the container (entrypoint.sh). The other bot's game
 * would hang forever, so the session says so and stops instead of creating a
 * next game on a client that is not there. */
async function checkBotVsBotDeadClient(): Promise<void> {
  const h = botVsBot();
  const [p1, p2] = h.seats;
  await h.controller.start();
  p1.joins();
  p2.joins();
  p1.frame(1);
  h.client.container = "exited";
  p1.ends("botClosed", 1);
  p1.leaves();
  p2.leaves();
  await settle();
  check("a stopped container fails the session", h.controller.status.phase, "failed");
  check("with a message that says what to do", /Start the session again/.test(h.controller.status.error ?? ""), true);
  check("and no next game is created", p1.game.createCalls, 0);
  check("the game that was cut short is still closed", typeof metaOf(h.files().find((f) => f.endsWith(".sqlite"))!).ended_at, "string");
  await h.controller.stop();
}

/** Stopping removes the container, and a stop can land while the clients are
 * leaving a finished game. That must read as the user stopping, not as a
 * client that died. Seen in the app: Stop clicked as a game ended. */
async function checkBotVsBotStopWhileLeaving(): Promise<void> {
  const h = botVsBot();
  const [p1, p2] = h.seats;
  await h.controller.start();
  p1.joins();
  p2.joins();
  p1.frame(1);
  // The container is gone by the time the session asks, because the stop
  // below has already removed it.
  p2.game.leaveGame = async (): Promise<string | null> => {
    h.client.container = "missing";
    await h.controller.stop();
    return null;
  };
  p1.ends("result", 1);
  p1.leaves();
  p2.leaves();
  await settle();
  check("a stop during the leave ends as stopped", h.controller.status.phase, "stopped");
  check("with no error", h.controller.status.error, null);
}

async function main(): Promise<void> {
  checkNaming();
  await checkStartup();
  await checkFailedStartup();
  await checkOneGame();
  await checkRepeatedEndSignals();
  await checkNoReplay();
  await checkStopWhileWaiting();
  await checkModeBNextGame();
  await checkBotVsBot();
  await checkBotVsBotDeadClient();
  await checkBotVsBotStopWhileLeaving();

  console.log(failures === 0 ? "\nall session checks passed" : `\n${failures} session check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
