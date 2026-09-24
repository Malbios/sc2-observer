import { createReadStream, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import { EventBus, type FrameEvent } from "../bus/EventBus";
import { CONTAINER_PORT, DockerManager, IMAGE_NAME } from "../docker/DockerManager";
import { CatalogStore } from "../history/CatalogStore";
import { gameFilesFor, replayPathFor } from "../history/gameFiles";
import { exportGameTo, normalizeTags, writeGameTags } from "../history/manage";
import { listGames } from "../history/peek";
import { HistoryStore } from "../history/HistoryStore";
import { SessionController } from "../session/SessionController";
import type { GameMode } from "../proxy/GameProxy";
import { decodeResponse, type Response } from "../protocol/schema";
import { clearInitialUnitFootprints, extractTerrain, type TerrainData } from "../state/terrain";
import { extractUnits } from "../state/frames";
import { GameOverlays } from "../state/GameOverlays";
import { extractUnitTypeInfo } from "../state/unitTypes";
import { OBSERVER_SLOT, ReplayDriver, ReplayRefused, type ReplayInfo } from "../replay/ReplayDriver";
import { ReplaySession } from "../replay/ReplaySession";
import { connectSc2 } from "../protocol/connection";
import { telemetryRefusal } from "../telemetry/attachRule";
import { detachStream } from "../telemetry/detach";
import { StreamIngest } from "../telemetry/ingest";
import { TelemetryResolver } from "../telemetry/TelemetryResolver";
import { TelemetryTailer } from "../telemetry/TelemetryTailer";
import type {
  AttachTelemetryResultIpc,
  DetachStreamResultIpc,
  DockerStateIpc,
  FrameAtLoopIpc,
  GameActionResultIpc,
  GameCatalogIpc,
  InspectReplayResultIpc,
  OpenGameResultIpc,
  OpenReplayResultIpc,
  ReplayProgressIpc,
  RecordingInfo,
  SessionPhase,
  SessionStatusIpc,
  StartSessionOptionsIpc,
  TelemetryWatchIpc,
  TerrainDataIpc,
  UnitTypeInfoIpc,
} from "../shared/ipc-types";
import type {
  ChannelDeclaration,
  ChannelIpc,
  EventFilterIpc,
  EventIpc,
  SeriesDataIpc,
  TelemetryStateIpc,
  TelemetryStreamIpc,
} from "../shared/telemetry-types";

/**
 * §4's single in-process bus. The tailer, the proxy, the Docker manager and
 * the session controller all speak on it, which is what lets the live view,
 * the history view and persistence consume one stream.
 */
const bus = new EventBus();

let store: HistoryStore | null = null;
/** One per watched folder: one, or one per player in a game between two
 * bots. All of them write into the same game. */
let tailers: TelemetryTailer[] = [];
/** The store the tailers write into, which is not always the one on screen: a
 * session's tailer follows its game while the user looks at a recording. */
let tailerStore: HistoryStore | null = null;
let terrainCache: TerrainData | null = null;
let unitTypeInfoCache: Record<number, UnitTypeInfoIpc> | null = null;
let channelsCache: ChannelIpc[] | null = null;
let telemetryResolver: TelemetryResolver | null = null;
/** The open recording's derived overlays (command intent, debug draws), built
 * from its stored frames the first time they are asked for. */
let gameOverlaysCache: GameOverlays | null = null;
/** The last observation decoded for a loop. The frame and the telemetry for a
 * loop are asked for in the same round, and both need it. */
let observationMemo: { loop: number; response: Response | null } | null = null;
/** The file `store` was opened from, which is what the catalog marks as the
 * row on screen. */
let openFilePath: string | null = null;
/** Starts at the repo's fixtures/ folder, then follows the last file opened.
 * Restored from the catalog on first use, so it survives a restart. */
let lastOpenedDir: string | null = null;

// -- the live session ------------------------------------------------------

let session: SessionController | null = null;
let inspector: DockerManager | null = null;
/**
 * Which store the queries answer from. A session and an opened recording can
 * both exist at once, and they are different games; the viewer shows one of
 * them, so main answers from that one rather than guessing.
 */
let activeSource: "recording" | "live" = "recording";
/** What `db()` last returned, so changing games drops the caches built from
 * the previous one. */
let cachedStore: HistoryStore | null = null;

/** Pushed at most this often. The live view follows the head, and a renderer
 * cannot draw faster than its frames; every observation is still recorded in
 * full, this only limits what crosses the IPC boundary. */
const LIVE_FRAME_INTERVAL_MS = 50;

let liveTerrain: TerrainData | null = null;
let liveUnitTypes: Record<number, UnitTypeInfoIpc> = {};
let liveFootprintsPending = false;
let firstObservation: Uint8Array | null = null;
let latestObservation: Uint8Array | null = null;
/** The live game's derived overlays, fed off the bus. Not read back from the
 * store: it flushes once a second, and lines drawn from there would start at
 * where the units were a second ago. */
let liveOverlays = new GameOverlays();
/** The observation behind the last pushed frame, so overlays are drawn
 * against the same unit positions the map is showing. */
let liveObservation: Response | null = null;
/** The last frame actually pushed, kept so a renderer coming back to the live
 * view sees the game immediately instead of an empty map until the next one. */
let lastLiveFrame: FrameAtLoopIpc | null = null;
let liveFrameTimer: NodeJS.Timeout | null = null;
/** The game file the renderer was last told about, so a new game is noticed
 * exactly once. */
let liveGameFile: string | null = null;
let lastPhase: SessionPhase | null = null;
/**
 * The telemetry files that were already in the folder when the session
 * started waiting for this game's bot, and therefore belong to some earlier
 * run. Taken before the bot is even started, which is what makes it safe: a
 * file that shows up after this list was made is this game's, and no clock is
 * involved in deciding that.
 */
let preExistingTelemetry = new Map<string, string[]>();
/** A folder the user picked by hand, which then outranks the default for the
 * rest of the run. Null until they pick one. */
let telemetryDir: string | null = null;
/** A game between two bots: each player's telemetry folder, from the session's
 * start options. Each seat is tailed on its own, so two bots writing at once
 * each land under their own player. */
let seatTelemetryDirs: Record<number, string> | null = null;

// -- the replay driver ------------------------------------------------------

/**
 * The replay being converted, if any. A replay and a live session both want
 * the client, and SC2 accepts one connection at a time, so only one of these
 * two exists at once and each refuses to start while the other holds it.
 */
let replayDriver: ReplayDriver | null = null;
let replaySession: ReplaySession | null = null;
let replayProgress: ReplayProgressIpc | null = null;

function dockerDir(): string {
  return path.join(app.getAppPath(), "docker");
}

function mapsDir(): string {
  return path.join(app.getAppPath(), "maps");
}

/** One SQLite file per game, in the user's own data folder rather than the
 * repo: a packaged app has no writable folder of its own. */
function gamesDir(): string {
  return path.join(app.getPath("userData"), "games");
}

/** The global catalog (§6.2), which holds settings and nothing else. Opened
 * on first use so a run that never touches the history browser never creates
 * it. */
let catalog: CatalogStore | null = null;

function settings(): CatalogStore {
  if (!catalog) catalog = new CatalogStore(path.join(app.getPath("userData"), "catalog.sqlite"));
  return catalog;
}

/** Where the file pickers open. The last folder used outlives the run, which
 * is the difference between a tool that remembers where your games are and
 * one that starts in the repo's fixtures every launch. */
function pickerDir(): string {
  if (lastOpenedDir === null) {
    lastOpenedDir = settings().getSetting("lastOpenedDir") ?? path.join(app.getAppPath(), "fixtures");
  }
  return lastOpenedDir;
}

function rememberPickerDir(dir: string): void {
  lastOpenedDir = dir;
  settings().setSetting("lastOpenedDir", dir);
}

/** A manager for looking, not touching. The session owns its own; this one
 * answers the panel's questions before a session exists. */
function docker(): DockerManager {
  if (!inspector) inspector = new DockerManager({ bus, dockerfileDir: dockerDir(), mapsDir: mapsDir() });
  return inspector;
}

/**
 * The game being written right now, whichever produces it. A live session and
 * a replay being converted are the same thing to everything downstream: one
 * store, filling up, that the viewer follows.
 */
function liveStore(): HistoryStore | null {
  return session?.activeStore ?? replaySession?.activeStore ?? null;
}

/** The store the queries read from. */
function db(): HistoryStore | null {
  const next = activeSource === "live" ? liveStore() : store;
  if (next !== cachedStore) {
    cachedStore = next;
    resetCaches();
  }
  return next;
}

/** Windows paths are case-insensitive, so two spellings of the same file are
 * the same file. Used wherever a path decides something, such as whether a
 * game is the one being played. */
function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * A recording's header line.
 *
 * `maxLoop` counts telemetry as well as frames. A game can hold messages past
 * its last recorded frame (an imported ladder file runs to the end of a match
 * this app only saw part of), and a timeline that stops at the last frame
 * stores them where no amount of scrubbing can reach.
 */
function recordingInfo(recording: HistoryStore, filePath: string): RecordingInfo {
  return {
    filePath,
    map: recording.getMeta("map") ?? "",
    mode: recording.getMeta("mode") ?? "",
    startedAt: recording.getMeta("started_at"),
    endedAt: recording.getMeta("ended_at"),
    maxLoop: Math.max(recording.getMaxLoop(), recording.getTelemetryMaxLoop() ?? 0),
  };
}

/**
 * Opening a game file, whether it came from the picker or from a row in the
 * catalog. One body, so the two cannot drift: the catalog is the main route
 * now, and the picker is what opens a game from somewhere else entirely.
 */
function openRecordingFile(filePath: string): OpenGameResultIpc {
  rememberPickerDir(path.dirname(filePath));
  // The tailer writes into the store it was built with, so it has to be shut
  // down before that store is closed, not after. Only if that store is the
  // one being replaced, though: a session's tailer belongs to the game being
  // played, and stopping it because the user glanced at an old recording
  // would leave that game with no telemetry for the rest of its run.
  if (tailerStore === store) stopTailing();
  store?.close();
  store = null;
  openFilePath = null;
  // Opening a recording is a request to look at it, even if a session is
  // running: the queries follow the window.
  activeSource = "recording";
  resetCaches();

  try {
    store = new HistoryStore(filePath);
  } catch (err) {
    // A file written by a newer build, or one that has been deleted or
    // damaged since it was listed. Either way the row that was clicked is
    // where it belongs on screen, not in a crash.
    resetCaches();
    return { status: "refused", problem: (err as Error).message, recording: null };
  }

  openFilePath = filePath;
  return { status: "done", problem: null, recording: recordingInfo(store, filePath) };
}

/** The games folder as the history browser sees it. Which row is live and
 * which is open are known here and nowhere else. */
function buildCatalog(): GameCatalogIpc {
  return {
    dir: gamesDir(),
    games: listGames(gamesDir()),
    liveFilePath: session?.status.gameFile ?? replaySession?.gameFile ?? null,
    openFilePath,
  };
}

/** Whether a session in this phase still owns the client and its frames. */
function sessionRunning(phase: SessionPhase): boolean {
  return phase !== "idle" && phase !== "stopped" && phase !== "failed";
}

/** A session that is not running, with room for the reason it is not. The
 * panel reads `error` and shows it, which is how a refusal reaches the user
 * without inventing a phase for it. */
function idleSessionStatus(): SessionStatusIpc {
  return {
    phase: session?.status.phase ?? "idle",
    mode: session?.status.mode ?? "A",
    map: session?.status.map ?? "",
    gameFile: null,
    gamesPlayed: session?.status.gamesPlayed ?? 0,
    loop: 0,
    botConnected: false,
    clientStatus: "none",
    seats: null,
    watchSeat: null,
    nextWatchSeat: null,
    error: null,
  };
}

function refused(problem: string): GameActionResultIpc {
  return { status: "refused", problem, catalog: buildCatalog() };
}

function send(channel: string, payload?: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload);
  }
}

