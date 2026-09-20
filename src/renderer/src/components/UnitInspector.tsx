import type { JSX } from "react";
import type { UnitSummaryIpc, UnitTypeInfoIpc } from "../../../shared/ipc-types";
import { colorForCategory, colorForOwner, cssColor } from "../colors";

interface Props {
  unit: UnitSummaryIpc | null;
  unitTypeInfo: Record<number, UnitTypeInfoIpc>;
}

export function UnitInspector({ unit, unitTypeInfo }: Props): JSX.Element {
  if (!unit) {
    return <div style={{ color: "#8b93a1", fontSize: 13 }}>Click a unit to inspect it.</div>;
  }

  const info = unitTypeInfo[unit.unitType];
  const name = info?.name ?? `Unit type ${unit.unitType}`;

  return (
    <div style={{ fontSize: 13, display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            display: "inline-block",
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: cssColor(colorForCategory(info?.category)),
            border: `2px solid ${cssColor(colorForOwner(unit.owner))}`,
          }}
        />
        {name}
      </div>
      <div style={{ color: "#8b93a1", fontFamily: "monospace", fontSize: 12 }}>
        {info?.category ?? "unknown"}
        <br />
        tag {unit.tag}
        <br />
        owner {unit.owner}
        <br />
        {unit.pos ? `pos ${unit.pos.x.toFixed(1)}, ${unit.pos.y.toFixed(1)}, ${unit.pos.z.toFixed(1)}` : "no position"}
      </div>
    </div>
  );
}
