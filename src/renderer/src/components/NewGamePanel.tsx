import { useState, type CSSProperties, type JSX } from "react";
import type { DockerLogIpc, DockerStateIpc, StartSessionOptionsIpc } from "../../../shared/ipc-types";
import { AI_BUILDS, AI_DIFFICULTIES, AI_RACES, DEFAULT_AI, MAX_AIS, type AiOpponent } from "../../../shared/ai-options";
import { LogBox } from "./SessionStatus";

export type NewGameMode = "A" | "B" | "BvB";

/** What the form was last set to. Kept by the app rather than the form, so
 * the next game offers the same line-up. */
export interface NewGameChoices {
  mode: NewGameMode;
  map: string;
  watchSeat: number;
  ais: AiOpponent[];
}

export const DEFAULT_CHOICES: NewGameChoices = { mode: "A", map: "", watchSeat: 1, ais: [DEFAULT_AI] };

interface Props {
  choices: NewGameChoices;
  onChange(choices: NewGameChoices): void;
  docker: DockerStateIpc | null;
  maps: string[];
  logs: DockerLogIpc[];
  /** A game between two bots: each player's telemetry folder, by seat. */
  bvbTelemetryDirs: Record<number, string>;
  onPickBvbTelemetryDir(seat: number): void;
  onClearBvbTelemetryDir(seat: number): void;
  onStart(options: StartSessionOptionsIpc): void;
  onCancel(): void;
}

/**
 * How the bot gets into each kind of game. The app never starts a bot (the
 * user does), so this is the one place that says where it has to connect.
 */
const BOT_HINT: Record<NewGameMode, string> = {
  A: "The app creates the game. Once it says it is waiting for the bot, start your bot: it joins at ws://127.0.0.1:5000/sc2api.",
  B: "Start your bot once the client is ready: it connects to ws://127.0.0.1:5000/sc2api and creates the game itself.",
  BvB:
    "Once the game is waiting, start each bot ladder-style with the --LadderServer, --GamePort and --StartPort shown for its player.",
};

const LABEL: CSSProperties = { color: "#8b93a1", width: 80, flexShrink: 0, paddingTop: 3 };
const ROW: CSSProperties = { display: "flex", alignItems: "flex-start", gap: 8 };

/**
 * Starting a game: which kind, on which map, against what. It opens from the
 * Games screen only; a game being watched is left first, rather than replaced
 * from its own header.
 */
