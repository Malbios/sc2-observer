import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  DockerLogIpc,
  ConversionIpc,
  ReplayImportIpc,
  FrameAtLoopIpc,
  LiveTerrainIpc,
  SessionStatusIpc,
  SpectatorApi,
  StartSessionOptionsIpc,
} from "../shared/ipc-types";
import type { EventFilterIpc } from "../shared/telemetry-types";

/** Every push is exposed the same way: the renderer gets the payload and an
 * unsubscribe, never the IpcRendererEvent, which would hand it a channel back
 * into main. */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: unknown, payload: T): void => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const api: SpectatorApi = {
  pickAndOpenRecording: () => ipcRenderer.invoke("spectator:pickAndOpenRecording"),

  listGames: () => ipcRenderer.invoke("spectator:listGames"),
  openGame: (filePath: string) => ipcRenderer.invoke("spectator:openGame", filePath),
  deleteGame: (filePath: string) => ipcRenderer.invoke("spectator:deleteGame", filePath),
  exportGame: (filePath: string) => ipcRenderer.invoke("spectator:exportGame", filePath),
  setGameTags: (filePath: string, tags: string[]) => ipcRenderer.invoke("spectator:setGameTags", filePath, tags),
  detachStream: (streamId: number) => ipcRenderer.invoke("spectator:detachStream", streamId),

  describeReplays: (filePaths: string[]) => ipcRenderer.invoke("spectator:describeReplays", filePaths),
  pickReplayFiles: () => ipcRenderer.invoke("spectator:pickReplayFiles"),
  enqueueReplays: (imports: ReplayImportIpc[]) => ipcRenderer.invoke("spectator:enqueueReplays", imports),
  stopConversion: (id: number) => ipcRenderer.invoke("spectator:stopConversion", id),
  getConversions: () => ipcRenderer.invoke("spectator:getConversions"),
  onConversions: (listener: (conversions: ConversionIpc[]) => void) => subscribe("spectator:conversions", listener),
  getViewpoints: () => ipcRenderer.invoke("spectator:getViewpoints"),
  setViewpoint: (id: number) => ipcRenderer.invoke("spectator:setViewpoint", id),
  /** Electron dropped `File.path` in v32; this is the supported replacement,
   * and it only works in the preload, which is why it is on the bridge at all
   * rather than being read off the drop event in the renderer. */
  pathForFile: (file: File) => webUtils.getPathForFile(file),

  getTerrain: () => ipcRenderer.invoke("spectator:getTerrain"),
  getUnitTypeInfo: () => ipcRenderer.invoke("spectator:getUnitTypeInfo"),
  getPlayers: () => ipcRenderer.invoke("spectator:getPlayers"),
  getFrameAtLoop: (loop: number) => ipcRenderer.invoke("spectator:getFrameAtLoop", loop),

  attachTelemetry: (seat?: number | null) => ipcRenderer.invoke("spectator:attachTelemetry", seat ?? null),
  attachTelemetryFile: (filePath: string, seat?: number | null) =>
    ipcRenderer.invoke("spectator:attachTelemetryFile", filePath, seat ?? null),
  getTelemetryStreams: () => ipcRenderer.invoke("spectator:getTelemetryStreams"),
  getChannels: () => ipcRenderer.invoke("spectator:getChannels"),
  getTelemetryAtLoop: (loop: number) => ipcRenderer.invoke("spectator:getTelemetryAtLoop", loop),
  getSeries: (ch: string, name: string) => ipcRenderer.invoke("spectator:getSeries", ch, name),
  getEvents: (filter?: EventFilterIpc) => ipcRenderer.invoke("spectator:getEvents", filter),

  watchTelemetryFolder: () => ipcRenderer.invoke("spectator:watchTelemetryFolder"),
  stopWatchingTelemetry: () => ipcRenderer.invoke("spectator:stopWatchingTelemetry"),
  getTelemetryWatch: () => ipcRenderer.invoke("spectator:getTelemetryWatch"),
  onTelemetryAppended: (listener: () => void) => subscribe("spectator:telemetryAppended", () => listener()),

  listMaps: () => ipcRenderer.invoke("spectator:listMaps"),
  getDockerState: () => ipcRenderer.invoke("spectator:getDockerState"),
  startSession: (options: StartSessionOptionsIpc) => ipcRenderer.invoke("spectator:startSession", options),
  stopSession: () => ipcRenderer.invoke("spectator:stopSession"),
  getSessionState: () => ipcRenderer.invoke("spectator:getSessionState"),
  setWatchedSeat: (seat: number) => ipcRenderer.invoke("spectator:setWatchedSeat", seat),
  getBvbTelemetryDirs: () => ipcRenderer.invoke("spectator:getBvbTelemetryDirs"),
  pickBvbTelemetryDir: (seat: number) => ipcRenderer.invoke("spectator:pickBvbTelemetryDir", seat),
  clearBvbTelemetryDir: (seat: number) => ipcRenderer.invoke("spectator:clearBvbTelemetryDir", seat),
  copyText: (text: string) => ipcRenderer.invoke("spectator:copyText", text),
  setActiveSource: (kind: "recording" | "live") => ipcRenderer.invoke("spectator:setActiveSource", kind),

  onSessionState: (listener: (state: SessionStatusIpc) => void) => subscribe("spectator:sessionState", listener),
  onLiveFrame: (listener: (frame: FrameAtLoopIpc) => void) => subscribe("spectator:liveFrame", listener),
  onLiveTerrain: (listener: (payload: LiveTerrainIpc) => void) => subscribe("spectator:liveTerrain", listener),
  onDockerLog: (listener: (line: DockerLogIpc) => void) => subscribe("spectator:dockerLog", listener),
};

contextBridge.exposeInMainWorld("spectator", api);