function toIpcTerrain(terrain: TerrainData): TerrainDataIpc {
  return {
    width: terrain.width,
    height: terrain.height,
    pathingGrid: Array.from(terrain.pathingGrid),
    placementGrid: Array.from(terrain.placementGrid),
    terrainHeight: Array.from(terrain.terrainHeight),
    playableArea: terrain.playableArea,
    startLocations: terrain.startLocations,
  };
}

function resetCaches(): void {
  terrainCache = null;
  unitTypeInfoCache = null;
  channelsCache = null;
  telemetryResolver = null;
  gameOverlaysCache = null;
  observationMemo = null;
}

/** Everything held about the game currently being played. Cleared between
 * games, so the next one cannot draw on the previous one's map. */
function resetLiveGame(): void {
  liveTerrain = null;
  liveUnitTypes = {};
  liveFootprintsPending = false;
  firstObservation = null;
  latestObservation = null;
  liveOverlays = new GameOverlays();
  liveObservation = null;
  lastLiveFrame = null;
  if (liveFrameTimer) clearTimeout(liveFrameTimer);
  liveFrameTimer = null;
}

function pushLiveTerrain(): void {
  send("spectator:liveTerrain", {
    terrain: liveTerrain ? toIpcTerrain(liveTerrain) : null,
    unitTypes: liveUnitTypes,
  });
}

