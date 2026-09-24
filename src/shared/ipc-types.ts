import type {
  ChannelIpc,
  EventFilterIpc,
  EventIpc,
  SeriesDataIpc,
  TelemetryStateIpc,
  TelemetryStreamIpc,
} from "./telemetry-types";

export interface RecordingInfo {
  filePath: string;
  map: string;
  mode: string;
  startedAt: string | undefined;
  endedAt: string | undefined;
  maxLoop: number;
}

/**
 * What the catalog can say about a game file. A file that will not open is a
 * row with a reason, not an omission: §6.4 exists precisely so the games that
 * went wrong can be found.
 *
 * - `ok`: a finished game.
 * - `incomplete`: no `ended_at`, so the app that wrote it never closed it.
 *   Either it is being played right now or it was killed mid-game.
 * - `newer`: written by a newer build; readable enough to list, not to open.
 * - `unreadable`: not a game file, or damaged beyond opening.
 */
export type GameFileState = "ok" | "incomplete" | "newer" | "unreadable";

/** One row of the catalog (§6.4). Everything here is derived from the game
 * file itself, so the list is never stale with respect to the folder. */
export interface GameSummaryIpc {
  filePath: string;
  fileName: string;
  state: GameFileState;
  /** Why the file is `newer` or `unreadable`, in words to put on the row. */
  problem: string | null;
  /** The game file plus its WAL sidecar, which is where a game being played
   * right now keeps most of itself. */
  sizeBytes: number;
  map: string | null;
  mode: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Where the game came from: "live" for one this app played, "replay" for
   * one converted from a `.SC2Replay` (§6.4). A row has to say which, because
   * everything else about them looks the same. */
  source: string | null;
  /** The bot's own outcome, or "unknown" for the endings that produce none. */
  result: string | null;
  endReason: string | null;
  /** The last loop the file holds, counting telemetry as well as frames:
   * loops are the time axis (§3), and a game can hold telemetry past its last
   * recorded frame. */
  maxLoop: number | null;
  /** From each stream's `hello` (§6.3). Empty when no telemetry was attached. */
  botNames: string[];
  tags: string[];
  hasReplay: boolean;
  gameId: string | null;
}

/** The games folder as the catalog sees it right now. Which row is live and
 * which is open are main's to know, not the renderer's to work out. */
export interface GameCatalogIpc {
  dir: string;
  games: GameSummaryIpc[];
  /** The game being played right now, so its row can say so instead of
   * looking like an abandoned one. */
  liveFilePath: string | null;
  /** The recording the viewer currently has open. */
  openFilePath: string | null;
}

/**
 * What became of an action on a game file.
 *
 * `refused` and `failed` are different things to a person: refused means the
 * app would not do it and can say why ("that game is being played right now"),
 * failed means it tried and the filesystem said no. Both carry a `problem`;
 * `cancelled` is a dialog dismissed and needs no message at all.
 */
export type GameActionStatus = "done" | "cancelled" | "refused" | "failed";

export interface GameActionResultIpc {
  status: GameActionStatus;
  problem: string | null;
  /** The folder as it is now, so the caller never shows a row it just
   * deleted. */
  catalog: GameCatalogIpc;
}

/** Opening a game can be refused (a file written by a newer build) or fail (a
 * file that has been deleted since it was listed), and either way the row that
 * was clicked is the place to say so. */
export interface OpenGameResultIpc {
  status: GameActionStatus;
  problem: string | null;
  recording: RecordingInfo | null;
}

/** Detaching a stream changes the open recording rather than the folder, so
 * it reports what changed there (§3.5). */
export interface DetachStreamResultIpc {
  status: GameActionStatus;
  problem: string | null;
  streams: TelemetryStreamIpc[];
  /** The game's range after the detach: dropping a stream can shorten it. */
  maxLoop: number;
}

/** One player in a replay, from `ResponseReplayInfo`. Every field here is an
 * enum on the wire and a name by the time it crosses IPC. */
