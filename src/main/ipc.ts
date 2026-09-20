import path from "node:path";
import { app, dialog, ipcMain } from "electron";
import { HistoryStore } from "../history/HistoryStore";
import { decodeResponse } from "../protocol/schema";
import { clearInitialUnitFootprints, extractTerrain, type TerrainData } from "../state/terrain";
import { extractUnits } from "../state/frames";
import { extractUnitTypeInfo } from "../state/unitTypes";
import type { FrameAtLoopIpc, RecordingInfo, TerrainDataIpc, UnitTypeInfoIpc } from "../shared/ipc-types";

let store: HistoryStore | null = null;
let terrainCache: TerrainData | null = null;
let unitTypeInfoCache: Record<number, UnitTypeInfoIpc> | null = null;
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
    terrainCache = null;
    unitTypeInfoCache = null;

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
}
