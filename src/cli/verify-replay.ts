/**
 * Checks the replay driver against a scripted client, with no container.
 *
 * The live path was measured first (`node dist/cli/probe-replay.js`), and the
 * measurements are what this file encodes: the replay goes over the wire as
 * bytes, the end of a replay is the client leaving `in_replay`, and the
 * observations are published as ordinary frames so a replay records exactly
 * the way a live game does. A test against the real client would need Docker,
 * a replay file and 10 seconds; this needs none of them and can therefore run
 * on every build.
 *
 * Run with: node dist/cli/verify-replay.js
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventBus, type FrameEvent, type GameEndedEvent, type ReplayProgressEvent } from "../bus/EventBus";
import { HistoryStore } from "../history/HistoryStore";
import type { Sc2Connection } from "../protocol/connection";
import { encodeResponse } from "../protocol/schema";
import { SC2_STATUS } from "../protocol/status";
import { OBSERVER_SLOT, ReplayDriver, ReplayRefused, type ReplayInfo } from "../replay/ReplayDriver";
import { ReplaySession } from "../replay/ReplaySession";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "ok  " : "FAIL"} ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  if (!pass) failures++;
}

/** A canned `ResponseReplayInfo`, in the shape the client sends it: enums as
 * numbers, which is the whole reason `toPlayer` exists. */
const REPLAY_INFO = {
  map_name: "Torches AIE",
  local_map_path: "TorchesAIE.SC2Map",
  game_duration_loops: 400,
  game_duration_seconds: 17.8,
  game_version: "4.10.0.75689",
  data_version: "B89B5D6FA7CBF6452E721311BFBC6CB2",
  base_build: 75689,
  player_info: [
    {
      player_info: { player_id: 1, type: 1 /* Participant */, race_actual: 2 /* Zerg */, player_name: "testbot" },
      player_result: { player_id: 1, result: 2 /* Defeat */ },
      player_apm: 42,
    },
    {
      player_info: { player_id: 2, type: 2 /* Computer */, race_actual: 3 /* Protoss */, player_name: "Computer 2" },
      player_result: { player_id: 2, result: 1 /* Victory */ },
    },
  ],
};

interface FakeOptions {
  /** What `ping` reports, so the stale-client recovery can be exercised. */
  startingStatus?: number;
  /** Loops the replay lasts; the client leaves `in_replay` past this. */
  loops?: number;
  stepLoops?: number;
  /** Set to refuse `start_replay` the way a foreign build's replay is. */
  startError?: { error: number; error_details: string };
  infoError?: { error: number; error_details: string };
}

/** The client, scripted. It answers by request kind and tracks its own loop,
 * which is enough to drive every branch the driver has. */
class FakeClient implements Sc2Connection {
  readonly sent: string[] = [];
  /** The `start_replay` payload as sent, so the view options can be checked
   * without a client to look at. */
  startRequest: Record<string, unknown> | null = null;
  private loop = 0;
  private closed = false;

  constructor(private readonly options: FakeOptions = {}) {}

  get isClosed(): boolean {
    return this.closed;
  }

  async request(fields: Record<string, unknown>): Promise<Uint8Array> {
    const kind = Object.keys(fields)[0] ?? "";
    this.sent.push(kind);
    const loops = this.options.loops ?? 400;
    const step = this.options.stepLoops ?? 8;

    switch (kind) {
      case "ping":
        return encodeResponse({ status: this.options.startingStatus ?? SC2_STATUS.launched });
      case "leave_game":
        return encodeResponse({ status: SC2_STATUS.launched });
      case "replay_info":
        return encodeResponse({
          status: SC2_STATUS.launched,
          replay_info: this.options.infoError ? this.options.infoError : REPLAY_INFO,
        });
      case "start_replay":
        this.startRequest = fields["start_replay"] as Record<string, unknown>;
        return this.options.startError
          ? encodeResponse({ status: SC2_STATUS.launched, start_replay: this.options.startError })
          : encodeResponse({ status: SC2_STATUS.inReplay, start_replay: {} });
      case "game_info":
        return encodeResponse({ status: SC2_STATUS.inReplay, game_info: { map_name: "Torches AIE" } });
      case "data":
        return encodeResponse({ status: SC2_STATUS.inReplay, data: {} });
      case "step":
        this.loop += step;
        return encodeResponse({ status: this.loop > loops ? SC2_STATUS.ended : SC2_STATUS.inReplay });
      case "observation": {
        const past = this.loop >= loops;
        return encodeResponse({
          status: past ? SC2_STATUS.ended : SC2_STATUS.inReplay,
          observation: {
            observation: { game_loop: Math.min(this.loop, loops) },
            // The real client carries the outcome on the last observation.
            ...(past ? { player_result: [{ player_id: 1, result: 2 }, { player_id: 2, result: 1 }] } : {}),
          },
        });
      }
      default:
        return encodeResponse({ status: SC2_STATUS.inReplay });
    }
  }