export interface ReplayPlayerIpc {
  playerId: number;
  name: string;
  race: string;
  type: string;
  /** "Victory"/"Defeat"/"Tie", or null when the replay does not say. */
  result: string | null;
  apm: number | null;
  mmr: number | null;
}

/** What a replay says about itself before it is played. */
export interface ReplayInfoIpc {
  mapName: string;
  localMapPath: string;
  durationLoops: number;
  durationSeconds: number;
  gameVersion: string;
  dataVersion: string;
  baseBuild: number;
  players: ReplayPlayerIpc[];
}

/** Reading a replay before playing it, which is what lets the user pick whose
 * eyes to watch through and what tells them early that a replay is from a
 * build this client cannot open. */
export interface InspectReplayResultIpc {
  status: GameActionStatus;
  problem: string | null;
  filePath: string;
  fileName: string;
  info: ReplayInfoIpc | null;
}

/**
 * A `.SC2Replay` being played through the client and recorded (§7's replay
 * driver).
 *
 * Unlike a session this has a known end: `replay_info` gives the game's length
 * in loops before the first step, so the UI shows a real fraction. When it
 * finishes, `gameFile` is an ordinary game and the viewer opens it; SC2 cannot
 * seek a replay backwards, so the recording is what gets scrubbed.
 */
export interface ReplayProgressIpc {
  sourcePath: string;
  sourceName: string;
  map: string;
  /** What it is doing before any loop has been stepped: starting the
   * container, reading the replay, loading it. A replay takes a few seconds
   * to get going and a window with nothing on it reads as a window that has
   * not noticed the file. */
  note: string | null;
  loop: number;
  totalLoops: number;
  playing: boolean;
  finished: boolean;
  /** Set when the replay stopped because something went wrong. */
  error: string | null;
  /** The game file being written, once the first frame has landed. */
  gameFile: string | null;
}

export interface OpenReplayResultIpc {
  status: GameActionStatus;
  problem: string | null;
  progress: ReplayProgressIpc | null;
}

/**
 * The session state machine (§4), plus the three states that are not part of
 * the game cycle: before it starts, after the user stops it, and when
 * something it depends on is not there.
 */
export type SessionPhase =
  | "idle"
  | "containerDown"
  | "clientReady"
  | "gameCreated"
  | "inGame"
  | "ended"
  | "stopped"
  | "failed";

/** Everything the header needs to describe a running session. Pushed whenever
 * any of it changes, and fetchable on demand so a reloaded window is not left
 * waiting for the next change. */
export interface SessionStatusIpc {
  phase: SessionPhase;
  mode: string;
  map: string;
  /** The game file currently being written, null between games. */
  gameFile: string | null;
  /** Games finished and closed in this session. */
  gamesPlayed: number;
  loop: number;
  botConnected: boolean;
  /** The last `Response.status`, by name, or "none" before the first one. */
  clientStatus: string;
  /** Set only when the phase is "failed". */
  error: string | null;
  /** A game between two bots ("BvB") only, else null: one entry per seat. */
  seats: SeatStatusIpc[] | null;
  /** BvB: the seat whose view the current game shows and records. */
  watchSeat: number | null;
  /** BvB: the seat the next game will show, when it differs. */
  nextWatchSeat: number | null;
}

/** One bot's place in a game between two bots, with what the user needs to
 * start that bot ladder-style. */
export interface SeatStatusIpc {
  seat: number;
  /** `--LadderServer`, `--GamePort` and `--StartPort` for this bot. */
  ladderServer: string;
  gamePort: number;
  startPort: number;
  botConnected: boolean;
  playerId: number | null;
  /** The name the bot joined under, if it gave one. */
  name: string | null;
}

/** What the UI has to pick before a session can start. Mode is the user's
 * choice and is never detected from traffic (§1). */
export interface StartSessionOptionsIpc {
  map: string;
  mode: string;
  opponentRace?: number;
  opponentDifficulty?: number;
  /** BvB: whose view to show and record, 1 by default. */
  watchSeat?: number;
  /** BvB: each seat's telemetry folder, by seat number. */
  telemetryDirs?: Record<number, string>;
}

