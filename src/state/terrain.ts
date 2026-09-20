import type { Response } from "../protocol/schema";
import type { UnitSummary } from "./frames";

export interface TerrainData {
  width: number;
  height: number;
  /** Row-major, row 0 = world y=0 (bottom). 1 = pathable. */
  pathingGrid: Uint8Array;
  /** Row-major, row 0 = world y=0 (bottom). 1 = can place a building. */
  placementGrid: Uint8Array;
  /** Row-major, row 0 = world y=0 (bottom). Raw 0-255, relative elevation only. */
  terrainHeight: Uint8Array;
  playableArea: { x0: number; y0: number; x1: number; y1: number };
  startLocations: { x: number; y: number }[];
}

/**
 * MSB-first bit unpacking with no per-row padding, matching numpy's
 * `unpackbits` over the raw buffer -- verified against a known-working
 * reference (C:\dev\sc2-ai\venv\Lib\site-packages\sc2\pixel_map.py, part of
 * the burnysc2/python-sc2 package), not guessed.
 */
function unpackBits(bytes: Uint8Array, totalBits: number): Uint8Array {
  const out = new Uint8Array(totalBits);
  for (let i = 0; i < totalBits; i++) {
    const byte = bytes[i >> 3] ?? 0;
    const bit = 7 - (i & 7);
    out[i] = (byte >> bit) & 1;
  }
  return out;
}

export function extractTerrain(gameInfoResponse: Response): TerrainData | null {
  const startRaw = gameInfoResponse?.game_info?.start_raw;
  if (!startRaw) return null;

  const width: number = startRaw.map_size.x;
  const height: number = startRaw.map_size.y;
  const cellCount = width * height;

  const pathingGrid = unpackBits(startRaw.pathing_grid.data, cellCount);
  const placementGrid = unpackBits(startRaw.placement_grid.data, cellCount);
  const terrainHeight = new Uint8Array(startRaw.terrain_height.data as Uint8Array);

  const area = startRaw.playable_area ?? {};
  const playableArea = {
    x0: area.p0?.x ?? 0,
    y0: area.p0?.y ?? 0,
    x1: area.p1?.x ?? width,
    y1: area.p1?.y ?? height,
  };

  const startLocations = (startRaw.start_locations ?? []).map((p: any) => ({ x: p.x, y: p.y }));

  return { width, height, pathingGrid, placementGrid, terrainHeight, playableArea, startLocations };
}

/**
 * pathingGrid/placementGrid are a one-time snapshot taken at game start --
 * raw.proto's MapState (the only per-frame terrain-ish data) carries just
 * visibility/creep, not pathing/placement, so SC2 never updates these
 * mid-game. That snapshot bakes in whatever was already standing at loop 0:
 * mineral fields, vespene geysers, and each player's starting townhall all
 * mark their footprint cells unpathable there, indistinguishably from real
 * permanent geography (cliffs/water). Left alone, the terrain view keeps
 * rendering that footprint as unpathable ground under -- or after the
 * removal of -- any of those, since nothing in the raw data says "this
 * blockage was just a mineral patch, not a cliff". Clearing the footprint
 * of every unit seen in that same starting frame fixes exactly that: real
 * terrain features have no matching unit and are left untouched.
 */
export function clearInitialUnitFootprints(terrain: TerrainData, initialUnits: UnitSummary[]): void {
  const { width, height, pathingGrid, placementGrid } = terrain;
  for (const unit of initialUnits) {
    if (!unit.pos) continue;
    const r = Math.ceil(unit.radius);
    const cx = Math.floor(unit.pos.x);
    const cy = Math.floor(unit.pos.y);
    for (let gy = Math.max(0, cy - r); gy <= Math.min(height - 1, cy + r); gy++) {
      for (let gx = Math.max(0, cx - r); gx <= Math.min(width - 1, cx + r); gx++) {
        const idx = gy * width + gx;
        pathingGrid[idx] = 1;
        placementGrid[idx] = 1;
      }
    }
  }
}
