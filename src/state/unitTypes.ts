import type { Response } from "../protocol/schema";

export type UnitCategory = "unit" | "building" | "mineral" | "gas";

export interface UnitTypeInfo {
  name: string;
  category: UnitCategory;
}

const STRUCTURE_ATTRIBUTE = 8; // data.proto Attribute.Structure
const NO_RACE = 0;

/** Gas buildings carry vespene too; only a race-less type is a resource. */
function isResource(unit: any): boolean {
  return (unit.race ?? NO_RACE) === NO_RACE;
}

/** Short-lived effects that SC2 marks as structures. */
const EFFECTS_MARKED_AS_STRUCTURES = new Set(["KD8Charge"]);

function categorize(unit: any): UnitCategory {
  if (unit.has_minerals && isResource(unit)) return "mineral";
  if (unit.has_vespene && isResource(unit)) return "gas";
  if (EFFECTS_MARKED_AS_STRUCTURES.has(unit.name)) return "unit";
  if ((unit.attributes ?? []).includes(STRUCTURE_ATTRIBUTE)) return "building";
  return "unit";
}

/** unit_id (data.proto UnitTypeData) is the same id space as unit_type
 * (raw.proto Unit) -- see the plan's Phase 2 notes. */
export function extractUnitTypeInfo(dataResponse: Response): Record<number, UnitTypeInfo> {
  const units = dataResponse?.data?.units ?? [];
  const info: Record<number, UnitTypeInfo> = {};
  for (const unit of units) {
    if (typeof unit.unit_id === "number" && typeof unit.name === "string") {
      info[unit.unit_id] = { name: unit.name, category: categorize(unit) };
    }
  }
  return info;
}
