import { useState, type JSX } from "react";
import type { DockerLogIpc, DockerStateIpc, SessionPhase, SessionStatusIpc, StartSessionOptionsIpc } from "../../../shared/ipc-types";

interface Props {
  status: SessionStatusIpc | null;
  docker: DockerStateIpc | null;
  maps: string[];
  logs: DockerLogIpc[];
  onStart(options: StartSessionOptionsIpc): void;
  onStop(): void;
  /** Laid out for the header rather than the splash: no heading, no help. */
  compact?: boolean;
}

/**
 * The colour says what the session is doing without reading the words: green
 * while a game is being played, amber while something is being waited for,
 * red when it stopped for a reason the user has to fix.
 */
const PHASE_COLOR: Record<SessionPhase, string> = {
  idle: "#8b93a1",
  containerDown: "#d19a66",
  clientReady: "#d19a66",
  gameCreated: "#d19a66",
  inGame: "#98c379",
  ended: "#d19a66",
  stopped: "#8b93a1",
  failed: "#e06c75",
};

/** Phase names are the state machine's; these are what they mean to someone
 * waiting for their bot to connect. */
function phaseLabel(status: SessionStatusIpc): string {
  switch (status.phase) {
    case "idle":
      return "not started";
    case "containerDown":
      return "starting the container";
    case "clientReady":
      return status.mode === "B" ? "waiting for the bot to create a game" : "client ready";
    case "gameCreated":
      return "waiting for the bot";
    case "inGame":
      return `in game ${status.gamesPlayed + 1}`;
    case "ended":
      return status.botConnected ? "game over, waiting for the bot to disconnect" : "game over";
    case "stopped":
      return "stopped";
    case "failed":
      return "failed";
  }
}

/** True while the session owns the client, which is when Start must not be
 * offered again and the map and mode are fixed. */
function isRunning(status: SessionStatusIpc | null): boolean {
  if (!status) return false;
  return status.phase !== "idle" && status.phase !== "stopped" && status.phase !== "failed";
}

const DOT = (color: string): JSX.Element => (
  <span style={{ width: 8, height: 8, borderRadius: 4, background: color, display: "inline-block", flexShrink: 0 }} />
);

export function SessionPanel({ status, docker, maps, logs, onStart, onStop, compact = false }: Props): JSX.Element {
  const [mode, setMode] = useState<"A" | "B">("A");
  const [map, setMap] = useState<string>("");
  const [showLogs, setShowLogs] = useState(false);

  const running = isRunning(status);
  const selectedMap = map || maps[0] || "";
  const dockerBad = docker !== null && !docker.available;

  const controls = (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      {status && (
        <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          {DOT(PHASE_COLOR[status.phase])}
          <span style={{ color: status.phase === "failed" ? "#e06c75" : "#8b93a1" }}>{phaseLabel(status)}</span>
        </span>
      )}

      {!running && (
        <>
          <select value={mode} onChange={(e) => setMode(e.target.value as "A" | "B")} title="Who creates the game (§1)">
            <option value="A">Mode A: app creates the game</option>
            <option value="B">Mode B: bot creates the game</option>
          </select>
          <select
            value={selectedMap}
            onChange={(e) => setMap(e.target.value)}
            disabled={maps.length === 0}
            style={{ maxWidth: 220 }}
          >
            {maps.length === 0 ? <option value="">no maps found</option> : null}
            {maps.map((name) => (
              <option key={name} value={name}>
                {name.replace(/\.SC2Map$/i, "")}
              </option>
            ))}
          </select>
        </>
      )}

      {running ? (
        <button onClick={onStop}>Stop Session</button>
      ) : (
        <button
          onClick={() => onStart({ map: selectedMap, mode })}
          disabled={selectedMap === "" || dockerBad}
          title={dockerBad ? docker?.reason ?? "" : "Bring up the container and wait for your bot"}
        >
          Start Live Session
        </button>
      )}

      <button onClick={() => setShowLogs((v) => !v)} style={{ color: "#8b93a1" }}>
        {showLogs ? "Hide Log" : "Log"}
      </button>
    </div>
  );

  const detail = (
    <div style={{ fontSize: 12, color: "#8b93a1", display: "flex", gap: 12, flexWrap: "wrap" }}>
      {docker && (
        <span title={docker.reason ?? undefined}>
          {docker.available ? `docker ${docker.version}` : "docker unavailable"}
          {docker.available && `, image ${docker.imageExists ? "built" : "not built yet"}, container ${docker.container}`}
        </span>
      )}
      {status?.error && <span style={{ color: "#e06c75" }}>{status.error}</span>}
      {status && running && (
        <span>
          {status.gamesPlayed} game{status.gamesPlayed === 1 ? "" : "s"} recorded
          {status.gameFile ? `, writing ${status.gameFile.split(/[\\/]/).pop()}` : ""}
        </span>
      )}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      {!compact && <div style={{ fontSize: 13 }}>Live session</div>}
      {controls}
      {!compact && detail}
      {showLogs && (
        <div
          style={{
            height: 160,
            overflowY: "auto",
            background: "#12151a",
            border: "1px solid #2b323d",
            borderRadius: 4,
            padding: 8,
            fontFamily: "monospace",
            fontSize: 11,
            color: "#8b93a1",
            // Docker's build output is wide; wrapping it beats a second
            // scrollbar in a 160px box.
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {logs.length === 0 ? "no output yet" : logs.map((line, index) => (
            <div key={index} style={{ color: line.source === "session" ? "#e7e9ec" : undefined }}>
              {line.line}
            </div>
          ))}
        </div>
      )}
      {compact && status?.error && <div style={{ fontSize: 12, color: "#e06c75" }}>{status.error}</div>}
    </div>
  );
}
