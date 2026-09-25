import { enumName, playerTypeName, raceName, type Response } from "../protocol/schema";
import type { PlayerIpc } from "../shared/ipc-types";

/**
 * The players of a game, as the unit inspector names a unit's owner.
 *
 * `game_info.player_info` has each player's id, type, race and (for a built-in
 * AI) difficulty, but never a name: 4.10 leaves `player_name` unset, measured
 * on live games and converted replays alike. Names come from elsewhere, which
 * is why they are passed in: a replay's `replay_info`, or the name a bot
 * joined under. A player with no known name is "Computer" or "Player N".
 *
 * Every enum goes through `enumName`, because protobufjs decodes them as
 * numbers (CLAUDE.md's trap).
 */
export function describePlayers(gameInfoResponse: Response | null, names: ReadonlyMap<number, string>): PlayerIpc[] {
  const entries = (gameInfoResponse?.game_info?.player_info ?? []) as Record<string, unknown>[];
  const players: PlayerIpc[] = [];
  for (const entry of entries) {
    // Presence, not truthiness: an unset id would decode as 0.
    if (!Object.prototype.hasOwnProperty.call(entry, "player_id")) continue;
    const playerId = Number(entry["player_id"]);
    const has = (field: string): boolean => Object.prototype.hasOwnProperty.call(entry, field);
    const type = has("type") ? playerTypeName(Number(entry["type"])) : null;
    // The actual race is only reported for your own player or in a replay;
    // the requested one is always there, and says "Random" when it was.
    const race = has("race_actual")
      ? raceName(Number(entry["race_actual"]))
      : has("race_requested")
        ? raceName(Number(entry["race_requested"]))
        : null;
    const difficulty = has("difficulty") ? enumName("SC2APIProtocol.Difficulty", Number(entry["difficulty"])) : null;
    const name = names.get(playerId);
    players.push({
      playerId,
      label: name && name !== "" ? name : type === "Computer" ? "Computer" : `Player ${playerId}`,
      race,
      type,
      difficulty,
    });
  }
  return players;
}

/**
 * Names from a game file's `players` meta, which has two shapes: a converted
 * replay writes `{playerId, name}` and a live game writes `{player_id, name}`.
 * Anything unreadable gives no names rather than an error: the inspector falls
 * back to "Player N".
 */
export function namesFromMeta(json: string | undefined): Map<number, string> {
  const names = new Map<number, string>();
  if (!json) return names;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return names;
  }
  if (!Array.isArray(parsed)) return names;
  for (const entry of parsed as Record<string, unknown>[]) {
    const id = entry?.["playerId"] ?? entry?.["player_id"];
    const name = entry?.["name"];
    if (typeof id === "number" && typeof name === "string" && name !== "") names.set(id, name);
  }
  return names;
}