/** What the Docker panel shows when nothing is running yet, so the user can
 * see why a session would fail before starting one. */
export interface DockerStateIpc {
  available: boolean;
  version: string | null;
  /** Why Docker is unusable, in words a user can act on. */
  reason: string | null;
  image: string;
  imageExists: boolean;
  container: "running" | "exited" | "missing";
}

/** A line for the diagnostics panel. */
export interface DockerLogIpc {
  source: string;
  line: string;
}

/**
 * The two things that are true for a whole game and are needed before the
 * first frame can be drawn. They are pushed rather than queried because §6.4
 * keeps the live viewer off the store, and because the store has not flushed
 * yet when the first frames arrive.
 */
export interface LiveTerrainIpc {
  terrain: TerrainDataIpc | null;
  unitTypes: Record<number, UnitTypeInfoIpc>;
}

export interface TerrainDataIpc {
  width: number;
  height: number;
  pathingGrid: number[];
  placementGrid: number[];
  terrainHeight: number[];
  playableArea: { x0: number; y0: number; x1: number; y1: number };
  startLocations: { x: number; y: number }[];
}

export interface UnitSummaryIpc {
  tag: number;
  unitType: number;
  owner: number;
  radius: number;
  buildProgress: number;
  pos: { x: number; y: number; z: number } | null;
  isHallucination: boolean;
}

export interface FrameAtLoopIpc {
  loop: number;
  units: UnitSummaryIpc[];
}

export type UnitCategoryIpc = "unit" | "building" | "mineral" | "gas";

export interface UnitTypeInfoIpc {
  name: string;
  category: UnitCategoryIpc;
}

/** What `attachTelemetry` reports back about the file it just ingested, so the
 * UI can say "540 lines, 3 rejected" rather than silently dropping them. */
export interface AttachTelemetryResultIpc {
  /** `refused` means nothing was imported, and `problem` says why: a game
   * holds one telemetry file, so the current one has to be removed first. */
  status: "ingested" | "refused";
  problem: string | null;
  streams: TelemetryStreamIpc[];
  ingested: {
    name: string;
    messageCount: number;
    rejectedCount: number;
    firstLoop: number | null;
    lastLoop: number | null;
    rejections: { line: number; reason: string }[];
  } | null;
}

/** What the header shows about a watched folder: the file the tailer has
 * adopted, if any, and how much it has taken from it. */
export interface TelemetryWatchIpc {
  dir: string;
  files: {
    path: string;
    name: string;
    messageCount: number;
    rejectedCount: number;
    lastLoop: number | null;
  }[];
  /** Files in the folder the tailer is deliberately not reading: earlier runs
   * that were there before watching began, files found while the game already
   * had telemetry, or a file truncated underneath it. */
  skippedCount: number;
}

export interface SpectatorApi {
  pickAndOpenRecording(): Promise<OpenGameResultIpc>;

  /** The history browser (§6.4). The folder is peeked on every call, so a game
   * deleted in Explorer is gone from the next listing. */
  listGames(): Promise<GameCatalogIpc>;
  /** The same open as the picker's, by path instead of by dialog. */
  openGame(filePath: string): Promise<OpenGameResultIpc>;
  /** Sends a game and its replay to the recycle bin. Refused for the game
   * being played; the open recording is closed first, because Windows will
   * not unlink a file SQLite still has open. */
  deleteGame(filePath: string): Promise<GameActionResultIpc>;
  /** Copies the game and its replay somewhere the user picks. */
  exportGame(filePath: string): Promise<GameActionResultIpc>;
  /** Tags live in the game file's own `meta`, so they survive it being copied
   * to another machine. */
  setGameTags(filePath: string, tags: string[]): Promise<GameActionResultIpc>;
  /** §3.5's recovery: takes a telemetry stream out of the open recording,
   * rows, checkpoints and all. */
  detachStream(streamId: number): Promise<DetachStreamResultIpc>;

