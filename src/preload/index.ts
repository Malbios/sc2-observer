import { contextBridge, ipcRenderer } from "electron";
import type { SpectatorApi } from "../shared/ipc-types";
import type { EventFilterIpc } from "../shared/telemetry-types";

const api: SpectatorApi = {
  pickAndOpenRecording: () => ipcRenderer.invoke("spectator:pickAndOpenRecording"),
  getTerrain: () => ipcRenderer.invoke("spectator:getTerrain"),
  getUnitTypeInfo: () => ipcRenderer.invoke("spectator:getUnitTypeInfo"),
  getFrameAtLoop: (loop: number) => ipcRenderer.invoke("spectator:getFrameAtLoop", loop),

  attachTelemetry: () => ipcRenderer.invoke("spectator:attachTelemetry"),
  getTelemetryStreams: () => ipcRenderer.invoke("spectator:getTelemetryStreams"),
  getChannels: () => ipcRenderer.invoke("spectator:getChannels"),
  getTelemetryAtLoop: (loop: number) => ipcRenderer.invoke("spectator:getTelemetryAtLoop", loop),
  getSeries: (ch: string, name: string) => ipcRenderer.invoke("spectator:getSeries", ch, name),
  getEvents: (filter?: EventFilterIpc) => ipcRenderer.invoke("spectator:getEvents", filter),

  watchTelemetryFolder: () => ipcRenderer.invoke("spectator:watchTelemetryFolder"),
  stopWatchingTelemetry: () => ipcRenderer.invoke("spectator:stopWatchingTelemetry"),
  getTelemetryWatch: () => ipcRenderer.invoke("spectator:getTelemetryWatch"),
  onTelemetryAppended: (listener: () => void) => {
    // The IpcRendererEvent is deliberately not passed through: the renderer
    // gets "re-query", not a channel to main.
    const handler = (): void => listener();
    ipcRenderer.on("spectator:telemetryAppended", handler);
    return () => ipcRenderer.off("spectator:telemetryAppended", handler);
  },
};

contextBridge.exposeInMainWorld("spectator", api);