/**
 * The map is drawn from `gameInfo`'s grids minus the footprints of the units
 * standing on them at the start, which needs the first observation as well as
 * the map. The two arrive in whichever order the bot asks for them, so this
 * runs after either and does nothing until both are in.
 */
function applyFootprints(): void {
  if (!liveTerrain || !liveFootprintsPending || !firstObservation) return;
  clearInitialUnitFootprints(liveTerrain, extractUnits(decodeResponse(firstObservation)));
  liveFootprintsPending = false;
}

function pushLiveFrame(): void {
  const bytes = latestObservation;
  latestObservation = null;
  if (!bytes) return;
  const response = decodeResponse(bytes);
  const frame: FrameAtLoopIpc = {
    loop: response.observation?.observation?.game_loop ?? 0,
    units: extractUnits(response),
  };
  liveObservation = response;
  lastLiveFrame = frame;
  send("spectator:liveFrame", frame);
}

/**
 * Frames come off the bus at whatever rate the bot steps, which for a bot
 * stepping every loop is faster than anything can be drawn. Only the newest
 * one is kept: dropping an intermediate frame is what following the head
 * means, and the recording still has every one of them.
 */
function onLiveFrame(event: FrameEvent): void {
  // A game between two bots has a proxy per bot, each seeing its own bot's
  // view. The live view shows the one being recorded, so what is on screen
  // is what the file will hold. Only while that session runs: a replay after
  // it has its own frames and no seats.
  const watched = session && sessionRunning(session.status.phase) ? session.watchedSessionId : null;
  if (watched !== null && event.sessionId !== watched) return;

  // A new channel (the first Attack order, say) has to reach the tree. The
  // lines themselves need no push: the renderer asks for every loop it shows.
  if (liveOverlays.addFrame(event) && activeSource === "live") {
    channelsCache = null;
    send("spectator:telemetryAppended");
  }

  if (event.kind === "observation") {
    if (!firstObservation) {
      firstObservation = event.bytes;
      applyFootprints();
      if (liveTerrain) pushLiveTerrain();
    }
    latestObservation = event.bytes;
    if (!liveFrameTimer) {
      liveFrameTimer = setTimeout(() => {
        liveFrameTimer = null;
        pushLiveFrame();
      }, LIVE_FRAME_INTERVAL_MS);
    }
    return;
  }

  if (event.kind === "gameInfo") {
    liveTerrain = extractTerrain(decodeResponse(event.bytes));
    liveFootprintsPending = liveTerrain !== null;
    applyFootprints();
    pushLiveTerrain();
    return;
  }

  if (event.kind === "data") {
    liveUnitTypes = extractUnitTypeInfo(decodeResponse(event.bytes));
    pushLiveTerrain();
  }
}

/**
 * §3.5's auto-attach: a telemetry file being written while a game is live
 * belongs to that game, and the user should not have to point at a folder to
 * see their own bot's overlays.
 *
 * The cutoff is when the session started waiting for this game's bot, so a
 * file the bot is writing now is taken and every earlier run's file in the
 * same folder is not. Which folder that is becomes a setting in Phase 6; for
 * now it is the contract's default.
 */
