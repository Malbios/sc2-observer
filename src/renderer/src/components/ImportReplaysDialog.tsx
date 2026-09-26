import { useMemo, useState, type CSSProperties, type JSX } from "react";
import type { ReplayDescriptionIpc, ReplayImportIpc } from "../../../shared/ipc-types";

interface Props {
  replays: ReplayDescriptionIpc[];
  onImport(imports: ReplayImportIpc[]): void;
  onCancel(): void;
}

type Mode = "same" | "each";

const OBSERVER = 0;
const LOOPS_PER_SECOND = 22.4;
const MAX_NAMES_PER_SLOT = 3;

function viewsOf(replay: ReplayDescriptionIpc): number[] {
  return [OBSERVER, ...replay.players.map((player) => player.playerId)];
}

function formatLength(loops: number): string {
  const seconds = Math.round(loops / LOOPS_PER_SECOND);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function toggled(views: ReadonlySet<number>, view: number, on: boolean): Set<number> {
  const next = new Set(views);
  if (on) next.add(view);
  else next.delete(view);
  return next;
}

function namesInSlot(replays: ReplayDescriptionIpc[], playerId: number): string {
  const names = [...new Set(replays.flatMap((replay) => replay.players.filter((p) => p.playerId === playerId).map((p) => p.name)))];
  const shown = names.slice(0, MAX_NAMES_PER_SLOT).join(", ");
  return names.length > MAX_NAMES_PER_SLOT ? `${shown} +${names.length - MAX_NAMES_PER_SLOT} more` : shown;
}

const MUTED: CSSProperties = { color: "#8b93a1" };
const CHECK: CSSProperties = { display: "flex", alignItems: "center", gap: 6, cursor: "pointer" };

function ViewCheckbox(props: { label: string; hint?: string; checked: boolean; onChange(on: boolean): void }): JSX.Element {
  return (
    <label style={CHECK}>
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
      <span>{props.label}</span>
      {props.hint && <span style={{ ...MUTED, fontSize: 12 }}>{props.hint}</span>}
    </label>
  );
}

function ReplayViews(props: {
  replay: ReplayDescriptionIpc;
  chosen: ReadonlySet<number>;
  onChange(views: Set<number>): void;
}): JSX.Element {
  const { replay, chosen } = props;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div>
        <span style={{ color: "#e7e9ec" }}>{replay.fileName}</span>
        <span style={{ ...MUTED, fontSize: 12 }}>
          {"  "}
          {replay.mapName}, {formatLength(replay.durationLoops)}
        </span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", paddingLeft: 8 }}>
        <ViewCheckbox
          label="Everything (observer)"
          checked={chosen.has(OBSERVER)}
          onChange={(on) => props.onChange(toggled(chosen, OBSERVER, on))}
        />
        {replay.players.map((player) => (
          <ViewCheckbox
            key={player.playerId}
            label={`${player.name} (${player.race})`}
            checked={chosen.has(player.playerId)}
            onChange={(on) => props.onChange(toggled(chosen, player.playerId, on))}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Which views of each replay to convert, before it is queued. Every view
 * costs a full pass through the replay, so a view nobody will look at is
 * worth leaving out. All are ticked to begin with.
 */
export function ImportReplaysDialog({ replays, onImport, onCancel }: Props): JSX.Element {
  const importable = useMemo(() => replays.filter((replay) => replay.problem === null), [replays]);
  const refused = replays.filter((replay) => replay.problem !== null);
  const largestGame = Math.max(0, ...importable.map((replay) => replay.players.length));

  const [mode, setMode] = useState<Mode>("same");
  const [sameViews, setSameViews] = useState<Set<number>>(
    () => new Set([OBSERVER, ...Array.from({ length: largestGame }, (_, index) => index + 1)])
  );
  const [eachViews, setEachViews] = useState<Map<string, Set<number>>>(
    () => new Map(importable.map((replay) => [replay.filePath, new Set(viewsOf(replay))]))
  );

  const choosingPerFile = importable.length === 1 || mode === "each";
  const imports: ReplayImportIpc[] = importable.map((replay) => {
    const chosen = choosingPerFile ? eachViews.get(replay.filePath) ?? new Set<number>() : sameViews;
    return { filePath: replay.filePath, viewpoints: viewsOf(replay).filter((view) => chosen.has(view)) };
  });
  const withoutViews = imports.filter((entry) => entry.viewpoints!.length === 0).length;
  const totalViews = imports.reduce((sum, entry) => sum + entry.viewpoints!.length, 0);
  const canImport = importable.length > 0 && withoutViews === 0;

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
          minWidth: 460,
          maxWidth: 720,
          maxHeight: "90%",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 14,
          fontSize: 13,
        }}
      >
        <div style={{ fontSize: 14 }}>{replays.length === 1 ? "Import Replay" : `Import ${replays.length} Replays`}</div>

        {importable.length > 1 && (
          <div style={{ display: "flex", gap: 16 }}>
            <label style={CHECK}>
              <input type="radio" checked={mode === "same"} onChange={() => setMode("same")} />
              Same views for all files
            </label>
            <label style={CHECK}>
              <input type="radio" checked={mode === "each"} onChange={() => setMode("each")} />
              Choose for each file
            </label>
          </div>
        )}

        {choosingPerFile ? (
          importable.map((replay) => (
            <ReplayViews
              key={replay.filePath}
              replay={replay}
              chosen={eachViews.get(replay.filePath) ?? new Set()}
              onChange={(views) => setEachViews((current) => new Map(current).set(replay.filePath, views))}
            />
          ))
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <ViewCheckbox
              label="Everything (observer)"
              checked={sameViews.has(OBSERVER)}
              onChange={(on) => setSameViews((current) => toggled(current, OBSERVER, on))}
            />
            {Array.from({ length: largestGame }, (_, index) => index + 1).map((playerId) => (
              <ViewCheckbox
                key={playerId}
                label={`Player ${playerId}`}
                hint={namesInSlot(importable, playerId)}
                checked={sameViews.has(playerId)}
                onChange={(on) => setSameViews((current) => toggled(current, playerId, on))}
              />
            ))}
            <div style={{ ...MUTED, fontSize: 12 }}>
              {importable.map((replay) => replay.fileName).join(", ")}
            </div>
          </div>
        )}

        {refused.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
            {refused.map((replay) => (
              <div key={replay.filePath}>
                <span style={{ color: "#e7e9ec" }}>{replay.fileName}</span>
                <span style={{ color: "#e06c75" }}> is skipped: {replay.problem}</span>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ ...MUTED, fontSize: 12 }}>
            {withoutViews > 0
              ? `${withoutViews} file${withoutViews === 1 ? " has" : "s have"} no view chosen`
              : `${totalViews} view${totalViews === 1 ? "" : "s"} to convert, one pass each`}
          </span>
          <span style={{ marginLeft: "auto" }} />
          <button onClick={onCancel}>Cancel</button>
          <button onClick={() => onImport(imports)} disabled={!canImport} autoFocus>
            Import
          </button>
        </div>
      </div>
    </div>
  );
}
