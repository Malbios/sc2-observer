import { createReadStream, readdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { EventBus, type FrameEvent } from "../bus/EventBus";
import { DockerManager, IMAGE_NAME } from "../docker/DockerManager";
import { HistoryStore } from "../history/HistoryStore";
import { SessionController } from "../session/SessionController";
import type { GameMode } from "../proxy/GameProxy";
import { decodeResponse } from "../protocol/schema";
import { clearInitialUnitFootprints, extractTerrain, type TerrainData } from "../state/terrain";
import { extractUnits } from "../state/frames";
import { extractUnitTypeInfo } from "../state/unitTypes";
import { StreamIngest } from "../telemetry/ingest";
import { TelemetryResolver } from "../telemetry/TelemetryResolver";
import { TelemetryTailer } from "../telemetry/TelemetryTailer";
import type {
  AttachTelemetryResultIpc,
  DockerStateIpc,
  FrameAtLoopIpc,
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
let tailer: TelemetryTailer | null = null;
/** The store the tailer writes into, which is not always the one on screen: a
 * session's tailer follows its game while the user looks at a recording. */
let tailerStore: HistoryStore | null = null;
let terrainCache: TerrainData | null = null;
let unitTypeInfoCache: Record<number, UnitTypeInfoIpc> | null = null;
let channelsCache: ChannelIpc[] | null = null;
let telemetryResolver: TelemetryResolver | null = null;
// Starts at the repo's fixtures/ folder (the only place recordings live so
// far); once a recording is opened, defaults to that file's folder next time.
let lastOpenedDir = path.join(app.getAppPath(), "fixtures");

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
let preExistingTelemetry: string[] = [];
/** A folder the user picked by hand, which then outranks the default for the
 * rest of the run. Null until they pick one. */
let telemetryDir: string | null = null;

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

/** A manager for looking, not touching. The session owns its own; this one
 * answers the panel's questions before a session exists. */
function docker(): DockerManager {
  if (!inspector) inspector = new DockerManager({ bus, dockerfileDir: dockerDir(), mapsDir: mapsDir() });
  return inspector;
}

/** The store the queries read from. */
function db(): HistoryStore | null {
  const next = activeSource === "live" ? session?.activeStore ?? null : store;
  if (next !== cachedStore) {
    cachedStore = next;
    resetCaches();
  }
  return next;
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
}

/** Everything held about the game currently being played. Cleared between
 * games, so the next one cannot draw on the previous one's map. */
function resetLiveGame(): void {
  liveTerrain = null;
  liveUnitTypes = {};
  liveFootprintsPending = false;
  firstObservation = null;
  latestObservation = null;
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
  // A folder the user picked by hand outlives the game it was picked during:
  // it is where their bot writes, and reverting to the default for the next
  // game would silently stop following it.
  const dir = telemetryDir ?? defaultTelemetryDir();
  tailer = new TelemetryTailer(gameStore, bus, dir, preExistingTelemetry);
  tailerStore = gameStore;
  tailer.start();
  bus.emit("dockerLog", { source: "session", line: `watching ${dir} for telemetry` });
}

/** Everything already in the telemetry folder, for the ignore list above. */
function telemetryCensus(): string[] {
  const dir = telemetryDir ?? defaultTelemetryDir();
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
  if (session) await session.stop();
  inspector?.stopLogStream();
  resetLiveGame();
}

/** Everything derived from telemetry rows is stale once rows arrive: the
 * channel tree may have gained a channel, and every resolved loop may have
 * gained a message. */
function invalidateTelemetry(): void {
  channelsCache = null;
  telemetryResolver?.invalidate();
}

function stopTailing(): void {
  tailer?.stop();
  tailer = null;
  tailerStore = null;
}

/** The folder the watch picker opens on: the repo's `telemetry/`, which is
 * where `npm run testbot -- --telemetry telemetry` writes. */
function defaultTelemetryDir(): string {
  return path.join(app.getAppPath(), "telemetry");
}

function resolveTelemetry(loop: number): TelemetryStateIpc {
  const store = db();
  if (!store) return { loop, overlays: [], snapshots: [], entities: [] };
  if (!telemetryResolver) telemetryResolver = new TelemetryResolver(store);
  return telemetryResolver.stateAt(loop);
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
  }));
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
  bus.on("dockerLog", (event) => send("spectator:dockerLog", event));

  bus.on("sessionState", (state) => {
    send("spectator:sessionState", state);
    // Each game gets its own store, and the tailer writes into one store, so
    // a game appearing is a tailer appearing with it (§3.5).
    if (state.phase !== lastPhase) {
      lastPhase = state.phase;
      // The moment the session starts waiting for a bot is the last moment
      // the folder holds only older runs' files.
      if (state.phase === "gameCreated" || state.phase === "clientReady") preExistingTelemetry = telemetryCensus();
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

  ipcMain.handle("spectator:pickAndOpenRecording", async (): Promise<RecordingInfo | null> => {
    const result = await dialog.showOpenDialog({
      title: "Open Recording",
      defaultPath: lastOpenedDir,
      filters: [{ name: "Spectator recordings", extensions: ["sqlite"] }],
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const filePath = result.filePaths[0];
    lastOpenedDir = path.dirname(filePath);
    // The tailer writes into the store it was built with, so it has to be shut
    // down before that store is closed, not after. Only if that store is the
    // one being replaced, though: a session's tailer belongs to the game being
    // played, and stopping it because the user glanced at an old recording
    // would leave that game with no telemetry for the rest of its run.
    if (tailerStore === store) stopTailing();
    store?.close();
    store = new HistoryStore(filePath);
    // Opening a recording is a request to look at it, even if a session is
    // running: the queries follow the window.
    activeSource = "recording";
    resetCaches();

    const maxLoopRow = store.getMaxLoop();
    return {
      filePath,
      map: store.getMeta("map") ?? "",
      mode: store.getMeta("mode") ?? "",
      startedAt: store.getMeta("started_at"),
      endedAt: store.getMeta("ended_at"),
      maxLoop: maxLoopRow,
    };
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
    const bytes = store.readFrameAtOrBefore("observation", loop);
    if (!bytes) return null;
    const response = decodeResponse(bytes);
    const actualLoop = response.observation?.observation?.game_loop ?? loop;
    return { loop: actualLoop, units: extractUnits(response) };
  });

  ipcMain.handle("spectator:attachTelemetry", async (): Promise<AttachTelemetryResultIpc | null> => {
    const store = db();
    if (!store) return null;
    const result = await dialog.showOpenDialog({
      title: "Attach Telemetry",
      defaultPath: lastOpenedDir,
      filters: [{ name: "Telemetry (NDJSON)", extensions: ["ndjson"] }],
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const filePath = path.resolve(result.filePaths[0]!);
    // Importing the same file twice would duplicate every row: two streams,
    // two overlays drawn on top of each other, every series counted twice.
    // Windows paths are case-insensitive, so compare them that way.
    const samePath = (a: string, b: string): boolean =>
      process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
    if (store.getStreams().some((stream) => samePath(path.resolve(stream.sourcePath), filePath))) {
      return { status: "already-attached", streams: toIpcStreams(), ingested: null };
    }

    const fallbackName = path.basename(filePath).replace(/\.ndjson$/i, "");
    const ingest = new StreamIngest(store, filePath, fallbackName);
    const lines = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    let lineNo = 0;
    for await (const line of lines) {
      ingest.line(line, ++lineNo);
    }
    const summary = ingest.finish();

    invalidateTelemetry();

    return {
      status: "ingested",
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
  });

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
    // Picking a folder means "import what is in it", which is why this takes
    // everything. It is only offered while no session is running: pointing it
    // at a folder mid-game imported three earlier runs into the live game,
    // each on its own loop axis, which is what a live game gets auto-attach
    // and its ignore list for.
    tailer = new TelemetryTailer(store, bus, telemetryDir);
    tailerStore = store;
    tailer.start();
    // start() polls once, so anything already in the folder is in by now.
    return tailer.status();
  });

  ipcMain.handle("spectator:stopWatchingTelemetry", (): null => {
    // stop() writes each stream's closing checkpoint, which changes what a
    // resolved loop replays from.
    stopTailing();
    invalidateTelemetry();
    return null;
  });

  ipcMain.handle("spectator:getTelemetryWatch", (): TelemetryWatchIpc | null => tailer?.status() ?? null);

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
    // A session that is still running is not replaced: starting a second one
    // would bind the same bot port and fight the first for the client.
    if (session && session.status.phase !== "stopped" && session.status.phase !== "failed") {
      return session.status;
    }
    if (session) await session.stop();

    resetLiveGame();
    session = new SessionController({
      bus,
      dockerfileDir: dockerDir(),
      mapsDir: mapsDir(),
      gamesDir: gamesDir(),
      map: options.map,
      mode: (options.mode as GameMode) ?? "A",
      opponentRace: options.opponentRace,
      opponentDifficulty: options.opponentDifficulty,
    });
    activeSource = "live";
    await session.start();
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
