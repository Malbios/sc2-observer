import type { EventBus } from "../bus/EventBus";
import type { Sc2Connection } from "../protocol/connection";
import { decodeResponse, playerTypeName, raceName, resultName, type Response } from "../protocol/schema";
import { SC2_STATUS, statusName } from "../protocol/status";
import type { ReplayInfoIpc, ReplayPlayerIpc } from "../shared/ipc-types";
import { FramePublisher } from "../state/FramePublisher";

/**
 * Plays a `.SC2Replay` through the client and publishes what comes back as
 * ordinary frames (§4's replay driver).
 *
 * Three things about it are measured rather than assumed, by
 * `node dist/cli/probe-replay.js` against the pinned 4.10 client:
 *
 * - **The replay goes over the wire.** `start_replay` and `replay_info` both
 *   accept `replay_data` bytes, so nothing is copied into the container and no
 *   replay volume is mounted, exactly as `save_replay` returning bytes meant
 *   nothing had to be mounted to save one.
 * - **The end is a status transition.** Stepping past the last loop moves the
 *   client out of `in_replay`, so the driver stops on that rather than on a
 *   loop count or a timeout, which keeps it inside §4.2's rule that nothing
 *   changes state because time passed.
 * - **A replay reports its outcome.** The final observation carries
 *   `player_result`, and `replay_info` carries it before the replay is even
 *   started, so a converted replay has the same headline as a live game.
 * - **`disable_fog` does not mean what it sounds like.** From the observer
 *   slot it opens the whole map: 229 units at loop 200 of a test game, both
 *   players and every neutral. Against a *player* it does the opposite,
 *   cutting the view down to 27, where the live recording of that same game
 *   holds 212. So fog is disabled only from the observer slot, and watching
 *   as a player leaves it on, which reproduces what that player actually saw
 *   down to the unit.
 *
 * It must not run while a live session holds the client: SC2 accepts one
 * connection at a time, and §4 says so explicitly. Enforcing that is the
 * caller's job, because the caller is what owns both.
 */

/** SC2's normal-speed rate, for the pacing math. */
const LOOPS_PER_SECOND = 22.4;

/** What a bot sees, and therefore a sensible default: it decides how big the
 * recording is. A 20-minute ladder game is ~27k loops, which at 8 loops a step
 * is ~3,400 observations rather than 27,000. */
export const DEFAULT_STEP_LOOPS = 8;

/**
 * The observer slot. `observed_player_id = 0` is not a player, and with fog
 * disabled it is the only way to see the whole map (measured; see the class
 * comment). It is the default because a replay is opened to review it.
 */
export const OBSERVER_SLOT = 0;

/** `Speed` in loops of replay per second of wall clock, as a multiple of
 * normal speed. `max` means "as fast as the client answers", which is what
 * converting a replay for later viewing wants. */
export type ReplaySpeed = number | "max";

/** `ResponseReplayInfo`, in plain data. Declared with the other IPC types
 * because it crosses to the renderer intact: the "watch as" choice is made
 * from it. */
export type ReplayPlayer = ReplayPlayerIpc;
export type ReplayInfo = ReplayInfoIpc;

export interface ReplayDriverOptions {
  bus: EventBus;
  sessionId: string;
  /** Opened when the driver starts and closed when it stops, so a driver that
   * is never started never touches the client. */
  connect: () => Promise<Sc2Connection>;
  /** The replay itself. Sent as bytes; the file never leaves this process. */
  replayData: Uint8Array;
  /** Whose eyes to watch through. `OBSERVER_SLOT` (the default) sees
   * everything; a player id sees exactly what that player could see. */
  observedPlayerId?: number;
  stepLoops?: number;
  speed?: ReplaySpeed;
}

/** A refusal from the client, carrying what it said. `ResponseStartReplay`'s
 * error enum is coarse (a corrupt file comes back as `LaunchError`), so the
 * details string is the part worth showing a person. */
export class ReplayRefused extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The error on a replay response, by name and detail, or null when there is
 * none. Presence, not truthiness: these are proto2 optional enums whose first
 * value is a real error (CLAUDE.md). */
function replayError(payload: Record<string, unknown> | undefined): string | null {
  if (!payload || !Object.prototype.hasOwnProperty.call(payload, "error")) return null;
  const details = payload["error_details"];
  return details ? String(details) : `error ${String(payload["error"])}`;
}