  /** Plays a `.SC2Replay` through the client, recording it as a game. Refused
   * while a live session holds the client: SC2 accepts one at a time. */
  /** Reads a replay without playing it, for the "watch as" choice. */
  inspectReplay(filePath: string): Promise<InspectReplayResultIpc>;
  pickReplay(): Promise<InspectReplayResultIpc>;
  openReplay(filePath: string, observedPlayerId: number, subjectPlayerId: number): Promise<OpenReplayResultIpc>;
  controlReplay(action: "play" | "pause" | "stop", speed?: number | "max"): Promise<ReplayProgressIpc | null>;
  getReplayProgress(): Promise<ReplayProgressIpc | null>;
  onReplayProgress(listener: (progress: ReplayProgressIpc) => void): () => void;
  /**
   * The path of a dropped file. Electron stopped exposing `File.path` in v32,
   * so this is `webUtils.getPathForFile`, which only the preload can call.
   */
  pathForFile(file: File): string;

  getTerrain(): Promise<TerrainDataIpc | null>;
  getUnitTypeInfo(): Promise<Record<number, UnitTypeInfoIpc>>;
  getFrameAtLoop(loop: number): Promise<FrameAtLoopIpc | null>;

  /** Opens a picker, ingests the chosen .ndjson into the open recording.
   * `seat` says whose file it is in a game between two bots. */
  attachTelemetry(seat?: number | null): Promise<AttachTelemetryResultIpc | null>;
  /** The same import by path, for a file dropped on the window. */
  attachTelemetryFile(filePath: string, seat?: number | null): Promise<AttachTelemetryResultIpc | null>;
  getTelemetryStreams(): Promise<TelemetryStreamIpc[]>;
  getChannels(): Promise<ChannelIpc[]>;
  getTelemetryAtLoop(loop: number): Promise<TelemetryStateIpc>;
  getSeries(ch: string, name: string): Promise<SeriesDataIpc>;
  getEvents(filter?: EventFilterIpc): Promise<EventIpc[]>;

  /** Opens a folder picker and tails every .ndjson in it into the open
   * recording. Null if the picker was cancelled. */
  watchTelemetryFolder(): Promise<TelemetryWatchIpc | null>;
  stopWatchingTelemetry(): Promise<null>;
  getTelemetryWatch(): Promise<TelemetryWatchIpc | null>;
  /**
   * The telemetry push. It carries no payload on purpose: the renderer re-asks
   * for the loop it is already showing, so live and history go down one path.
   * Returns an unsubscribe.
   */
  onTelemetryAppended(listener: () => void): () => void;

  /** Map names the container can see, for the session's map picker. */
  listMaps(): Promise<string[]>;
  getDockerState(): Promise<DockerStateIpc>;
  startSession(options: StartSessionOptionsIpc): Promise<SessionStatusIpc>;
  stopSession(): Promise<SessionStatusIpc | null>;
  /** Null when no session has been started in this run of the app. */
  getSessionState(): Promise<SessionStatusIpc | null>;
  /** A game between two bots: show and record this seat's view. */
  setWatchedSeat(seat: number): Promise<SessionStatusIpc | null>;
  /** Which of a running session and an opened recording the viewer is
   * showing, so main answers queries from that one. */
  setActiveSource(kind: "recording" | "live"): Promise<null>;

  /**
   * The live pushes. Unlike telemetry these carry their payload: §6.4 keeps
   * the live viewer off the store, so the bus is the only place the current
   * frame exists. Each returns an unsubscribe.
   */
  onSessionState(listener: (state: SessionStatusIpc) => void): () => void;
  onLiveFrame(listener: (frame: FrameAtLoopIpc) => void): () => void;
  onLiveTerrain(listener: (payload: LiveTerrainIpc) => void): () => void;
  onDockerLog(listener: (line: DockerLogIpc) => void): () => void;
}

declare global {
  interface Window {
    spectator: SpectatorApi;
  }
}
