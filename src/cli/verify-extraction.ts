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
import { HistoryStore } from "../history/HistoryStore";
import { decodeResponse } from "../protocol/schema";
import { extractTerrain } from "../state/terrain";
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
  const store = new HistoryStore(FIXTURE);

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
  }

  store.close();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

main();
