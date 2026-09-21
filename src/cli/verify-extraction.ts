/**
 * Regression check for the pure decode/extraction functions (terrain,
 * units, unit-type categorization) against the committed fixture. Doesn't
 * touch Electron/Pixi/rendering -- those still need a human to look at the
 * window -- but this covers the logic bugs that don't actually require
 * eyes on a screen (e.g. a categorization mismatch), so they don't have to
 * be re-found by manually reading colors off tiny map dots every time.
 *
 * Run with: node dist/cli/verify-extraction.js
 */
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HistoryStore } from "../history/HistoryStore";
import { decodeResponse } from "../protocol/schema";
import { clearInitialUnitFootprints, extractTerrain, type TerrainData } from "../state/terrain";
import { extractUnits } from "../state/frames";
import { extractUnitTypeInfo, type UnitCategory } from "../state/unitTypes";

const FIXTURE = "fixtures/phase1-sample-game.sqlite";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const pass = actual === expected;
  console.log(`${pass ? "ok  " : "FAIL"} ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  if (!pass) failures++;
}

function main(): void {
  // Opening a recording migrates it to the current schema, which is the right
  // behaviour for a real file but would rewrite a 20 MB committed fixture on
  // every run and leave the repo dirty. Verify against a throwaway copy, which
  // also means this exercises the migration path on a genuinely old file every
  // time rather than only once.
  const scratch = mkdtempSync(path.join(tmpdir(), "spectator-verify-"));
  const fixture = path.join(scratch, path.basename(FIXTURE));
  copyFileSync(FIXTURE, fixture);

  try {
    runChecks(fixture);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

function runChecks(fixturePath: string): void {
  const store = new HistoryStore(fixturePath);

  check("fixture migrated to the current schema", store.getMeta("schema_version"), "2");
  check("migration left the frames intact", store.getMaxLoop() > 0, true);
  check("a migrated v1 file has no telemetry", store.getStreams().length, 0);

  const dataBytes = store.readFrameAtOrBefore("data", 0);
  if (!dataBytes) throw new Error("no data frame in fixture");
  const typeInfo = extractUnitTypeInfo(decodeResponse(dataBytes));

  const byName = (name: string) => Object.values(typeInfo).find((t) => t.name === name);
  const expectCategory = (name: string, expected: UnitCategory) => check(`category(${name})`, byName(name)?.category, expected);

  expectCategory("VespeneGeyser", "gas");
  expectCategory("RichMineralField", "mineral");
  expectCategory("Hatchery", "building");
  expectCategory("SpawningPool", "building");
  expectCategory("Zergling", "unit");
  expectCategory("Drone", "unit");

  const observationBytes = store.readFrameAtOrBefore("observation", 100);
  if (!observationBytes) throw new Error("no observation frame in fixture");
  const units = extractUnits(decodeResponse(observationBytes));
  check("units decoded at loop ~100", units.length > 0, true);
  // tag is a uint64 in the wire format (decodes as a Long instance, not a
  // plain number, when the optional `long` package is installed -- as it is
  // here). IPC structured-clone and `===` selection matching both need a
  // real number; this guards against that regressing silently again.
  check("unit.tag is a plain finite number", units.every((u) => typeof u.tag === "number" && Number.isFinite(u.tag)), true);
  check("unit.radius is a plain finite number", units.every((u) => typeof u.radius === "number" && Number.isFinite(u.radius)), true);

  const gameInfoBytes = store.readFrameAtOrBefore("gameInfo", 0);
  if (!gameInfoBytes) throw new Error("no gameInfo frame in fixture");
  const terrain = extractTerrain(decodeResponse(gameInfoBytes));
  check("terrain decoded", terrain !== null, true);
  if (terrain) {
    check("terrain cell count matches grid length", terrain.pathingGrid.length, terrain.width * terrain.height);
    checkFootprintClearing(terrain, store);
  }

  store.close();
}

/**
 * The terrain view's one piece of interpretation, and the only place the app
 * rewrites what SC2 told it, so it is worth pinning precisely. It corrects a
 * start-of-game snapshot that cannot tell a mineral patch apart from a cliff;
 * the failure mode is the correction reaching further than the object it is
 * correcting for, which on screen is a map that has grown open ground it does
 * not have.
 */
function checkFootprintClearing(terrain: TerrainData, store: HistoryStore): void {
  const obsBytes = store.readFrameAtOrBefore("observation", 0);
  if (!obsBytes) throw new Error("no observation frame in fixture");
  const startingUnits = extractUnits(decodeResponse(obsBytes));

  const beforePathing = Uint8Array.from(terrain.pathingGrid);
  const beforePlacement = Uint8Array.from(terrain.placementGrid);
  clearInitialUnitFootprints(terrain, startingUnits);

  let placementChanged = 0;
  let clearedOutsideAFootprint = 0;
  let cleared = 0;
  for (let i = 0; i < beforePathing.length; i++) {
    if (terrain.placementGrid[i] !== beforePlacement[i]) placementChanged++;
    if (terrain.pathingGrid[i] === beforePathing[i]) continue;
    cleared++;
    // Every cleared cell must be one some unit is standing on: its centre
    // inside that unit's own collision radius, not inside a square drawn
    // around it.
    const cx = (i % terrain.width) + 0.5;
    const cy = Math.floor(i / terrain.width) + 0.5;
    const covered = startingUnits.some((unit) => {
      if (!unit.pos) return false;
      const dx = cx - unit.pos.x;
      const dy = cy - unit.pos.y;
      return dx * dx + dy * dy <= unit.radius * unit.radius;
    });
    if (!covered) clearedOutsideAFootprint++;
  }

  check("clearing footprints never opens a cell no unit stands on", clearedOutsideAFootprint, 0);
  check("clearing footprints leaves the placement grid alone", placementChanged, 0);
  // A map with a hundred-odd starting units always has some of them standing
  // on cells the snapshot calls unpathable; zero would mean the correction
  // silently stopped happening.
  check("some footprints were actually cleared", cleared > 0, true);
}

main();
