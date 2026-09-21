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
 *
 * Two things this must not do, both found by looking at a real map
 * (TorchesAIE, measured cell by cell rather than by eye):
 *
 * - **It only ever clears cells a unit actually stands on.** The footprint
 *   is the disc of the unit's own collision radius, tested against each
 *   cell's centre. A bounding square of `ceil(radius)` erased 357 cells of
 *   genuine cliff on that map against 99 real footprint cells, because a
 *   6x6 destructible with radius 3.19 clears a 9x9 square: the excess ate
 *   the cliff beside it and rendered it as open ground.
 * - **It never touches placementGrid.** That grid describes the terrain, not
 *   what is standing on it: under a townhall and under mineral patches it
 *   already reads "buildable", so clearing it buys nothing. What it costs is
 *   real: forcing it to 1 turns ramp and cliff cells under a destructible
 *   into bright buildable ground, which is the map growing flat space that
 *   does not exist.
 */
export function clearInitialUnitFootprints(terrain: TerrainData, initialUnits: UnitSummary[]): void {
  const { width, height, pathingGrid } = terrain;
  for (const unit of initialUnits) {
    if (!unit.pos || unit.radius <= 0) continue;
    const { x, y } = unit.pos;
    const r = unit.radius;
    const minX = Math.max(0, Math.floor(x - r));
    const maxX = Math.min(width - 1, Math.ceil(x + r));
    const minY = Math.max(0, Math.floor(y - r));
    const maxY = Math.min(height - 1, Math.ceil(y + r));
    for (let gy = minY; gy <= maxY; gy++) {
      for (let gx = minX; gx <= maxX; gx++) {
        const dx = gx + 0.5 - x;
        const dy = gy + 0.5 - y;
        if (dx * dx + dy * dy > r * r) continue;
        pathingGrid[gy * width + gx] = 1;
      }
    }
  }
}
