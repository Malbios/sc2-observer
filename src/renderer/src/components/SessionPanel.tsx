import { useState, type JSX } from "react";
import type {
  DockerLogIpc,
  DockerStateIpc,
  SeatStatusIpc,
  SessionPhase,
  SessionStatusIpc,
  StartSessionOptionsIpc,
} from "../../../shared/ipc-types";
import { AI_BUILDS, AI_DIFFICULTIES, AI_RACES, DEFAULT_AI, MAX_AIS, type AiOpponent } from "../../../shared/ai-options";

type Mode = "A" | "B" | "BvB";

interface Props {
  status: SessionStatusIpc | null;
  docker: DockerStateIpc | null;
  maps: string[];
  logs: DockerLogIpc[];
  onStart(options: StartSessionOptionsIpc): void;
  onStop(): void;
  /** A game between two bots: each player's telemetry folder, by seat. */
  bvbTelemetryDirs: Record<number, string>;
  onPickBvbTelemetryDir(seat: number): void;
  onClearBvbTelemetryDir(seat: number): void;
  /** Whose view to show and record, while a game between two bots runs. */
  onWatchSeat(seat: number): void;
  /** Laid out for the header rather than the splash: no heading, no help. */
  compact?: boolean;
}

/** What a bot is started with to join its seat, the way AI Arena passes it. */
function joinLine(seat: SeatStatusIpc): string {
  return `--LadderServer ${seat.ladderServer} --GamePort ${seat.gamePort} --StartPort ${seat.startPort}`;
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
      return status.seats ? "waiting for both bots" : "waiting for the bot";
    case "inGame":
      return `in game ${status.gamesPlayed + 1}`;
    case "ended":
      if (status.seats) {
        return status.seats.some((seat) => seat.botConnected) ? "game over, waiting for both bots to disconnect" : "game over";
      }
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

export function SessionPanel({
  status,
  docker,
  maps,
  logs,
  onStart,
  onStop,
  bvbTelemetryDirs,
  onPickBvbTelemetryDir,
  onClearBvbTelemetryDir,
  onWatchSeat,
  compact = false,
}: Props): JSX.Element {
  const [mode, setMode] = useState<Mode>("A");
  const [map, setMap] = useState<string>("");
  const [watchSeat, setWatchSeat] = useState(1);
  /** Mode A's opponents, kept while the app runs so the next start offers
   * the same line-up. */
  const [ais, setAis] = useState<AiOpponent[]>([DEFAULT_AI]);
  const [showLogs, setShowLogs] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);

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
          <select value={mode} onChange={(e) => setMode(e.target.value as Mode)} title="Who creates the game (§1)">
            <option value="A">Mode A: app creates the game</option>
            <option value="B">Mode B: bot creates the game</option>
            <option value="BvB">Bot vs Bot: two bots join ladder-style</option>
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

      {!running && mode === "BvB" && (
        <select value={watchSeat} onChange={(e) => setWatchSeat(Number(e.target.value))} title="Whose view to show and record">
          <option value={1}>Watch: Player 1</option>
          <option value={2}>Watch: Player 2</option>
        </select>
      )}

      {running ? (
        <button onClick={onStop}>Stop Session</button>
      ) : (
        <button
          onClick={() =>
            onStart(
              mode === "BvB"
                ? { map: selectedMap, mode, watchSeat, telemetryDirs: bvbTelemetryDirs }
                : mode === "A"
                  ? { map: selectedMap, mode, opponents: ais }
                  : { map: selectedMap, mode }
            )
          }
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

  // Before a Mode A session: the built-in AIs, one to three. More than one
  // needs a map with that many more start locations; the session warns if
  // the map drops some, because SC2 itself says nothing.
  const setAi = (index: number, change: Partial<AiOpponent>): void =>
    setAis((current) => current.map((ai, i) => (i === index ? { ...ai, ...change } : ai)));
  const aiRows = !running && mode === "A" && (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#8b93a1" }}>
      {ais.map((ai, index) => (
        <span key={index} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ minWidth: 34 }}>AI {index + 1}</span>
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
            <button style={{ fontSize: 11 }} onClick={() => setAis((current) => current.filter((_, i) => i !== index))} title="Remove this AI">
              Remove
            </button>
          )}
        </span>
      ))}
      {ais.length < MAX_AIS && (
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button style={{ fontSize: 11 }} onClick={() => setAis((current) => [...current, DEFAULT_AI])}>
            Add AI
          </button>
          {ais.length >= 1 && <span>more than one AI needs a map with more start locations, such as Flat64</span>}
        </span>
      )}
    </div>
  );

  // Before a game between two bots: where each bot writes its telemetry. A
  // player with no folder simply has no live telemetry, which is the normal
  // case for someone else's bot.
  const seatFolders = !running && mode === "BvB" && (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 12, color: "#8b93a1" }}>
      {[1, 2].map((seat) => (
        <span key={seat} style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          Player {seat} telemetry:
          <span
            title={bvbTelemetryDirs[seat] ?? undefined}
            style={{ color: "#e7e9ec", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {bvbTelemetryDirs[seat] ?? (seat === 1 ? "the usual folder" : "none")}
          </span>
          <button style={{ fontSize: 11 }} onClick={() => onPickBvbTelemetryDir(seat)}>
            Choose...
          </button>
          {bvbTelemetryDirs[seat] && (
            <button style={{ fontSize: 11 }} onClick={() => onClearBvbTelemetryDir(seat)} title="Forget this folder">
              Clear
            </button>
          )}
        </span>
      ))}
    </div>
  );

  // While a game between two bots runs: what each bot is started with, and
  // whether it has arrived. The watched player can change; a game file holds
  // one bot's view, so mid-game the change waits for the next game.
  const seats = running && status?.seats && (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
      {status.seats.map((seat) => (
        <div key={seat.seat} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {DOT(seat.botConnected ? "#98c379" : "#d19a66")}
          <span style={{ color: "#e7e9ec", minWidth: 58 }}>Player {seat.seat}</span>
          <span style={{ color: "#8b93a1", minWidth: 90 }}>{seat.botConnected ? seat.name ?? "connected" : "waiting"}</span>
          <code style={{ color: "#e7e9ec", background: "#12151a", padding: "1px 6px", borderRadius: 3 }}>{joinLine(seat)}</code>
          <button
            style={{ fontSize: 11 }}
            onClick={() => {
              void window.spectator.copyText(joinLine(seat));
              setCopied(seat.seat);
            }}
          >
            {copied === seat.seat ? "Copied" : "Copy"}
          </button>
        </div>
      ))}
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#8b93a1" }}>
        <select value={status.nextWatchSeat ?? status.watchSeat ?? 1} onChange={(e) => onWatchSeat(Number(e.target.value))}>
          <option value={1}>Watch: Player 1</option>
          <option value={2}>Watch: Player 2</option>
        </select>
        {status.nextWatchSeat !== null && <span>from the next game</span>}
      </div>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      {!compact && <div style={{ fontSize: 13 }}>Live session</div>}
      {controls}
      {aiRows}
      {seatFolders}
      {seats}
      {running && status?.warning && <div style={{ fontSize: 12, color: "#d19a66" }}>{status.warning}</div>}
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
