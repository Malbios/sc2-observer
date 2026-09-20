import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { app, dialog, ipcMain } from "electron";
import { HistoryStore } from "../history/HistoryStore";
import { decodeResponse } from "../protocol/schema";
import { clearInitialUnitFootprints, extractTerrain, type TerrainData } from "../state/terrain";
import { extractUnits } from "../state/frames";
import { extractUnitTypeInfo } from "../state/unitTypes";
import { StreamIngest } from "../telemetry/ingest";
import { TelemetryResolver } from "../telemetry/TelemetryResolver";
import type { AttachTelemetryResultIpc, FrameAtLoopIpc, RecordingInfo, TerrainDataIpc, UnitTypeInfoIpc } from "../shared/ipc-types";
import type {
  ChannelDeclaration,
  ChannelIpc,
  EventFilterIpc,
  EventIpc,
  SeriesDataIpc,
  TelemetryStateIpc,
  TelemetryStreamIpc,
} from "../shared/telemetry-types";

let store: HistoryStore | null = null;
let terrainCache: TerrainData | null = null;
let unitTypeInfoCache: Record<number, UnitTypeInfoIpc> | null = null;
let channelsCache: ChannelIpc[] | null = null;
let telemetryResolver: TelemetryResolver | null = null;
// Starts at the repo's fixtures/ folder (the only place recordings live so
// far); once a recording is opened, defaults to that file's folder next time.
let lastOpenedDir = path.join(app.getAppPath(), "fixtures");

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

function resolveTelemetry(loop: number): TelemetryStateIpc {
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
    store?.close();
    store = new HistoryStore(filePath);
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
    if (!store) return {};
    if (!unitTypeInfoCache) {
      const bytes = store.readFrameAtOrBefore("data", 0);
      unitTypeInfoCache = bytes ? extractUnitTypeInfo(decodeResponse(bytes)) : {};
    }
    return unitTypeInfoCache;
  });

  ipcMain.handle("spectator:getFrameAtLoop", (_event, loop: number): FrameAtLoopIpc | null => {
    if (!store) return null;
    const bytes = store.readFrameAtOrBefore("observation", loop);
    if (!bytes) return null;
    const response = decodeResponse(bytes);
    const actualLoop = response.observation?.observation?.game_loop ?? loop;
    return { loop: actualLoop, units: extractUnits(response) };
  });

  ipcMain.handle("spectator:attachTelemetry", async (): Promise<AttachTelemetryResultIpc | null> => {
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

    // New rows change both the channel tree and every resolved loop.
    channelsCache = null;
    telemetryResolver?.invalidate();

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
    if (!store) return [];
    if (!channelsCache) channelsCache = buildChannels();
    return channelsCache;
  });

  ipcMain.handle("spectator:getTelemetryAtLoop", (_event, loop: number): TelemetryStateIpc => resolveTelemetry(loop));

  ipcMain.handle("spectator:getSeries", (_event, ch: string, name: string): SeriesDataIpc => {
    if (!store) return { ch, name, loops: [], values: [] };
    return store.readSeries(ch, name);
  });

  ipcMain.handle("spectator:getEvents", (_event, filter: EventFilterIpc | undefined): EventIpc[] => {
    if (!store) return [];
    return store.readEvents(filter ?? {});
  });
}
