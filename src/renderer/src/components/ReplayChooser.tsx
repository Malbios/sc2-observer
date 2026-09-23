import { useState, type JSX } from "react";
import type { InspectReplayResultIpc } from "../../../shared/ipc-types";

/**
 * What a replay says about itself, and the one choice worth making before
 * playing it: whose eyes to watch through.
 *
 * That choice is not cosmetic. Watching from the observer slot records the
 * whole map, both players and every neutral unit; watching as a player
 * records exactly what that player could see, which is the view a bot author
 * usually wants when asking "why did it do that?". The recording is made once
 * and scrubbed forever after, so the choice has to be made here rather than
 * in the viewer.
 */

const OBSERVER_SLOT = 0;
const LOOPS_PER_SECOND = 22.4;

interface Props {
  inspection: InspectReplayResultIpc;
  onPlay(observedPlayerId: number, subjectPlayerId: number): void;
  onCancel(): void;
}

function duration(loops: number): string {
  const seconds = Math.round(loops / LOOPS_PER_SECOND);
  return `${loops.toLocaleString()} loops (${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")})`;
}

export function ReplayChooser({ inspection, onPlay, onCancel }: Props): JSX.Element {
  const [observed, setObserved] = useState(OBSERVER_SLOT);
  const info = inspection.info;

  const participants = info?.players.filter((player) => player.type === "Participant") ?? [];
  // Whose result the game file calls its own: the player being watched when
  // that is a player, otherwise the first participant, which for a ladder
  // replay is the bot whose match this was.
  const subject = observed !== OBSERVER_SLOT ? observed : participants[0]?.playerId ?? 1;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "rgba(10, 12, 15, 0.72)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 10,
      }}
      onClick={onCancel}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          background: "#181c22",
          border: "1px solid #2b323d",
          borderRadius: 6,
          padding: 20,
          minWidth: 420,
          maxWidth: 560,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          fontSize: 13,
        }}
      >
        <div style={{ fontSize: 14 }}>{inspection.fileName}</div>

        {!info ? (
          <div style={{ color: "#e06c75", lineHeight: 1.5 }}>{inspection.problem ?? "That replay could not be read."}</div>
        ) : (
          <>
            <div style={{ color: "#8b93a1", lineHeight: 1.6 }}>
              <div>
                {info.mapName} ({info.localMapPath})
              </div>
              <div>{duration(info.durationLoops)}</div>
              <div title="A replay only loads on the build it was recorded on">SC2 {info.gameVersion}</div>
            </div>

            <table style={{ width: "100%", borderCollapse: "collapse", color: "#8b93a1" }}>
              <tbody>
                {info.players.map((player) => (
                  <tr key={player.playerId}>
                    <td style={{ padding: "2px 6px 2px 0", color: "#e7e9ec" }}>{player.name || `Player ${player.playerId}`}</td>
                    <td style={{ padding: "2px 6px" }}>{player.race}</td>
                    <td style={{ padding: "2px 6px" }}>{player.type}</td>
                    <td style={{ padding: "2px 0", textAlign: "right" }}>{player.result ?? "no result"}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: "#8b93a1" }}>Watch as</span>
              <select value={observed} onChange={(event) => setObserved(Number(event.target.value))} style={{ flex: 1 }}>
                <option value={OBSERVER_SLOT}>Everything (both sides and the whole map)</option>
                {info.players.map((player) => (
                  <option key={player.playerId} value={player.playerId}>
                    {player.name || `Player ${player.playerId}`}: only what they could see
                  </option>
                ))}
              </select>
            </label>

            <div style={{ color: "#8b93a1", fontSize: 12, lineHeight: 1.5 }}>
              The replay is played once and recorded as a game, which is then scrubbed like any other. Converting it
              takes about a second per 1,000 loops.
            </div>
          </>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onCancel}>Cancel</button>
          {info && (
            <button onClick={() => onPlay(observed, subject)} autoFocus>
              Play
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
