import { contextBridge, ipcRenderer } from "electron";
import type { SpectatorApi } from "../shared/ipc-types";

const api: SpectatorApi = {
  pickAndOpenRecording: () => ipcRenderer.invoke("spectator:pickAndOpenRecording"),
  getTerrain: () => ipcRenderer.invoke("spectator:getTerrain"),
  getUnitTypeInfo: () => ipcRenderer.invoke("spectator:getUnitTypeInfo"),
  getFrameAtLoop: (loop: number) => ipcRenderer.invoke("spectator:getFrameAtLoop", loop),
};

contextBridge.exposeInMainWorld("spectator", api);
