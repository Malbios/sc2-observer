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
}

declare global {
  interface Window {
    spectator: SpectatorApi;
  }
}
