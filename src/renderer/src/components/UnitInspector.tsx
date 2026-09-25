import type { JSX } from "react";
import type { PlayerIpc, UnitSummaryIpc, UnitTypeInfoIpc } from "../../../shared/ipc-types";
import type { EntityStateIpc } from "../../../shared/telemetry-types";
import { colorForCategory, colorForChannel, colorForOwner, cssColor, NEUTRAL_OWNER } from "../colors";
import { HALLUCINATION_BADGE_URL } from "../icons";

interface Props {
  unit: UnitSummaryIpc | null;
  unitTypeInfo: Record<number, UnitTypeInfoIpc>;
  /** The game's players, to name the owner by. */
  players: PlayerIpc[];
  /** Entity channels at the current loop; whatever the bot attached to this
   * unit's tag shows up here (§3.6). */
  entities: EntityStateIpc[];
}

/**
 * Who owns a unit, in words: "Creepy_macro (player 2, Zerg)" or
 * "Computer (player 2, Easy Terran)". An id the game's player list does not
 * have keeps the number, which is all there is to say about it.
 */
function ownerText(owner: number, players: PlayerIpc[]): string {
  if (owner === NEUTRAL_OWNER) return "neutral";
  const player = players.find((entry) => entry.playerId === owner);
  if (!player) return String(owner);
  const detail = [player.difficulty, player.race].filter((part) => part).join(" ");
  return `${player.label} (player ${owner}${detail ? `, ${detail}` : ""})`;
}

/** Everything a bot said about one tag, across every entity channel. */
function entityRowsFor(entities: EntityStateIpc[], tag: number): { ch: string; fields: [string, unknown][] }[] {
  const rows: { ch: string; fields: [string, unknown][] }[] = [];
  for (const entity of entities) {
    const data = entity.byTag[tag];
    if (!data) continue;
    // `tag` itself is the join key, not information about the unit.
    const fields = Object.entries(data).filter(([key]) => key !== "tag");
    if (fields.length > 0) rows.push({ ch: entity.ch, fields });
  }
  return rows;
}

export function UnitInspector({ unit, unitTypeInfo, players, entities }: Props): JSX.Element {
  if (!unit) {
    return <div style={{ color: "#8b93a1", fontSize: 13 }}>Click a unit to inspect it.</div>;
  }

  const info = unitTypeInfo[unit.unitType];
  const name = info?.name ?? `Unit type ${unit.unitType}`;
  const entityRows = entityRowsFor(entities, unit.tag);

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
      {/* Only ever true when this recording's viewpoint knows it; the
          opponent's view of the same unit reports false (see frames.ts). */}
      {unit.isHallucination && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#6cc4ff" }}>
          <img src={HALLUCINATION_BADGE_URL} alt="" width={18} height={18} />
          Hallucination
        </div>
      )}
      <div style={{ color: "#8b93a1", fontFamily: "monospace", fontSize: 12 }}>
        {info?.category ?? "unknown"}
        <br />
        tag {unit.tag}
        <br />
        owner {ownerText(unit.owner, players)}
        <br />
        {unit.healthMax > 0 && (
          <>
            health {Math.round(unit.health)} / {Math.round(unit.healthMax)}
            <br />
          </>
        )}
        {unit.shieldMax > 0 && (
          <>
            shields {Math.round(unit.shield)} / {Math.round(unit.shieldMax)}
            <br />
          </>
        )}
        {unit.pos ? `pos ${unit.pos.x.toFixed(1)}, ${unit.pos.y.toFixed(1)}, ${unit.pos.z.toFixed(1)}` : "no position"}
      </div>

      {entityRows.map((row) => (
        <div key={row.ch} style={{ borderTop: "1px solid #2b323d", paddingTop: 6 }}>
          <div style={{ fontSize: 11, color: cssColor(colorForChannel(row.ch)), marginBottom: 3 }}>{row.ch}</div>
          <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: "#e7e9ec" }}>
            {row.fields.map(([key, value]) => (
              <div key={key} style={{ display: "flex", gap: 6 }}>
                <span style={{ color: "#8b93a1" }}>{key}</span>
                <span style={{ marginLeft: "auto", textAlign: "right", wordBreak: "break-word" }}>
                  {typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