function attachLiveTelemetry(): void {
  const gameStore = session?.activeStore;
  if (!gameStore) return;
  stopTailing();
  for (const { dir, seat } of liveTelemetryFolders()) {
    const next = new TelemetryTailer(gameStore, bus, dir, preExistingTelemetry.get(dir) ?? [], seat);
    tailers.push(next);
    next.start();
    bus.emit("dockerLog", { source: "session", line: `watching ${dir} for ${seat === null ? "" : `player ${seat}'s `}telemetry` });
  }
  tailerStore = gameStore;
}

/**
 * The folders a live game takes telemetry from. One bot: the folder picked by
 * hand, which outlives the game it was picked during because it is where the
 * bot writes, else the default. Two bots: each player's own folder, if one
 * was given; a player with none has no live telemetry.
 */
function liveTelemetryFolders(): { dir: string; seat: number | null }[] {
  if (session?.status.mode === "BvB") {
    return Object.entries(seatTelemetryDirs ?? {}).map(([seat, dir]) => ({ dir, seat: Number(seat) }));
  }
  return [{ dir: telemetryDir ?? defaultTelemetryDir(), seat: null }];
}

/** One place for both replay entry points to refuse: the client is a single
 * seat, and a live session or a replay already playing is in it. */
function replayBlocker(): string | null {
  if (session && session.status.phase !== "stopped" && session.status.phase !== "failed") {
    return "A live session has the client. Stop it first.";
  }
  if (replayDriver && !replayDriver.isFinished) return "A replay is already playing.";
  return null;
}

/** Pushes what the replay is doing before it has any loops to report. */
function noteReplay(note: string): void {
  if (!replayProgress) return;
  replayProgress = { ...replayProgress, note };
  send("spectator:replayProgress", replayProgress);
}

/**
 * Reads a replay without playing it: the map, the length, the build and the
 * players, which is what the "watch as" choice is made from. A replay from
 * another SC2 build is refused here rather than after the container has been
 * started and the user has waited.
 */
async function inspectReplay(sourcePath: string): Promise<InspectReplayResultIpc> {
  const filePath = path.resolve(sourcePath);
  const fileName = path.basename(filePath);
  const blocked = replayBlocker();
  if (blocked) return { status: "refused", problem: blocked, filePath, fileName, info: null };
  if (!existsSync(filePath)) {
    return { status: "failed", problem: "That replay is no longer on disk.", filePath, fileName, info: null };
  }

  let replayData: Buffer;
  try {
    replayData = readFileSync(filePath);
  } catch (err) {
    return { status: "failed", problem: (err as Error).message, filePath, fileName, info: null };
  }

  // Reading a replay needs the client, so the container comes up here. It
  // stays up for the play that usually follows.
  const ready = await docker().ensureClientReady();
  if (!ready.ok) {
    return {
      status: "refused",
      problem: ready.reason ?? "The client is not available.",
      filePath,
      fileName,
      info: null,
    };
  }

  const driver = new ReplayDriver({
    bus,
    sessionId: "inspect",
    connect: () => connectSc2(`ws://127.0.0.1:${CONTAINER_PORT}/sc2api`),
    replayData,
  });
  try {
    const info = await driver.readInfo();
    return { status: "done", problem: null, filePath, fileName, info };
  } catch (err) {
    const refused = err instanceof ReplayRefused;
    return { status: refused ? "refused" : "failed", problem: (err as Error).message, filePath, fileName, info: null };
  } finally {
    driver.close();
  }
}

/**
 * Plays a replay and records it, which is the whole of the replay driver from
 * the app's side.
 *
 * `observedPlayerId` is whose eyes it is watched through: the observer slot
 * sees the whole map, a player id sees exactly what that player could see
 * (measured; see ReplayDriver). `subjectPlayerId` is whose result the game
 * file calls its own, which is a different question and usually the bot's.
 */
async function beginReplay(
  sourcePath: string,
  observedPlayerId: number,
  subjectPlayerId: number,
): Promise<OpenReplayResultIpc> {
  const filePath = path.resolve(sourcePath);
  const blocked = replayBlocker();
  if (blocked) return { status: "refused", problem: blocked, progress: null };
  if (!existsSync(filePath)) {
    return { status: "failed", problem: "That replay is no longer on disk.", progress: null };
  }

  let replayData: Buffer;
  try {
    replayData = readFileSync(filePath);
  } catch (err) {
    return { status: "failed", problem: (err as Error).message, progress: null };
  }

  // Something on screen before any of the waiting starts. The container check
  // and the load take seconds each, and a window showing nothing reads as a
  // window that did not notice the file.
  replayProgress = {
    sourcePath: filePath,
    sourceName: path.basename(filePath),
    map: "",
    note: "starting the client",
    loop: 0,
    totalLoops: 0,
    playing: true,
    finished: false,
    error: null,
    gameFile: null,
  };
  send("spectator:replayProgress", replayProgress);

  const ready = await docker().ensureClientReady();
  if (!ready.ok) {
    const problem = ready.reason ?? "The client is not available.";
    finishReplay(problem);
    return { status: "refused", problem, progress: replayProgress };
  }

  const driver = new ReplayDriver({
    bus,
    sessionId: "replay",
    connect: () => connectSc2(`ws://127.0.0.1:${CONTAINER_PORT}/sc2api`),
    replayData,
    observedPlayerId,
  });

  noteReplay("reading the replay");
  let info: ReplayInfo;
  try {
    info = await driver.readInfo();
  } catch (err) {
    finishReplay((err as Error).message);
    const refused = err instanceof ReplayRefused;
    return { status: refused ? "refused" : "failed", problem: (err as Error).message, progress: replayProgress };
  }

  rememberPickerDir(path.dirname(filePath));
  resetLiveGame();
  replayDriver = driver;
  replaySession = new ReplaySession({
    bus,
    gamesDir: gamesDir(),
    sourcePath: filePath,
    info,
    observedPlayerId,
    subjectPlayerId,
    appVersion: app.getVersion(),
  });
  replaySession.attach();
  replayProgress = {
    ...replayProgress,
    map: info.localMapPath || info.mapName,
    totalLoops: info.durationLoops,
    note: "loading the replay",
  };
  send("spectator:replayProgress", replayProgress);
  // The queries follow the window, and the window is about to show a replay
  // filling up exactly as a live game does.
  activeSource = "live";

  try {
    await driver.start();
  } catch (err) {
    finishReplay((err as Error).message);
    return { status: "failed", problem: (err as Error).message, progress: replayProgress };
  }
  noteReplay("playing");

  // Deliberately not awaited: the replay plays for as long as it plays, and
  // the renderer follows it through `replayProgress` like any other push.
  void driver
    .run()
    .then(() => finishReplay(null))
    .catch((err: Error) => finishReplay(err.message));

  bus.emit("dockerLog", {
    source: "history",
    line: `playing ${path.basename(filePath)} (${info.durationLoops} loops)`,
  });
  return { status: "done", problem: null, progress: replayProgress };
}

/** Closes the recording once, however the replay ended: its last loop, a
 * stop, or an error. */
function finishReplay(error: string | null): void {
  if (!replayProgress) return;
  const file = replaySession?.gameFile ?? null;
  replaySession?.close();
  replaySession = null;
  replayProgress = { ...replayProgress, playing: false, finished: true, note: null, error, gameFile: file };
  send("spectator:replayProgress", replayProgress);
  bus.emit("dockerLog", {
    source: "history",
    line: error ? `the replay stopped: ${error}` : `recorded ${file ?? "nothing"}`,
  });
}

/** Everything already in a telemetry folder, for the ignore list above. */
function telemetryCensus(dir: string = telemetryDir ?? defaultTelemetryDir()): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith(".ndjson"))
      .map((name) => path.join(dir, name));
  } catch {
    // No folder yet is the normal case before a bot has ever run.
    return [];
  }
}

function listMaps(): string[] {
  try {
    return readdirSync(mapsDir())
      .filter((name) => name.toLowerCase().endsWith(".sc2map"))
      .sort();
  } catch {
    // No maps folder is a state the panel reports, not a crash.
    return [];
  }
}

/** Stops everything this process owns. Called on quit, where leaving a
 * container running is the failure that outlives the app. */
export async function shutdownSession(): Promise<void> {
  stopTailing();
  replayDriver?.stop();
  replaySession?.close();
  if (session) await session.stop();
  inspector?.stopLogStream();
  resetLiveGame();
  catalog?.close();
  catalog = null;
}