function toPlayer(entry: Record<string, unknown>): ReplayPlayer {
  const info = (entry["player_info"] ?? {}) as Record<string, unknown>;
  const result = entry["player_result"] as Record<string, unknown> | undefined;
  const hasResult = result && Object.prototype.hasOwnProperty.call(result, "result");
  // Every one of these is an enum on the wire, which decodes as a number and
  // only looks like a name through protobufjs' `toJSON`. A replay printed
  // "race 2" before they went through the lookups.
  const race = info["race_actual"] ?? info["race_requested"];
  return {
    playerId: Number(info["player_id"] ?? 0),
    name: String(info["player_name"] ?? ""),
    race: race === undefined ? "" : raceName(Number(race)),
    type: info["type"] === undefined ? "" : playerTypeName(Number(info["type"])),
    result: hasResult ? resultName(Number(result!["result"])) : null,
    apm: entry["player_apm"] === undefined ? null : Number(entry["player_apm"]),
    mmr: entry["player_mmr"] === undefined ? null : Number(entry["player_mmr"]),
  };
}

export class ReplayDriver {
  private readonly bus: EventBus;
  private readonly sessionId: string;
  private readonly connectFn: () => Promise<Sc2Connection>;
  private readonly replayData: Uint8Array;
  private readonly frames: FramePublisher;
  private readonly stepLoops: number;

  private connection: Sc2Connection | null = null;
  private observedPlayerId: number;
  private speed: ReplaySpeed;
  private playing = true;
  private stopped = false;
  private finished = false;
  private totalLoops = 0;
  private error: string | null = null;
  /** Resolves the wait a paused run is sitting in, so resuming is immediate
   * rather than up to a poll interval later. */
  private resume: (() => void) | null = null;

  constructor(options: ReplayDriverOptions) {
    this.bus = options.bus;
    this.sessionId = options.sessionId;
    this.connectFn = options.connect;
    this.replayData = options.replayData;
    this.observedPlayerId = options.observedPlayerId ?? OBSERVER_SLOT;
    this.stepLoops = options.stepLoops ?? DEFAULT_STEP_LOOPS;
    this.speed = options.speed ?? "max";
    this.frames = new FramePublisher(this.sessionId, this.bus);
  }

