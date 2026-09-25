import { namesFromMeta } from "../state/players";

/**
 * Who won a game, in words, for the Games list.
 *
 * The file's own `result` is one player's point of view: the bot's in a live
 * game, and merely the first participant's in a converted replay, which may
 * be nobody the user knows. So the list names the winner instead, for every
 * game, from what the file already holds: `player_result` for the outcome,
 * and `players` and `opponents` for the names.
 */
export interface OutcomeSummary {
  /** "VeTerran-extended won", "Computer (VeryHard Terran) won" or "Tie". */
  text: string;
  /** Every player and their result, one per line, for the tooltip. */
  detail: string;
}

interface Opponent {
  player_id?: unknown;
  race?: unknown;
  difficulty?: unknown;
}

function parseArray(raw: string | undefined): Record<string, unknown>[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
}

/** Each player's name by id, from whatever the file recorded about them. */
function playerNames(meta: ReadonlyMap<string, string>): Map<number, string> {
  const names = namesFromMeta(meta.get("players"));
  // A live game's built-in AIs have no name, only what they were set up as.
  for (const ai of parseArray(meta.get("opponents")) as Opponent[]) {
    if (typeof ai.player_id !== "number" || names.has(ai.player_id)) continue;
    const setup = [ai.difficulty, ai.race].filter((part) => typeof part === "string" && part !== "").join(" ");
    names.set(ai.player_id, setup ? `Computer (${setup})` : "Computer");
  }
  // A live game from before bot names were kept still knows which player was
  // the bot the app served.
  const bot = Number(meta.get("bot_player_id"));
  if (meta.get("source") === "live" && Number.isInteger(bot) && bot > 0 && !names.has(bot)) names.set(bot, "the bot");
  return names;
}

export function describeOutcome(meta: ReadonlyMap<string, string>): OutcomeSummary | null {
  const results = parseArray(meta.get("player_result"))
    .filter((entry) => typeof entry["player_id"] === "number" && typeof entry["result"] === "string")
    .map((entry) => ({ playerId: entry["player_id"] as number, result: entry["result"] as string }))
    .sort((a, b) => a.playerId - b.playerId);
  if (results.length === 0) return null;

  const names = playerNames(meta);
  const nameOf = (id: number): string => names.get(id) ?? `Player ${id}`;
  const detail = results.map((entry) => `${nameOf(entry.playerId)}: ${entry.result}`).join("\n");

  const winners = results.filter((entry) => entry.result === "Victory").map((entry) => nameOf(entry.playerId));
  if (winners.length > 0) {
    const list = winners.length === 1 ? winners[0]! : `${winners.slice(0, -1).join(", ")} and ${winners[winners.length - 1]}`;
    return { text: `${list} won`, detail };
  }
  if (results.every((entry) => entry.result === "Tie")) return { text: "Tie", detail };
  // Results that name no winner (every player lost, or "Undecided") are not
  // an outcome to headline; the list falls back to how the game ended.
  return null;
}
