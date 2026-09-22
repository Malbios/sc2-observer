import { Fragment, useMemo, useState, type CSSProperties, type JSX } from "react";
import type { GameCatalogIpc, GameSummaryIpc } from "../../../shared/ipc-types";

/**
 * The history browser (§6.4): every game in the games folder, newest first,
 * opened in the same viewer a live session uses.
 *
 * The list is what main peeked off the files a moment ago, not a cached table,
 * so a game deleted in Explorer is simply not in the next listing, and a game
 * whose file will not open is a row with a reason rather than a gap.
 */

/** SC2's normal-speed loop rate, the same constant the timeline uses. Loops
 * are the time axis (§3); this is only how they read to a person. */
const LOOPS_PER_SECOND = 22.4;

interface Props {
  catalog: GameCatalogIpc | null;
  /** Something main refused or could not do, shown above the list. */
  problem: string | null;
  /** Something that worked and is worth saying, such as where a game was
   * exported to. */
  notice: string | null;
  onOpen(game: GameSummaryIpc): void;
  onRefresh(): void;
  onSetTags(game: GameSummaryIpc, tags: string[]): void;
  onExport(game: GameSummaryIpc): void;
  onDelete(game: GameSummaryIpc): void;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "unknown";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(maxLoop: number | null): string {
  if (maxLoop === null) return "no frames";
  const seconds = Math.round(maxLoop / LOOPS_PER_SECOND);
  const minutes = Math.floor(seconds / 60);
  return `${maxLoop.toLocaleString()} loops (${minutes}:${String(seconds % 60).padStart(2, "0")})`;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Why a game ended, for the games that have no result to show. The reasons
 * are the proxy's (§7.1): a clean leave and a vanished bot both genuinely
 * produce no winner. */
function endReasonLabel(reason: string | null): string {
  switch (reason) {
    case "status":
      return "bot left the game";
    case "botClosed":
      return "bot disconnected";
    case "result":
      return "ended";
    default:
      return "unknown";
  }
}

/** The headline column. A result when SC2 reported one, and otherwise the
 * honest answer, which is how it ended rather than an invented outcome. */
function outcome(game: GameSummaryIpc): { text: string; color: string } {
  if (game.state === "newer") return { text: "newer build", color: "#d19a66" };
  if (game.state === "unreadable") return { text: "unreadable", color: "#e06c75" };
  if (game.state === "incomplete") return { text: "unfinished", color: "#d19a66" };
  if (game.result && game.result !== "unknown") {
    const won = game.result === "Victory";
    return { text: game.result, color: won ? "#98c379" : "#8b93a1" };
  }
  return { text: endReasonLabel(game.endReason), color: "#8b93a1" };
}

/** Tags as typed: one line, commas between them. Whitespace and duplicates
 * are main's to clean up, since a tag written by hand into a game file has to
 * come out the same way. */
function splitTags(text: string): string[] {
  return text.split(",");
}

/** What the confirmation says goes. Both files by name, and the sidecars,
 * because a `-wal` left behind is inherited by the next file of that name. */
function deleteQuestion(game: GameSummaryIpc): string {
  const replay = game.hasReplay ? ` and ${game.fileName.replace(/\.sqlite$/i, ".SC2Replay")}` : "";
  return `Move ${game.fileName}${replay}, and any -wal/-shm sidecars, to the recycle bin?`;
}

function matches(game: GameSummaryIpc, needle: string): boolean {
  if (!needle) return true;
  const haystack = [
    game.fileName,
    game.map ?? "",
    game.result ?? "",
    game.mode ?? "",
    ...game.tags,
    ...game.botNames,
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

const CELL: CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid #212730",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const HEAD: CSSProperties = {
  ...CELL,
  color: "#8b93a1",
  fontWeight: 400,
  textAlign: "left",
  borderBottom: "1px solid #2b323d",
  position: "sticky",
  top: 0,
  background: "#181c22",
};

/** The small buttons in the actions column, which are not row-sized. */
const ACTION: CSSProperties = { fontSize: 11, padding: "1px 6px" };

export function GameCatalog({
  catalog,
  problem,
  notice,
  onOpen,
  onRefresh,
  onSetTags,
  onExport,
  onDelete,
}: Props): JSX.Element {
  const [filter, setFilter] = useState("");
  /** The game whose tags are being typed, and the text as typed. Tags are
   * committed on Enter or on leaving the field, never per keystroke: each
   * write goes to the game file on disk. */
  const [editing, setEditing] = useState<{ filePath: string; text: string } | null>(null);
  /** Delete asks first, in the row rather than in a dialog box, and the
   * question names what goes. */
  const [confirming, setConfirming] = useState<string | null>(null);

  const games = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (catalog?.games ?? []).filter((game) => matches(game, needle));
  }, [catalog, filter]);

  const total = catalog?.games.length ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px" }}>
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter by map, tag, bot or result"
          style={{ flex: 1, maxWidth: 360 }}
        />
        <span style={{ color: "#8b93a1", fontSize: 12 }}>
          {games.length === total ? `${total} game${total === 1 ? "" : "s"}` : `${games.length} of ${total}`}
          {catalog && <span title={catalog.dir}> in {catalog.dir}</span>}
        </span>
        <button onClick={onRefresh} style={{ marginLeft: "auto" }}>
          Refresh
        </button>
      </div>

      {problem && <div style={{ padding: "0 16px 8px", color: "#e06c75", fontSize: 12 }}>{problem}</div>}
      {notice && !problem && <div style={{ padding: "0 16px 8px", color: "#8b93a1", fontSize: 12 }}>{notice}</div>}

      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {total === 0 ? (
          <div style={{ padding: 24, color: "#8b93a1", fontSize: 13, lineHeight: 1.6 }}>
            No games here yet. Start a live session and every game your bot plays is recorded into this folder, with
            its replay beside it.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, tableLayout: "fixed" }}>
            <thead>
              <tr>
                <th style={{ ...HEAD, width: "20%" }}>Map</th>
                <th style={{ ...HEAD, width: "13%" }}>When</th>
                <th style={{ ...HEAD, width: "13%" }}>Length</th>
                <th style={{ ...HEAD, width: "11%" }}>Outcome</th>
                <th style={{ ...HEAD, width: "10%" }}>Bot</th>
                <th style={{ ...HEAD, width: "14%" }}>Tags</th>
                <th style={{ ...HEAD, width: "7%", textAlign: "right" }}>Size</th>
                <th style={{ ...HEAD, width: "12%" }} />
              </tr>
            </thead>
            <tbody>
              {games.map((game) => {
                const live = catalog?.liveFilePath === game.filePath;
                const open = catalog?.openFilePath === game.filePath;
                const result = outcome(game);
                const openable = game.state === "ok" || game.state === "incomplete";
                return (
                  <Fragment key={game.filePath}>
                  <tr
                    onClick={() => openable && onOpen(game)}
                    title={game.problem ?? game.filePath}
                    style={{
                      cursor: openable ? "pointer" : "default",
                      background: open ? "#242a33" : undefined,
                      color: openable ? undefined : "#6b727d",
                    }}
                  >
                    <td style={CELL}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                          {game.map?.replace(/\.SC2Map$/i, "") || game.fileName}
                        </span>
                        {live && (
                          <span
                            style={{
                              fontSize: 10,
                              color: "#98c379",
                              border: "1px solid #3c4b3a",
                              borderRadius: 3,
                              padding: "0 4px",
                            }}
                          >
                            live
                          </span>
                        )}
                        {game.hasReplay && (
                          <span style={{ fontSize: 10, color: "#8b93a1" }} title="a .SC2Replay sits beside this game">
                            replay
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={{ ...CELL, color: "#8b93a1" }}>{formatWhen(game.startedAt)}</td>
                    <td style={{ ...CELL, color: "#8b93a1" }} title="22.4 loops per second at normal speed">
                      {formatDuration(game.maxLoop)}
                    </td>
                    <td style={{ ...CELL, color: result.color }}>{result.text}</td>
                    <td style={{ ...CELL, color: "#8b93a1" }}>{game.botNames.join(", ") || "-"}</td>
                    <td
                      style={{ ...CELL, color: "#8b93a1" }}
                      onClick={(event) => {
                        // The row opens a game; the tags cell edits tags.
                        event.stopPropagation();
                        setEditing({ filePath: game.filePath, text: game.tags.join(", ") });
                      }}
                      title="Click to tag this game"
                    >
                      {editing?.filePath === game.filePath ? (
                        <input
                          autoFocus
                          value={editing.text}
                          onChange={(event) => setEditing({ filePath: game.filePath, text: event.target.value })}
                          onBlur={() => {
                            onSetTags(game, splitTags(editing.text));
                            setEditing(null);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") event.currentTarget.blur();
                            // Escape abandons the edit, which is the only way
                            // back out of a mistyped tag without saving it.
                            if (event.key === "Escape") setEditing(null);
                          }}
                          placeholder="comma, separated"
                          style={{ width: "100%", fontSize: 12 }}
                        />
                      ) : (
                        game.tags.join(", ") || "-"
                      )}
                    </td>
                    <td style={{ ...CELL, color: "#8b93a1", textAlign: "right" }}>{formatSize(game.sizeBytes)}</td>
                    <td style={CELL} onClick={(event) => event.stopPropagation()}>
                      <span style={{ display: "flex", gap: 4 }}>
                        <button style={ACTION} onClick={() => onExport(game)} title="Copy this game and its replay elsewhere">
                          Export
                        </button>
                        <button
                          style={ACTION}
                          onClick={() => setConfirming(game.filePath)}
                          disabled={live}
                          title={live ? "This game is being played right now" : "Delete this game and its replay"}
                        >
                          Delete
                        </button>
                      </span>
                    </td>
                  </tr>
                  {confirming === game.filePath && (
                    <tr>
                      <td colSpan={8} style={{ ...CELL, whiteSpace: "normal", background: "#1d2127" }}>
                        <span style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                          <span>{deleteQuestion(game)}</span>
                          <button
                            style={{ ...ACTION, color: "#e06c75" }}
                            onClick={() => {
                              setConfirming(null);
                              onDelete(game);
                            }}
                          >
                            Move to recycle bin
                          </button>
                          <button style={ACTION} onClick={() => setConfirming(null)}>
                            Cancel
                          </button>
                        </span>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
