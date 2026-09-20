export interface RecordingInfo {
  filePath: string;
  map: string;
  mode: string;
  startedAt: string | undefined;
  endedAt: string | undefined;
  maxLoop: number;
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

export interface SpectatorApi {
  pickAndOpenRecording(): Promise<RecordingInfo | null>;
  getTerrain(): Promise<TerrainDataIpc | null>;
  getUnitTypeInfo(): Promise<Record<number, UnitTypeInfoIpc>>;
  getFrameAtLoop(loop: number): Promise<FrameAtLoopIpc | null>;
}

declare global {
  interface Window {
    spectator: SpectatorApi;
  }
}
