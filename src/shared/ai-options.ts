/**
 * The built-in AI's settings, as sc2api.proto spells them (PlayerSetup, with
 * the Race, Difficulty and AIBuild enums). The wire carries the numbers; the
 * names are for people, and for anything written into a game file, so a
 * stored value never has to be decoded again (CLAUDE.md, "protobufjs decodes
 * enums as numbers").
 *
 * Shared by main (which creates the game) and the renderer (which offers the
 * choices), so the two cannot disagree about what a number means.
 */

export interface AiOption {
  value: number;
  /** The proto's own name, which is what gets stored. */
  name: string;
  /** How the panel says it. */
  label: string;
}

export const AI_RACES: AiOption[] = [
  { value: 1, name: "Terran", label: "Terran" },
  { value: 2, name: "Zerg", label: "Zerg" },
  { value: 3, name: "Protoss", label: "Protoss" },
  { value: 4, name: "Random", label: "Random" },
];

export const AI_DIFFICULTIES: AiOption[] = [
  { value: 1, name: "VeryEasy", label: "Very easy" },
  { value: 2, name: "Easy", label: "Easy" },
  { value: 3, name: "Medium", label: "Medium" },
  { value: 4, name: "MediumHard", label: "Medium hard" },
  { value: 5, name: "Hard", label: "Hard" },
  { value: 6, name: "Harder", label: "Harder" },
  { value: 7, name: "VeryHard", label: "Very hard" },
  { value: 8, name: "CheatVision", label: "Cheat: vision" },
  { value: 9, name: "CheatMoney", label: "Cheat: money" },
  { value: 10, name: "CheatInsane", label: "Cheat: insane" },
];

export const AI_BUILDS: AiOption[] = [
  { value: 1, name: "RandomBuild", label: "Any build" },
  { value: 2, name: "Rush", label: "Rush" },
  { value: 3, name: "Timing", label: "Timing" },
  { value: 4, name: "Power", label: "Power" },
  { value: 5, name: "Macro", label: "Macro" },
  { value: 6, name: "Air", label: "Air" },
];

/** One built-in AI opponent, by the proto's numbers. */
export interface AiOpponent {
  race: number;
  difficulty: number;
  build: number;
}

/** Today's opponent, and the one a session gets when none are chosen: an
 * easy Zerg with any build. */
export const DEFAULT_AI: AiOpponent = { race: 2, difficulty: 2, build: 1 };

/** A map has at most four start locations here, so three AIs besides the bot. */
export const MAX_AIS = 3;

export function optionName(options: AiOption[], value: number): string {
  return options.find((option) => option.value === value)?.name ?? String(value);
}

/** Case-insensitive lookup by name, for the command line (`--ai Zerg/Hard/Rush`). */
export function optionValue(options: AiOption[], name: string): number | null {
  const wanted = name.trim().toLowerCase();
  const match = options.find((option) => option.name.toLowerCase() === wanted || option.label.toLowerCase() === wanted);
  return match ? match.value : null;
}

/** An opponent as names, for a game file's meta. */
export function describeOpponent(opponent: AiOpponent): { race: string; difficulty: string; build: string } {
  return {
    race: optionName(AI_RACES, opponent.race),
    difficulty: optionName(AI_DIFFICULTIES, opponent.difficulty),
    build: optionName(AI_BUILDS, opponent.build),
  };
}
