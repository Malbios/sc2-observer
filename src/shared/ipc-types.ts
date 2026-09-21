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
}

/** What the UI has to pick before a session can start. Mode is the user's
 * choice and is never detected from traffic (§1). */
export interface StartSessionOptionsIpc {
  map: string;
  mode: string;
  opponentRace?: number;
  opponentDifficulty?: number;
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
  /** `already-attached` means nothing was imported: this file is in this
   * recording, and importing it again would duplicate every row. */
  status: "ingested" | "already-attached";
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

/** What the header shows about a watched folder: which files the tailer has
 * picked up and how much it has taken from each. */
export interface TelemetryWatchIpc {
  dir: string;
  files: {
    path: string;
    name: string;
    messageCount: number;
    rejectedCount: number;
    lastLoop: number | null;
  }[];
  /** Files in the folder the tailer is deliberately not reading, because they
   * are already streams in this recording or were truncated underneath it. */
  skippedCount: number;
}

export interface SpectatorApi {
  pickAndOpenRecording(): Promise<RecordingInfo | null>;
  getTerrain(): Promise<TerrainDataIpc | null>;
  getUnitTypeInfo(): Promise<Record<number, UnitTypeInfoIpc>>;
  getFrameAtLoop(loop: number): Promise<FrameAtLoopIpc | null>;

  /** Opens a picker, ingests the chosen .ndjson into the open recording. */
  attachTelemetry(): Promise<AttachTelemetryResultIpc | null>;
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
