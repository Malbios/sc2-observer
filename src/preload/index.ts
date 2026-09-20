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
};

contextBridge.exposeInMainWorld("spectator", api);
