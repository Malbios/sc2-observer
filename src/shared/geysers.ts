/**
 * A vespene geyser with a gas building on it.
 *
 * An Extractor, Refinery or Assimilator is placed on its geyser's exact
 * centre, and SC2 keeps reporting the geyser as a unit of its own the whole
 * time, so a map that draws every unit draws both, one on top of the other.
 * In the game the geyser is not seen while the building stands, from the
 * moment construction starts, and it is back once the building is gone.
 *
 * This is drawing only: the recording keeps every unit SC2 reported. Each
 * frame is judged on its own, so a geyser returns with the first frame that
 * no longer has its building, with nothing to keep track of in between.
 */

/** The same rule the viewer uses to give a unit the geyser icon. */
const GEYSER = /geyser|vespene/i;
const GAS_BUILDING = /^(Extractor|Refinery|Assimilator)(Rich)?$/;
/** A gas building sits on its geyser's centre; anything this close is it. */
const SAME_SPOT = 0.5;

interface Placed {
  unitType: number;
  pos: { x: number; y: number } | null;
}

export function hideCoveredGeysers<T extends Placed>(units: T[], typeName: (unitType: number) => string | undefined): T[] {
  const buildings = units.filter((unit) => unit.pos && GAS_BUILDING.test(typeName(unit.unitType) ?? ""));
  if (buildings.length === 0) return units;
  return units.filter((unit) => {
    if (!unit.pos || !GEYSER.test(typeName(unit.unitType) ?? "")) return true;
    const { x, y } = unit.pos;
    return !buildings.some((building) => Math.abs(building.pos!.x - x) < SAME_SPOT && Math.abs(building.pos!.y - y) < SAME_SPOT);
  });
}
