import { useState, type JSX } from "react";
import type { DockerLogIpc, SeatStatusIpc, SessionPhase, SessionStatusIpc } from "../../../shared/ipc-types";

interface Props {
  status: SessionStatusIpc;
  logs: DockerLogIpc[];
  onStop(): void;
  /** Whose view to show and record, while a game between two bots runs. */
  onWatchSeat(seat: number): void;
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

/** True while the session owns the client. */
function isRunning(status: SessionStatusIpc): boolean {
  return status.phase !== "idle" && status.phase !== "stopped" && status.phase !== "failed";
}

const DOT = (color: string): JSX.Element => (
  <span style={{ width: 8, height: 8, borderRadius: 4, background: color, display: "inline-block", flexShrink: 0 }} />
);

/** The container and session output. Docker's build output can be thousands
 * of lines; the app keeps the tail. */
export function LogBox({ logs }: { logs: DockerLogIpc[] }): JSX.Element {
  return (
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
      {logs.length === 0
        ? "no output yet"
        : logs.map((line, index) => (
            <div key={index} style={{ color: line.source === "session" ? "#e7e9ec" : undefined }}>
              {line.line}
            </div>
          ))}
    </div>
  );
}

/**
 * A session that has been started: what it is doing, how its bots join, and
 * the way to stop it. Starting one is the Games screen's New Game; this only
 * reports on it, so the header of a game being watched offers nothing new.
 */
export function SessionStatus({ status, logs, onStop, onWatchSeat }: Props): JSX.Element {
  const [showLogs, setShowLogs] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);
  const running = isRunning(status);

  // While a game between two bots runs: what each bot is started with, and
  // whether it has arrived. The watched player can change; a game file holds
  // one bot's view, so mid-game the change waits for the next game.
  const seats = running && status.seats && (
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
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          {DOT(PHASE_COLOR[status.phase])}
          <span style={{ color: status.phase === "failed" ? "#e06c75" : "#8b93a1" }}>{phaseLabel(status)}</span>
        </span>
        {running && <button onClick={onStop}>Stop Session</button>}
        <button onClick={() => setShowLogs((v) => !v)} style={{ color: "#8b93a1" }}>
          {showLogs ? "Hide Log" : "Log"}
        </button>
      </div>
      {seats}
      {running && status.warning && <div style={{ fontSize: 12, color: "#d19a66" }}>{status.warning}</div>}
      {status.error && <div style={{ fontSize: 12, color: "#e06c75" }}>{status.error}</div>}
      {showLogs && <LogBox logs={logs} />}
    </div>
  );
}