  get loop(): number {
    return this.frames.loop;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  get isPlaying(): boolean {
    return this.playing && !this.finished && !this.stopped;
  }

  /**
   * Reads the replay's metadata without loading it. Valid in any client
   * state, so this is also what a picker can call before deciding to play
   * anything.
   */
  async readInfo(): Promise<ReplayInfo> {
    const response = await this.send({ replay_info: { replay_data: this.replayData } });
    const info = response.replay_info as Record<string, unknown> | undefined;
    const problem = replayError(info);
    if (!info || problem) {
      throw new ReplayRefused(`the client would not read that replay: ${problem ?? "no reply"}`);
    }
    const players = ((info["player_info"] as Record<string, unknown>[]) ?? []).map(toPlayer);
    this.totalLoops = Number(info["game_duration_loops"] ?? 0);
    return {
      mapName: String(info["map_name"] ?? ""),
      localMapPath: String(info["local_map_path"] ?? ""),
      durationLoops: this.totalLoops,
      durationSeconds: Number(info["game_duration_seconds"] ?? 0),
      gameVersion: String(info["game_version"] ?? ""),
      dataVersion: String(info["data_version"] ?? ""),
      baseBuild: Number(info["base_build"] ?? 0),
      players,
    };
  }

  /** Which player the replay is watched as, which decides how much of the map
   * the recording will contain. Must be set before `start()`; the client is
   * told once, when the replay is loaded. */
  observeAs(playerId: number): void {
    this.observedPlayerId = playerId;
  }

  /**
   * Loads the replay and publishes the two frames that describe the game
   * before any observation: the map, and the unit type names.
   *
   * `start_replay` is only valid from `launched`, and a container left behind
   * by a killed session can be sitting in a game, so this applies the recovery
   * CLAUDE.md already records for `create_game`: `leave_game` on a fresh
   * connection, after which the client accepts the replay.
   */
  async start(): Promise<void> {
    // Progress is a fraction, and the denominator comes from `replay_info`.
    // Reading it here as well as on demand means a driver started directly
    // still knows how long the replay is, whoever called what first.
    if (this.totalLoops === 0) await this.readInfo();

    const pinged = await this.send({ ping: {} });
    if (pinged.status === SC2_STATUS.inGame || pinged.status === SC2_STATUS.inReplay) {
      await this.send({ leave_game: {} });
    }

    const started = await this.send({
      start_replay: {
        replay_data: this.replayData,
        observed_player_id: this.observedPlayerId,
        options: { raw: true, score: true },
        // Fog off only from the observer slot. Measured: from the observer
        // slot it opens the whole map (229 units at loop 200 of a test game),
        // but against a *player* it restricts the view to a fraction of what
        // that player actually saw (27, where the live recording of the same
        // game holds 212). So watching as a player keeps fog on, which
        // reproduces that player's vision exactly.
        disable_fog: this.observedPlayerId === OBSERVER_SLOT,
        realtime: false,
      },
    });
    const problem = replayError(started.start_replay as Record<string, unknown> | undefined);
    if (problem) throw new ReplayRefused(`the client would not play that replay: ${problem}`);
    if (started.status !== SC2_STATUS.inReplay) {
      throw new ReplayRefused(`the client did not enter a replay (status ${statusName(started.status)})`);
    }

    await this.publish({ game_info: {} });
    await this.publish({ data: { unit_type_id: true, ability_id: true } });
    // And loop zero before any stepping. A live game gets one because the bot
    // asks the moment it joins; without it here the recording would start at
    // loop 8, which is the loop the viewer reads to clear the units standing
    // on the terrain grids at the start.
    await this.publish({ observation: {} });
    this.announce();
  }

  /**
   * Steps to the end, publishing an observation per step, and returns when
   * the replay is over or has been stopped.
   *
   * Pausing is allowed here, unlike anywhere near a bot: §4 notes that a
   * replay has no lockstep peer to starve, so a paused replay is simply a
   * client that is not being asked for anything.
   */
  async run(): Promise<void> {
    while (!this.stopped && !this.finished) {
      if (!this.playing) {
        await this.paused();
        continue;
      }

      const startedAt = Date.now();
      const stepped = await this.send({ step: { count: this.stepLoops } });
      if (this.leftReplay(stepped)) break;

      const observed = await this.publish({ observation: {} });
      if (this.leftReplay(observed)) break;

      this.announce();
      await this.pace(Date.now() - startedAt);
    }

    if (!this.finished) this.announce();
  }

  /** Whether the client has left the replay, which is the only thing that
   * ends one. The last observation before it is published like any other, so
   * the recording keeps the final loop and its `player_result`. */
  private leftReplay(response: Response): boolean {
    if (response.status === SC2_STATUS.inReplay) return false;
    this.finish(null);
    return true;
  }

  play(): void {
    if (this.finished || this.stopped) return;
    this.playing = true;
    this.wake();
    this.announce();
  }

  pause(): void {
    if (this.finished || this.stopped) return;
    this.playing = false;
    this.announce();
  }

  setSpeed(speed: ReplaySpeed): void {
    this.speed = speed;
  }

  /** Lets go of the client without having played anything, which is what an
   * inspection does while the user is still deciding. */
  close(): void {
    this.connection?.close();
    this.connection = null;
  }

  /** Stops early, which leaves a perfectly good partial recording: the game
   * file holds every loop that was stepped. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.finish(null);
  }

  private finish(error: string | null): void {
    if (this.finished) return;
    this.finished = true;
    this.playing = false;
    this.wake();
    this.error = error;
    this.connection?.close();
    this.connection = null;
    this.announce();
    // The same signal a live game ends with, so everything downstream (the
    // store closing, the tailer stopping) behaves the way it always does.
    this.bus.emit("gameEnded", { sessionId: this.sessionId, loop: this.frames.loop, reason: "status" });
  }

  /** The wait a paused run sits in. Nothing polls: `play()` and `stop()`
   * release it, so a paused replay costs nothing and resumes at once. */
  private paused(): Promise<void> {
    if (this.playing || this.stopped || this.finished) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.resume = resolve;
    });
  }

  private wake(): void {
    const resume = this.resume;
    this.resume = null;
    resume?.();
  }

  /** Keeps the requested speed by waiting out whatever the client did not
   * take. `max` waits for nothing, which is the conversion case. */
  private async pace(elapsedMs: number): Promise<void> {
    if (this.speed === "max") return;
    const target = (this.stepLoops / LOOPS_PER_SECOND / this.speed) * 1000;
    const remaining = target - elapsedMs;
    if (remaining > 0) await sleep(remaining);
  }

  private announce(): void {
    this.bus.emit("replayProgress", {
      sessionId: this.sessionId,
      loop: this.frames.loop,
      totalLoops: this.totalLoops,
      playing: this.isPlaying,
      finished: this.finished,
      error: this.error,
    });
  }

  /** A request whose response is also a frame: decoded once, published, and
   * returned for the status check. */
  private async publish(fields: Record<string, unknown>): Promise<Response> {
    const bytes = await this.raw(fields);
    const decoded = decodeResponse(bytes);
    this.frames.publish(bytes, decoded);
    return decoded;
  }

  private async send(fields: Record<string, unknown>): Promise<Response> {
    return decodeResponse(await this.raw(fields));
  }

  private async raw(fields: Record<string, unknown>): Promise<Uint8Array> {
    if (!this.connection) this.connection = await this.connectFn();
    return this.connection.request(fields);
  }
}