export function NewGamePanel({
  choices,
  onChange,
  docker,
  maps,
  logs,
  bvbTelemetryDirs,
  onPickBvbTelemetryDir,
  onClearBvbTelemetryDir,
  onStart,
  onCancel,
}: Props): JSX.Element {
  const [showLogs, setShowLogs] = useState(false);
  const { mode, watchSeat, ais } = choices;
  const selectedMap = choices.map || maps[0] || "";
  const dockerBad = docker !== null && !docker.available;
  const set = (change: Partial<NewGameChoices>): void => onChange({ ...choices, ...change });
  const setAi = (index: number, change: Partial<AiOpponent>): void =>
    set({ ais: ais.map((ai, i) => (i === index ? { ...ai, ...change } : ai)) });

  const start = (): void =>
    onStart(
      mode === "BvB"
        ? { map: selectedMap, mode, watchSeat, telemetryDirs: bvbTelemetryDirs }
        : mode === "A"
          ? { map: selectedMap, mode, opponents: ais }
          : { map: selectedMap, mode }
    );

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
          maxWidth: 640,
          maxHeight: "90%",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          fontSize: 13,
        }}
      >
        <div style={{ fontSize: 14 }}>New Game</div>

        <div style={ROW}>
          <span style={LABEL}>Game</span>
          <select value={mode} onChange={(e) => set({ mode: e.target.value as NewGameMode })} style={{ flex: 1 }}>
            <option value="A">Your bot vs built-in AIs</option>
            <option value="B">Your bot creates the game</option>
            <option value="BvB">Bot vs Bot</option>
          </select>
        </div>

        <div style={ROW}>
          <span style={LABEL}>Map</span>
          <select value={selectedMap} onChange={(e) => set({ map: e.target.value })} disabled={maps.length === 0} style={{ flex: 1 }}>
            {maps.length === 0 ? <option value="">no maps found</option> : null}
            {maps.map((name) => (
              <option key={name} value={name}>
                {name.replace(/\.SC2Map$/i, "")}
              </option>
            ))}
          </select>
        </div>

        {/* The built-in AIs, one to three. More than one needs a map with that
            many more start locations; the session warns if the map drops
            some, because SC2 itself says nothing. */}
        {mode === "A" && (
          <div style={ROW}>
            <span style={LABEL}>Opponents</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
              {ais.map((ai, index) => (
                <span key={index} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <select value={ai.race} onChange={(e) => setAi(index, { race: Number(e.target.value) })} title="Race">
                    {AI_RACES.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <select value={ai.difficulty} onChange={(e) => setAi(index, { difficulty: Number(e.target.value) })} title="Difficulty">
                    {AI_DIFFICULTIES.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <select value={ai.build} onChange={(e) => setAi(index, { build: Number(e.target.value) })} title="Build">
                    {AI_BUILDS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  {ais.length > 1 && (
                    <button style={{ fontSize: 11 }} onClick={() => set({ ais: ais.filter((_, i) => i !== index) })} title="Remove this AI">
                      Remove
                    </button>
                  )}
                </span>
              ))}
              {ais.length < MAX_AIS && (
                <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#8b93a1" }}>
                  <button style={{ fontSize: 11 }} onClick={() => set({ ais: [...ais, DEFAULT_AI] })}>
                    Add AI
                  </button>
                  more than one AI needs a map with more start locations, such as Flat64
                </span>
              )}
            </div>
          </div>
        )}

        {/* A game between two bots: whose view to record, and where each bot
            writes its telemetry. A player with no folder simply has no live
            telemetry, which is the normal case for someone else's bot. */}
        {mode === "BvB" && (
          <>
            <div style={ROW}>
              <span style={LABEL}>Watch</span>
              <select value={watchSeat} onChange={(e) => set({ watchSeat: Number(e.target.value) })} title="Whose view to show and record">
                <option value={1}>Player 1</option>
                <option value={2}>Player 2</option>
              </select>
            </div>
            <div style={ROW}>
              <span style={LABEL}>Telemetry</span>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 0, fontSize: 12 }}>
                {[1, 2].map((seat) => (
                  <span key={seat} style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                    <span style={{ color: "#8b93a1", flexShrink: 0 }}>Player {seat}:</span>
                    <span
                      title={bvbTelemetryDirs[seat] ?? undefined}
                      style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}
                    >
                      {bvbTelemetryDirs[seat] ?? (seat === 1 ? "the usual folder" : "none")}
                    </span>
                    <button style={{ fontSize: 11, flexShrink: 0 }} onClick={() => onPickBvbTelemetryDir(seat)}>
                      Choose...
                    </button>
                    {bvbTelemetryDirs[seat] && (
                      <button style={{ fontSize: 11, flexShrink: 0 }} onClick={() => onClearBvbTelemetryDir(seat)} title="Forget this folder">
                        Clear
                      </button>
                    )}
                  </span>
                ))}
              </div>
            </div>
          </>
        )}

        <div style={{ color: "#8b93a1", fontSize: 12, lineHeight: 1.5 }}>{BOT_HINT[mode]}</div>

        {docker && (
          <div style={{ fontSize: 12, color: dockerBad ? "#e06c75" : "#8b93a1", lineHeight: 1.5 }}>
            {docker.available
              ? `Docker ${docker.version}, image ${docker.imageExists ? "built" : "not built yet (the first start builds it, which takes a while)"}.`
              : docker.reason ?? "Docker is not available."}
          </div>
        )}

        {showLogs && <LogBox logs={logs} />}

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={() => setShowLogs((v) => !v)} style={{ color: "#8b93a1" }}>
            {showLogs ? "Hide Log" : "Log"}
          </button>
          <span style={{ marginLeft: "auto" }} />
          <button onClick={onCancel}>Cancel</button>
          <button onClick={start} disabled={selectedMap === "" || dockerBad} autoFocus>
            Start Game
          </button>
        </div>
      </div>
    </div>
  );
}