/** Everything derived from telemetry rows is stale once rows arrive: the
 * channel tree may have gained a channel, and every resolved loop may have
 * gained a message. */
function invalidateTelemetry(): void {
  channelsCache = null;
  telemetryResolver?.invalidate();
}

function stopTailing(): void {
  for (const each of tailers) each.stop();
  tailers = [];
  tailerStore = null;
}

/** What the header shows about the folders being watched, all of them at
 * once: a game between two bots watches one per player. */
function watchStatus(): TelemetryWatchIpc | null {
  if (tailers.length === 0) return null;
  const statuses = tailers.map((each) => each.status());
  return {
    dir: statuses.map((status) => status.dir).join(", "),
    files: statuses.flatMap((status) => status.files),
    skippedCount: statuses.reduce((sum, status) => sum + status.skippedCount, 0),
  };
}

/** The folder the watch picker opens on: the repo's `telemetry/`, which is
 * where `npm run testbot -- --telemetry telemetry` writes. */
function defaultTelemetryDir(): string {
  return path.join(app.getAppPath(), "telemetry");
}

/** The recorded observation at or before `loop`, decoded once per loop. Not
 * remembered for a live game, whose store is still filling in. */
function observationAt(store: HistoryStore, loop: number): Response | null {
  if (activeSource === "live" || observationMemo?.loop !== loop) {
    const bytes = store.readFrameAtOrBefore("observation", loop);
    observationMemo = { loop, response: bytes ? decodeResponse(bytes) : null };
  }
  return observationMemo.response;
}

/** The derived overlays for whichever game is on screen: the live one from
 * the bus, a recording from its stored frames. */
function currentGameOverlays(store: HistoryStore): GameOverlays {
  if (activeSource === "live") return liveOverlays;
  if (!gameOverlaysCache) gameOverlaysCache = GameOverlays.fromStore(store);
  return gameOverlaysCache;
}

/**
 * The telemetry state plus the overlays derived from the game itself. They
 * are merged here, on the way out, rather than written into the telemetry
 * tables: nothing is stored, so checkpoints, detach and streams never see
 * them.
 */
function resolveTelemetry(loop: number): TelemetryStateIpc {
  const store = db();
  if (!store) return { loop, overlays: [], snapshots: [], entities: [] };
  if (!telemetryResolver) telemetryResolver = new TelemetryResolver(store);
  const state = telemetryResolver.stateAt(loop);

  const derived = currentGameOverlays(store);
  const observation = !derived.needsObservation
    ? null
    : activeSource === "live"
      ? liveObservation
      : observationAt(store, loop);
  const extra = derived.overlaysAt(loop, observation);
  return extra.length === 0 ? state : { ...state, overlays: [...state.overlays, ...extra] };
}

/**
 * The channel tree's source. Channels a `hello` pre-declared and channels that
 * were only ever written both appear, because pre-declaration is optional
 * (§3.2) and a declaration is a promise the bot may not have kept yet.
 */
function buildChannels(): ChannelIpc[] {
  const store = db();
  if (!store) return [];

  const declared = new Map<string, ChannelDeclaration>();
  for (const stream of store.getStreams()) {
    for (const declaration of stream.channels ?? []) {
      declared.set(declaration.ch, declaration);
    }
  }

  const seriesNames = new Map<string, string[]>();
  for (const { ch, name } of store.getSeriesNames()) {
    const names = seriesNames.get(ch) ?? [];
    names.push(name);
    seriesNames.set(ch, names);
  }

  const channels: ChannelIpc[] = [];
  const seen = new Set<string>();
  for (const { ch, kind } of store.getTelemetryChannels()) {
    const declaration = declared.get(ch);
    channels.push({
      ch,
      kind,
      label: declaration?.label ?? null,
      unit: declaration?.unit ?? null,
      range: declaration?.range ?? null,
      defaultVisible: declaration?.visible ?? true,
      sticky: declaration?.sticky ?? false,
      seriesNames: seriesNames.get(ch) ?? [],
    });
    seen.add(ch);
  }
  for (const [ch, declaration] of declared) {
    if (seen.has(ch)) continue;
    channels.push({
      ch,
      kind: declaration.kind ?? "overlay",
      label: declaration.label ?? null,
      unit: declaration.unit ?? null,
      range: declaration.range ?? null,
      defaultVisible: declaration.visible ?? true,
      sticky: declaration.sticky ?? false,
      seriesNames: [],
    });
    seen.add(ch);
  }
  for (const channel of currentGameOverlays(store).channels()) {
    if (!seen.has(channel.ch)) channels.push(channel);
  }

  channels.sort((a, b) => a.ch.localeCompare(b.ch));
  return channels;
}

function toIpcStreams(): TelemetryStreamIpc[] {
  const store = db();
  if (!store) return [];
  return store.getStreams().map((stream) => ({
    id: stream.id,
    name: stream.name,
    sourcePath: stream.sourcePath,
    emitter: stream.emitter,
    meta: stream.meta,
    firstLoop: stream.firstLoop,
    lastLoop: stream.lastLoop,
    attachedAt: stream.attachedAt,
    messageCount: stream.messageCount,
    rejectedCount: stream.rejectedCount,
    seat: stream.seat ?? null,
  }));
}

/**
 * Reads an NDJSON telemetry file into the open game. Shared by the picker and
 * by a file dropped on the window, so both get the same refusal and the same
 * summary back. `seat` is the player the file belongs to in a game between
 * two bots, and null otherwise.
 */
async function ingestTelemetryFile(sourcePath: string, seat: number | null = null): Promise<AttachTelemetryResultIpc | null> {
  const store = db();
  if (!store) return null;
  const filePath = path.resolve(sourcePath);
  if (!existsSync(filePath)) return null;

  // A file dropped on the window is not gated on the game being live the way
  // the button is, so the tailer's game needs its own refusal: its file may
  // not have written a line yet, and then the store alone looks empty.
  const problem =
    tailerStore === store
      ? "Telemetry is still being read into this game. Stop watching it first."
      : telemetryRefusal(store, seat);
  if (problem) {
    return { status: "refused", problem, streams: toIpcStreams(), ingested: null };
  }

  const fallbackName = path.basename(filePath).replace(/\.ndjson$/i, "");
  const ingest = new StreamIngest(store, filePath, fallbackName, seat);
  const lines = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of lines) {
    ingest.line(line, ++lineNo);
  }
  const summary = ingest.finish();

  invalidateTelemetry();

  return {
    status: "ingested",
    problem: null,
    streams: toIpcStreams(),
    ingested: {
      name: summary.name,
      messageCount: summary.messageCount,
      rejectedCount: summary.rejectedCount,
      firstLoop: summary.firstLoop,
      lastLoop: summary.lastLoop,
      rejections: summary.rejections,
    },
  };
}

