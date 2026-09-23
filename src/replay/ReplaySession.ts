import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { EventBus, FrameEvent } from "../bus/EventBus";
import { gameFileName, uniqueGamePath } from "../history/gameFiles";
import { HistoryStore } from "../history/HistoryStore";
import type { ReplayInfo } from "./ReplayDriver";

/**
 * Records a replay being played into an ordinary game file (§6.2: "replay
 * viewing of a `.SC2Replay` is also recorded as a game ... flagged
 * `source = replay`").
 *
 * This is what makes the rest of Phase 6 small. SC2 cannot seek a replay
 * backwards, so a viewer built directly on the client would be a worse viewer
 * than the one this app already has. Playing the replay once and writing every
 * observation into a game file turns the second viewing, and every one after
 * it, into the history browser that already scrubs, charts and takes
 * telemetry, with no container involved at all.
 */
export interface ReplaySessionOptions {
  bus: EventBus;
  /** Where the game file goes; ignored when `outPath` is given. */
  gamesDir: string;
  outPath?: string;
  /** The `.SC2Replay` this came from, kept in `meta` so a converted game can
   * be traced back to the file someone was sent. */
  sourcePath: string;
  info: ReplayInfo;
  /** Whose eyes the replay was watched through, for the record. */
  observedPlayerId: number;
  /**
   * Whose outcome the game file calls its own. Separate from the observed
   * player because the two answer different questions: a ladder replay is
   * watched from the observer slot, to see everything, while the row in the
   * catalog still has to say whether *your bot* won.
   */
  subjectPlayerId: number;
  appVersion?: string;
  now?: () => Date;
}

export class ReplaySession {
  private readonly bus: EventBus;
  private readonly gamesDir: string;
  private readonly explicitPath: string | undefined;
  private readonly sourcePath: string;
  private readonly info: ReplayInfo;
  private readonly observedPlayerId: number;
  private readonly subjectPlayerId: number;
  private readonly appVersion: string | undefined;
  private readonly now: () => Date;

  private store: HistoryStore | null = null;
  private filePath: string | null = null;
  private onFrame: ((event: FrameEvent) => void) | null = null;

  constructor(options: ReplaySessionOptions) {
    this.bus = options.bus;
    this.gamesDir = options.gamesDir;
    this.explicitPath = options.outPath;
    this.sourcePath = options.sourcePath;
    this.info = options.info;
    this.observedPlayerId = options.observedPlayerId;
    this.subjectPlayerId = options.subjectPlayerId;
    this.appVersion = options.appVersion;
    this.now = options.now ?? (() => new Date());
  }

  /** The file being written, or null until the first frame arrives. */
  get gameFile(): string | null {
    return this.filePath;
  }

  get activeStore(): HistoryStore | null {
    return this.store;
  }

  /** One handler for the whole conversion, for the reason the session
   * controller gives: swapping subscriptions is how frames get lost. */
  attach(): void {
    if (this.onFrame) return;
    this.onFrame = (event: FrameEvent): void => {
      this.ensureStore().recordFrame(event);
    };
    this.bus.on("frame", this.onFrame);
  }

  detach(): void {
    if (!this.onFrame) return;
    this.bus.off("frame", this.onFrame);
    this.onFrame = null;
  }

  /** Closes the recording. Safe to call twice, because a replay can end by
   * reaching its last loop and by being stopped, and both end here. */
  close(): void {
    this.detach();
    const store = this.store;
    if (!store) return;
    store.setMeta("ended_at", this.now().toISOString());
    store.flush();
    store.close();
    this.store = null;
  }

  /**
   * Created by the first frame rather than up front, so a replay the client
   * refuses leaves no empty file behind.
   */
  private ensureStore(): HistoryStore {
    if (this.store) return this.store;

    const path = this.explicitPath ?? this.nextGamePath();
    const store = new HistoryStore(path);
    this.writeMeta(store);
    this.store = store;
    this.filePath = path;
    return store;
  }

  /**
   * A replay is named and dated by the match it holds, not by the minute it
   * was converted: the catalog's "when" column has to mean the same thing for
   * every row, and for a game this app did not play, the closest honest answer
   * is when the file was written. `imported_at` keeps the other one.
   */
  private nextGamePath(): string {
    return uniqueGamePath(join(this.gamesDir, gameFileName(this.mapName, this.playedAt())), existsSync);
  }

  private playedAt(): Date {
    try {
      return statSync(this.sourcePath).mtime;
    } catch {
      return this.now();
    }
  }

  /** The map as the rest of the app spells it: the `.SC2Map` name, the same
   * form a live game records, with the display name kept beside it. */
  private get mapName(): string {
    return this.info.localMapPath || this.info.mapName || "replay";
  }

  private writeMeta(store: HistoryStore): void {
    store.setMeta("map", this.mapName);
    store.setMeta("map_name", this.info.mapName);
    store.setMeta("source", "replay");
    store.setMeta("replay_path", this.sourcePath);
    store.setMeta("game_id", randomUUID());
    store.setMeta("started_at", this.playedAt().toISOString());
    store.setMeta("imported_at", this.now().toISOString());
    store.setMeta("end_reason", "replay");
    if (this.appVersion) store.setMeta("app_version", this.appVersion);

    // §6.3 keeps players and races as data, never as something to branch on.
    store.setMeta("players", JSON.stringify(this.info.players));
    store.setMeta("bot_player_id", String(this.subjectPlayerId));
    store.setMeta("observed_player_id", String(this.observedPlayerId));

    // Traceability for the failure this build will actually meet: a replay
    // from another SC2 version refuses to load, and the version it wants is
    // the only useful thing to say about it.
    store.setMeta("game_version", this.info.gameVersion);
    store.setMeta("base_build", String(this.info.baseBuild));
    store.setMeta("data_version", this.info.dataVersion);

    // The replay knows its own outcome before a single loop is stepped, so
    // the catalog's headline is written at the start rather than at the end.
    const results = this.info.players
      .filter((player) => player.result !== null)
      .map((player) => ({ player_id: player.playerId, result: player.result! }));
    if (results.length > 0) {
      store.setMeta("player_result", JSON.stringify(results));
      const ours = results.find((entry) => entry.player_id === this.subjectPlayerId);
      store.setMeta("result", ours ? ours.result : "unknown");
    } else {
      store.setMeta("result", "unknown");
    }
  }
}