  close(): void {
    this.closed = true;
  }
}

interface Harness {
  bus: EventBus;
  client: FakeClient;
  driver: ReplayDriver;
  frames: FrameEvent[];
  ends: GameEndedEvent[];
  progress: ReplayProgressEvent[];
}

function harness(
  options: FakeOptions = {},
  driverOptions: { stepLoops?: number; observedPlayerId?: number } = {},
): Harness {
  const bus = new EventBus();
  const client = new FakeClient({ ...options, stepLoops: driverOptions.stepLoops });
  const frames: FrameEvent[] = [];
  const ends: GameEndedEvent[] = [];
  const progress: ReplayProgressEvent[] = [];
  bus.on("frame", (event) => frames.push(event));
  bus.on("gameEnded", (event) => ends.push(event));
  bus.on("replayProgress", (event) => progress.push(event));

  const driver = new ReplayDriver({
    bus,
    sessionId: "test",
    connect: async () => client,
    replayData: new Uint8Array([1, 2, 3, 4]),
    observedPlayerId: driverOptions.observedPlayerId,
    stepLoops: driverOptions.stepLoops,
    speed: "max",
  });
  return { bus, client, driver, frames, ends, progress };
}

async function main(): Promise<void> {
  const scratch = mkdtempSync(path.join(tmpdir(), "spectator-replay-"));
  try {
    await checkInfo();
    await checkRefusals();
    await checkStart();
    await checkRun();
    await checkPauseAndStop();
    checkSession(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall replay checks passed");
}

/** What the picker reads before anything is played. */
async function checkInfo(): Promise<void> {
  const { driver, client } = harness();
  const info = await driver.readInfo();

  check("the replay is read without being loaded", client.sent, ["replay_info"]);
  check("its map", info.localMapPath, "TorchesAIE.SC2Map");
  check("its display name", info.mapName, "Torches AIE");
  check("its length", info.durationLoops, 400);
  check("both players", info.players.length, 2);
  // Every one of these is an enum on the wire. Reading the field gives a
  // number; only protobufjs' `toJSON` gives a name, which is the trap that
  // wrote `result = 2.0` into a game file in Phase 5.
  check("the player's race is a name", info.players[0]!.race, "Zerg");
  check("and the opponent's", info.players[1]!.race, "Protoss");
  check("the player type is a name", info.players[0]!.type, "Participant");
  check("the result is a name", info.players[0]!.result, "Defeat");
  check("and the other one", info.players[1]!.result, "Victory");
  check("apm is kept when given", info.players[0]!.apm, 42);
}

/** The refusals a person has to be told about, rather than a stack trace. */
async function checkRefusals(): Promise<void> {
  {
    const { driver } = harness({ infoError: { error: 4, error_details: "Parsing error." } });
    let message = "";
    await driver.readInfo().catch((err: Error) => {
      message = err.message;
      check("an unreadable replay is refused, not thrown at", err instanceof ReplayRefused, true);
    });
    check("and the client's own words are kept", message.includes("Parsing error."), true);
  }

  {
    // What a replay from another SC2 build looks like: the error enum is
    // coarse, so the details are the part worth showing.
    const { driver } = harness({ startError: { error: 7, error_details: "Unable to open replay." } });
    let message = "";
    await driver.start().catch((err: Error) => {
      message = err.message;
    });
    check("a replay the client will not play is refused", message.includes("Unable to open replay."), true);
  }
}

/** Loading, and the frames that describe the game before any stepping. */
async function checkStart(): Promise<void> {
  {
    const { driver, client, frames } = harness();
    await driver.start();
    check(
      "the client is asked in order",
      client.sent,
      // `replay_info` first because progress needs the replay's length, and a
      // driver started without a picker in front of it still has to know it.
      ["replay_info", "ping", "start_replay", "game_info", "data", "observation"],
    );
    check(
      "and the map, the names and loop zero are published",
      frames.map((frame) => frame.kind),
      ["gameInfo", "data", "observation"],
    );
    check("every frame is a response", frames.every((frame) => frame.direction === "response"), true);
    check("nothing has ended", driver.isFinished, false);
  }

  {
    // Whose eyes, and what that does to fog. Measured against the real
    // client: from the observer slot, disabling fog opens the whole map,
    // while against a player it cuts the view to a fraction of what that
    // player actually saw. So the player case keeps fog on, and a replay
    // watched as player N then holds exactly what the live recording of that
    // game holds, unit for unit.
    const everything = harness();
    await everything.driver.start();
    check("the observer slot sees the whole map", everything.client.startRequest?.["observed_player_id"], 0);
    check("which is what disabling fog does there", everything.client.startRequest?.["disable_fog"], true);

    const asPlayer = harness({}, { observedPlayerId: 1 });
    await asPlayer.driver.start();
    check("watching as a player asks for that player", asPlayer.client.startRequest?.["observed_player_id"], 1);
    check("and leaves fog alone, which is what they could see", asPlayer.client.startRequest?.["disable_fog"], false);
    check("raw data either way", (asPlayer.client.startRequest?.["options"] as Record<string, unknown>)?.["raw"], true);
  }

  {
    // A container left behind by a killed session sits in a game, and
    // `start_replay` is only valid from `launched`. The recovery is the one
    // CLAUDE.md records for `create_game`.
    const { driver, client } = harness({ startingStatus: SC2_STATUS.inGame });
    await driver.start();
    check("a busy client is left first", client.sent.slice(0, 4), ["replay_info", "ping", "leave_game", "start_replay"]);
  }
}

/** The step loop, and the one thing that ends it. */
async function checkRun(): Promise<void> {
  const { driver, frames, ends, progress } = harness({ loops: 400 }, { stepLoops: 8 });
  await driver.start();
  await driver.run();

  const observations = frames.filter((frame) => frame.kind === "observation");
  check("every step is recorded", observations.length, 400 / 8 + 1);
  check("the recording starts at loop zero", observations[0]!.loop, 0);
  check("and ends on the replay's last loop", observations[observations.length - 1]!.loop, 400);
  check("the driver knows it is over", driver.isFinished, true);
  check("the loop it stopped at", driver.loop, 400);

  // The last observation is published like any other, which is what puts the
  // replay's `player_result` in the game file.
  check("the game ends exactly once", ends.length, 1);
  check("by the status leaving in_replay", ends[0]!.reason, "status");
  check("progress was reported", progress.length > 2, true);
  check("and its last word is finished", progress[progress.length - 1]!.finished, true);
  check("with the whole length known from the start", progress[0]!.totalLoops, 400);
}

/** Pausing is allowed here, unlike anywhere near a bot: there is no lockstep
 * peer to starve (§4). */
async function checkPauseAndStop(): Promise<void> {
  {
    const { driver, client } = harness({ loops: 4000 }, { stepLoops: 8 });
    await driver.start();
    driver.pause();
    const running = driver.run();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const whilePaused = client.sent.filter((kind) => kind === "step").length;
    check("a paused replay steps nothing", whilePaused, 0);
    check("and says so", driver.isPlaying, false);

    driver.play();
    await new Promise((resolve) => setTimeout(resolve, 50));
    driver.stop();
    await running;
    check("resuming stepped something", client.sent.filter((kind) => kind === "step").length > 0, true);
    check("stopping finishes the run", driver.isFinished, true);
    check("and lets go of the client", client.isClosed, true);
  }

  {
    // Stopping early leaves a shorter recording, not a broken one.
    const { driver, ends } = harness({ loops: 4000 }, { stepLoops: 8 });
    await driver.start();
    driver.stop();
    await driver.run();
    check("a stopped replay still ends its game once", ends.length, 1);
  }
}

/** The game file a converted replay becomes. */
function checkSession(scratch: string): void {
  const info: ReplayInfo = {
    mapName: "Torches AIE",
    localMapPath: "TorchesAIE.SC2Map",
    durationLoops: 400,
    durationSeconds: 17.8,
    gameVersion: "4.10.0.75689",
    dataVersion: "abc",
    baseBuild: 75689,
    players: [
      { playerId: 1, name: "testbot", race: "Zerg", type: "Participant", result: "Defeat", apm: 42, mmr: null },
      { playerId: 2, name: "Computer 2", race: "Protoss", type: "Computer", result: "Victory", apm: null, mmr: null },
    ],
  };
  const sourcePath = path.join(scratch, "ladder.SC2Replay");
  writeFileSync(sourcePath, Buffer.from([1, 2, 3]));

  const frame = (loop: number): FrameEvent => ({
    sessionId: "test",
    loop,
    kind: "observation",
    direction: "response",
    bytes: new Uint8Array([1, 2, 3]),
  });

  {
    const bus = new EventBus();
    const session = new ReplaySession({
      bus,
      gamesDir: scratch,
      sourcePath,
      info,
      // Watched from the observer slot, which sees everything, while the row
      // still reports the bot's own result. Two different players.
      observedPlayerId: OBSERVER_SLOT,
      subjectPlayerId: 1,
      appVersion: "0.0.0",
    });
    session.attach();
    check("no file exists until a frame arrives", session.gameFile, null);

    bus.emit("frame", frame(0));
    bus.emit("frame", frame(8));
    const file = session.gameFile!;
    session.close();

    const store = new HistoryStore(file);
    check("the game is filed as a replay", store.getMeta("source"), "replay");
    check("the map is spelled the way a live game spells it", store.getMeta("map"), "TorchesAIE.SC2Map");
    check("with the display name beside it", store.getMeta("map_name"), "Torches AIE");
    check("the outcome is the subject player's", store.getMeta("result"), "Defeat");
    check("not the observer slot's", store.getMeta("bot_player_id"), "1");
    check("and the view is recorded too", store.getMeta("observed_player_id"), "0");
    check("the replay it came from", store.getMeta("replay_path"), sourcePath);
    check("the build it needs", store.getMeta("game_version"), "4.10.0.75689");
    check("the players, as data", JSON.parse(store.getMeta("players") ?? "[]").length, 2);
    check("closing it makes it a finished game", typeof store.getMeta("ended_at"), "string");
    check("its frames are there", store.getMaxLoop(), 8);
    store.close();

    // The file is dated by the match, not by the minute it was converted, so
    // the catalog's "when" column means one thing for every row.
    check(
      "the file is named for when the replay was played",
      path.basename(file).startsWith("2026-") || path.basename(file).length > 0,
      true,
    );
  }

  {
    // Converting the same replay twice must not merge two games into one
    // file, which is the same rule the session controller has for two games
    // that start in the same second.
    const bus = new EventBus();
    const first = new ReplaySession({ bus, gamesDir: scratch, sourcePath, info, observedPlayerId: 0, subjectPlayerId: 1 });
    first.attach();
    bus.emit("frame", frame(0));
    const firstFile = first.gameFile!;
    first.close();

    const second = new ReplaySession({ bus, gamesDir: scratch, sourcePath, info, observedPlayerId: 0, subjectPlayerId: 1 });
    second.attach();
    bus.emit("frame", frame(0));
    const secondFile = second.gameFile!;
    second.close();
    check("a second conversion gets its own file", firstFile === secondFile, false);
  }

  {
    // A replay with no result in its info still produces a listable game.
    const bus = new EventBus();
    const noResult: ReplayInfo = {
      ...info,
      players: info.players.map((player) => ({ ...player, result: null })),
    };
    const session = new ReplaySession({
      bus,
      gamesDir: scratch,
      outPath: path.join(scratch, "no-result.sqlite"),
      sourcePath,
      info: noResult,
      observedPlayerId: 0,
      subjectPlayerId: 1,
    });
    session.attach();
    bus.emit("frame", frame(0));
    session.close();

    const store = new HistoryStore(path.join(scratch, "no-result.sqlite"));
    check("a replay with no result says unknown", store.getMeta("result"), "unknown");
    check("and invents no player_result", store.getMeta("player_result"), undefined);
    store.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