export function registerIpcHandlers(): void {
  // The tailer's rows land in the store; this is what tells the renderer they
  // are there. No payload: it re-asks for the loop it is already showing, so
  // the live path and the history path stay the same path (§3.6).
  bus.on("telemetry", () => {
    invalidateTelemetry();
    send("spectator:telemetryAppended");
  });

  bus.on("frame", onLiveFrame);

  // The replay's own heartbeat. The game file only exists once the first
  // frame has landed, so it is read here rather than carried by the driver,
  // which knows nothing about stores.
  bus.on("replayProgress", (event) => {
    if (!replayProgress || replayProgress.finished) return;
    replayProgress = {
      ...replayProgress,
      loop: event.loop,
      totalLoops: event.totalLoops || replayProgress.totalLoops,
      playing: event.playing,
      gameFile: replaySession?.gameFile ?? replayProgress.gameFile,
    };
    send("spectator:replayProgress", replayProgress);
  });
  bus.on("dockerLog", (event) => send("spectator:dockerLog", event));

  bus.on("sessionState", (state) => {
    send("spectator:sessionState", state);
    // Each game gets its own store, and the tailer writes into one store, so
    // a game appearing is a tailer appearing with it (§3.5).
    if (state.phase !== lastPhase) {
      lastPhase = state.phase;
      // The moment the session starts waiting for a bot is the last moment
      // the folder holds only older runs' files.
      if (state.phase === "gameCreated" || state.phase === "clientReady") {
        preExistingTelemetry = new Map(liveTelemetryFolders().map(({ dir }) => [dir, telemetryCensus(dir)]));
      }
    }
    if (state.gameFile !== liveGameFile) {
      liveGameFile = state.gameFile;
      if (state.gameFile) attachLiveTelemetry();
    }
  });

  bus.on("gameEnded", () => {
    // Before the controller closes the game's store, not after: stopping the
    // tailer writes each stream's closing checkpoint, and a closed store
    // cannot take it.
    stopTailing();
    // The next game is a different map's worth of terrain and a different
    // unit list, so nothing from this one may survive into it.
    resetLiveGame();
  });

  ipcMain.handle("spectator:pickAndOpenRecording", async (): Promise<OpenGameResultIpc> => {
    const result = await dialog.showOpenDialog({
      title: "Open Recording",
      defaultPath: pickerDir(),
      filters: [{ name: "Spectator recordings", extensions: ["sqlite"] }],
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { status: "cancelled", problem: null, recording: null };
    }
    return openRecordingFile(result.filePaths[0]!);
  });

  // -- the history browser (§6.4) -------------------------------------------

  ipcMain.handle("spectator:listGames", (): GameCatalogIpc => buildCatalog());

  ipcMain.handle("spectator:openGame", (_event, filePath: string): OpenGameResultIpc => {
    if (!existsSync(filePath)) {
      return { status: "failed", problem: "That game is no longer on disk.", recording: null };
    }
    return openRecordingFile(filePath);
  });

  /**
   * Delete, to the recycle bin rather than to nowhere. A game is 20 MB of
   * something that cannot be replayed into existence, and the confirmation
   * the user clicked through says which files go; it does not say "forever".
   */
  ipcMain.handle("spectator:deleteGame", async (_event, filePath: string): Promise<GameActionResultIpc> => {
    const live = session?.status.gameFile;
    if (live && samePath(live, filePath)) {
      return refused("That game is being played right now.");
    }

    // Windows will not unlink a file SQLite still has open, and the failure
    // is a permission error with nothing in it about why. So the viewer lets
    // go first; the renderer sees `openFilePath` come back null and goes back
    // to the list.
    if (openFilePath && samePath(openFilePath, filePath)) {
      if (tailerStore === store) stopTailing();
      store?.close();
      store = null;
      openFilePath = null;
      resetCaches();
    }

    for (const file of gameFilesFor(filePath)) {
      if (!existsSync(file)) continue;
      const failure = await shell.trashItem(file).then(
        () => null,
        (err: Error) => err.message,
      );
      if (failure) {
        return { status: "failed", problem: `${path.basename(file)}: ${failure}`, catalog: buildCatalog() };
      }
    }
    return { status: "done", problem: null, catalog: buildCatalog() };
  });

  ipcMain.handle("spectator:exportGame", async (_event, filePath: string): Promise<GameActionResultIpc> => {
    if (!existsSync(filePath)) {
      return { status: "failed", problem: "That game is no longer on disk.", catalog: buildCatalog() };
    }
    const result = await dialog.showSaveDialog({
      title: "Export Game",
      defaultPath: path.join(pickerDir(), path.basename(filePath)),
      filters: [{ name: "Spectator recordings", extensions: ["sqlite"] }],
    });
    if (result.canceled || !result.filePath) {
      return { status: "cancelled", problem: null, catalog: buildCatalog() };
    }

    try {
      const withReplay = exportGameTo(filePath, result.filePath);
      bus.emit("dockerLog", {
        source: "history",
        line: withReplay
          ? `exported ${path.basename(filePath)} and its replay to ${result.filePath}`
          : `exported ${path.basename(filePath)} to ${result.filePath} (no replay beside it)`,
      });
    } catch (err) {
      return { status: "failed", problem: (err as Error).message, catalog: buildCatalog() };
    }
    return { status: "done", problem: null, catalog: buildCatalog() };
  });

  /** Tags go into the game's own `meta` so they travel with the file. Written
   * through the open store when there is one, rather than through a second
   * connection to a database this process already holds. */
  ipcMain.handle("spectator:setGameTags", (_event, filePath: string, tags: string[]): GameActionResultIpc => {
    const normalized = normalizeTags(tags ?? []);
    try {
      const open =
        openFilePath && samePath(openFilePath, filePath)
          ? store
          : session?.status.gameFile && samePath(session.status.gameFile, filePath)
            ? session.activeStore
            : null;
      if (open) open.setMeta("tags", JSON.stringify(normalized));
      else writeGameTags(filePath, normalized);
    } catch (err) {
      return { status: "failed", problem: (err as Error).message, catalog: buildCatalog() };
    }
    return { status: "done", problem: null, catalog: buildCatalog() };
  });

  /**
   * §3.5's recovery. The rows go, and with them every checkpoint, which is
   * not tidiness: a checkpoint holds the resolved state of all streams at a
   * loop, so the departed stream's overlays are baked into each one and
   * nothing in the remaining messages would ever take them out.
   */
  ipcMain.handle("spectator:detachStream", (_event, streamId: number): DetachStreamResultIpc => {
    const target = db();
    const report = (status: DetachStreamResultIpc["status"], problem: string | null): DetachStreamResultIpc => ({
      status,
      problem,
      streams: toIpcStreams(),
      maxLoop: target ? Math.max(target.getMaxLoop(), target.getTelemetryMaxLoop() ?? 0) : 0,
    });

    if (!target) return report("refused", "No game is open.");
    // A tailer appends to the store as the file grows, and it holds the
    // stream ids it is writing into. Detaching underneath it would have it
    // re-create the stream on its next poll, or write rows against an id that
    // no longer exists.
    if (tailerStore === target) {
      return report("refused", "Telemetry is still being read into this game. Stop watching it first.");
    }

    if (!detachStream(target, streamId)) return report("refused", "That stream is not in this game.");
    invalidateTelemetry();
    return report("done", null);
  });

  ipcMain.handle("spectator:getTerrain", (): TerrainDataIpc | null => {
    const store = db();
    if (!store) return null;
    if (!terrainCache) {
      const bytes = store.readFrameAtOrBefore("gameInfo", 0);
      if (!bytes) return null;
      const terrain = extractTerrain(decodeResponse(bytes));
      if (terrain) {
        const obsBytes = store.readFrameAtOrBefore("observation", 0);
        if (obsBytes) {
          clearInitialUnitFootprints(terrain, extractUnits(decodeResponse(obsBytes)));
        }
      }
      terrainCache = terrain;
    }
    return terrainCache ? toIpcTerrain(terrainCache) : null;
  });

  ipcMain.handle("spectator:getUnitTypeInfo", (): Record<number, UnitTypeInfoIpc> => {
    const store = db();
    if (!store) return {};
    if (!unitTypeInfoCache) {
      const bytes = store.readFrameAtOrBefore("data", 0);
      unitTypeInfoCache = bytes ? extractUnitTypeInfo(decodeResponse(bytes)) : {};
    }
    return unitTypeInfoCache;
  });

  ipcMain.handle("spectator:getFrameAtLoop", (_event, loop: number): FrameAtLoopIpc | null => {
    const store = db();
    if (!store) return null;
    const response = observationAt(store, loop);
    if (!response) return null;
    const actualLoop = response.observation?.observation?.game_loop ?? loop;
    return { loop: actualLoop, units: extractUnits(response) };
  });

  ipcMain.handle("spectator:attachTelemetry", async (_event, seat?: number | null): Promise<AttachTelemetryResultIpc | null> => {
    if (!db()) return null;
    const result = await dialog.showOpenDialog({
      title: "Attach Telemetry",
      defaultPath: pickerDir(),
      filters: [{ name: "Telemetry (NDJSON)", extensions: ["ndjson"] }],
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return ingestTelemetryFile(result.filePaths[0]!, seat ?? null);
  });

  /** The same import by path, for a file dropped on the window: §3.5's
   * pairing of a ladder replay with the telemetry from that match. */
  ipcMain.handle(
    "spectator:attachTelemetryFile",
    (_event, filePath: string, seat?: number | null): Promise<AttachTelemetryResultIpc | null> => ingestTelemetryFile(filePath, seat ?? null),
  );

  ipcMain.handle("spectator:getTelemetryStreams", (): TelemetryStreamIpc[] => toIpcStreams());

  ipcMain.handle("spectator:getChannels", (): ChannelIpc[] => {
    if (!db()) return [];
    if (!channelsCache) channelsCache = buildChannels();
    return channelsCache;
  });

  ipcMain.handle("spectator:getTelemetryAtLoop", (_event, loop: number): TelemetryStateIpc => resolveTelemetry(loop));

  ipcMain.handle("spectator:getSeries", (_event, ch: string, name: string): SeriesDataIpc => {
    const store = db();
    if (!store) return { ch, name, loops: [], values: [] };
    return store.readSeries(ch, name);
  });

  ipcMain.handle("spectator:getEvents", (_event, filter: EventFilterIpc | undefined): EventIpc[] => {
    const store = db();
    if (!store) return [];
    return store.readEvents(filter ?? {});
  });

  ipcMain.handle("spectator:watchTelemetryFolder", async (): Promise<TelemetryWatchIpc | null> => {
    const store = db();
    if (!store) return null;
    const result = await dialog.showOpenDialog({
      title: "Watch Telemetry Folder",
      defaultPath: defaultTelemetryDir(),
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    stopTailing();
    telemetryDir = path.resolve(result.filePaths[0]!);
    // A game holds one telemetry file, so watching means "the next file
    // written here", the same as a live game's auto-attach: what is already
    // in the folder is earlier runs, and an existing file goes in with
    // Attach Telemetry instead. It is only offered while no session is
    // running, because the live game has auto-attach for that.
    const watcher = new TelemetryTailer(store, bus, telemetryDir, telemetryCensus());
    tailers = [watcher];
    tailerStore = store;
    watcher.start();
    // start() polls once, so anything already in the folder is in by now.
    return watchStatus();
  });

  ipcMain.handle("spectator:stopWatchingTelemetry", (): null => {
    // stop() writes each stream's closing checkpoint, which changes what a
    // resolved loop replays from.
    stopTailing();
    invalidateTelemetry();
    return null;
  });

  ipcMain.handle("spectator:getTelemetryWatch", (): TelemetryWatchIpc | null => watchStatus());

  // -- replays (§7's replay driver) -----------------------------------------

  ipcMain.handle("spectator:inspectReplay", (_event, filePath: string): Promise<InspectReplayResultIpc> =>
    inspectReplay(filePath),
  );

  ipcMain.handle("spectator:pickReplay", async (): Promise<InspectReplayResultIpc> => {
    const result = await dialog.showOpenDialog({
      title: "Open Replay",
      defaultPath: pickerDir(),
      filters: [{ name: "StarCraft II replays", extensions: ["SC2Replay"] }],
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { status: "cancelled", problem: null, filePath: "", fileName: "", info: null };
    }
    return inspectReplay(result.filePaths[0]!);
  });

  ipcMain.handle(
    "spectator:openReplay",
    (_event, filePath: string, observedPlayerId: number, subjectPlayerId: number): Promise<OpenReplayResultIpc> =>
      beginReplay(filePath, observedPlayerId, subjectPlayerId),
  );

  /** Play, pause and stop. Pausing is fine here and nowhere near a bot: a
   * replay has no lockstep peer to starve (§4). */
  ipcMain.handle(
    "spectator:controlReplay",
    (_event, action: string, speed?: number | "max"): ReplayProgressIpc | null => {
      if (!replayDriver || !replayProgress) return null;
      if (speed !== undefined) replayDriver.setSpeed(speed);
      if (action === "play") replayDriver.play();
      if (action === "pause") replayDriver.pause();
      if (action === "stop") replayDriver.stop();
      return replayProgress;
    },
  );

  ipcMain.handle("spectator:getReplayProgress", (): ReplayProgressIpc | null => replayProgress);

  // -- the session ---------------------------------------------------------

  ipcMain.handle("spectator:listMaps", (): string[] => listMaps());

  ipcMain.handle("spectator:getDockerState", async (): Promise<DockerStateIpc> => {
    const manager = docker();
    const availability = await manager.detect();
    if (!availability.available) {
      return {
        available: false,
        version: null,
        reason: availability.reason,
        image: IMAGE_NAME,
        imageExists: false,
        container: "missing",
      };
    }
    return {
      available: true,
      version: availability.version,
      reason: null,
      image: IMAGE_NAME,
      imageExists: await manager.imageExists(),
      container: await manager.containerStatus(),
    };
  });

  ipcMain.handle("spectator:startSession", async (_event, options: StartSessionOptionsIpc): Promise<SessionStatusIpc> => {
    // The other half of the one-owner rule: a replay is using the client, and
    // starting a session would take the container out from under it.
    if (replayDriver && !replayDriver.isFinished) {
      return { ...idleSessionStatus(), error: "A replay is playing. Stop it first." };
    }
    // A session that is still running is not replaced: starting a second one
    // would bind the same bot port and fight the first for the client.
    if (session && session.status.phase !== "stopped" && session.status.phase !== "failed") {
      return session.status;
    }
    if (session) await session.stop();

    resetLiveGame();
    // Player 1's folder falls back to the usual one; player 2 has live
    // telemetry only if given a folder, so two bots never share one.
    seatTelemetryDirs = null;
    if (options.mode === "BvB") {
      seatTelemetryDirs = { 1: options.telemetryDirs?.[1] ?? telemetryDir ?? defaultTelemetryDir() };
      const second = options.telemetryDirs?.[2];
      if (second) seatTelemetryDirs[2] = second;
    }
    session = new SessionController({
      bus,
      dockerfileDir: dockerDir(),
      mapsDir: mapsDir(),
      gamesDir: gamesDir(),
      map: options.map,
      mode: (options.mode as GameMode) ?? "A",
      opponentRace: options.opponentRace,
      opponentDifficulty: options.opponentDifficulty,
      watchSeat: options.watchSeat === 2 ? 2 : 1,
      appVersion: app.getVersion(),
    });
    activeSource = "live";
    await session.start();
    return session.status;
  });

  // A game between two bots: each player's telemetry folder, remembered in the
  // catalog's settings so the next session starts with the same ones.
  const bvbDirKey = (seat: number): string => `bvbTelemetryDir${seat}`;
  ipcMain.handle("spectator:getBvbTelemetryDirs", (): Record<number, string> => {
    const dirs: Record<number, string> = {};
    for (const seat of [1, 2]) {
      const dir = settings().getSetting(bvbDirKey(seat));
      if (dir) dirs[seat] = dir;
    }
    return dirs;
  });
  ipcMain.handle("spectator:pickBvbTelemetryDir", async (_event, seat: number): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: `Player ${seat}'s telemetry folder`,
      defaultPath: settings().getSetting(bvbDirKey(seat)) ?? defaultTelemetryDir(),
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const dir = path.resolve(result.filePaths[0]!);
    settings().setSetting(bvbDirKey(seat), dir);
    return dir;
  });
  ipcMain.handle("spectator:clearBvbTelemetryDir", (_event, seat: number): null => {
    settings().clearSetting(bvbDirKey(seat));
    return null;
  });

  /** For the join lines a user copies into their bot's launch command. */
  ipcMain.handle("spectator:copyText", (_event, text: string): null => {
    clipboard.writeText(text);
    return null;
  });

  // A game between two bots: whose view to show and record. It applies now if
  // nothing of the current game is recorded yet, else from the next game.
  ipcMain.handle("spectator:setWatchedSeat", (_event, seat: number): SessionStatusIpc | null => {
    if (!session) return null;
    session.setWatchedSeat(seat === 2 ? 2 : 1);
    return session.status;
  });

  ipcMain.handle("spectator:stopSession", async (): Promise<SessionStatusIpc | null> => {
    if (!session) return null;
    // Before the session closes its store, which the tailer writes into.
    stopTailing();
    await session.stop();
    resetLiveGame();
    // Back to whatever recording was open, which may be nothing.
    activeSource = "recording";
    return session.status;
  });

  ipcMain.handle("spectator:getSessionState", (): SessionStatusIpc | null => session?.status ?? null);

  /**
   * Which of the two the viewer is showing. A running session and an opened
   * recording are different games, and the queries have to answer from the one
   * on screen. Coming back to the live view re-sends what it needs, because
   * the map and the current frame were pushed once and are not in any store
   * the renderer can ask.
   */
  ipcMain.handle("spectator:setActiveSource", (_event, kind: string): null => {
    activeSource = kind === "live" ? "live" : "recording";
    if (activeSource === "live") {
      pushLiveTerrain();
      if (lastLiveFrame) send("spectator:liveFrame", lastLiveFrame);
    }
    return null;
  });
}
