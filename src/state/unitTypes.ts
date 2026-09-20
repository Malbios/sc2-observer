import type { Response } from "../protocol/schema";

export type UnitCategory = "unit" | "building" | "mineral" | "gas";

export interface UnitTypeInfo {
  name: string;
  category: UnitCategory;
}

const STRUCTURE_ATTRIBUTE = 8; // data.proto Attribute.Structure

function categorize(unit: any): UnitCategory {
  if (unit.has_minerals) return "mineral";
  if (unit.has_vespene) return "gas";
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
