/**
 * Runs a live session from the terminal: container, proxy, per-game files and
 * automatic next games, with no Electron in the way.
 *
 * This is the session controller's stop point. The UI comes later (Phase 4
 * steps 6 and 7), and debugging a state machine through a React tree is a
 * worse experience than debugging it against a log, so the controller gets a
 * headless driver of its own first.
 *
 * Ctrl+C stops the session, which closes the current recording and removes the
 * container. Killing this process any other way leaves the container running.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EventBus } from "../bus/EventBus";
import { GameMode } from "../proxy/GameProxy";
import { SessionController } from "../session/SessionController";
import { AI_BUILDS, AI_DIFFICULTIES, AI_RACES, DEFAULT_AI, optionValue, type AiOpponent } from "../shared/ai-options";
import { parseArgs } from "./args";

const REPO_ROOT = join(__dirname, "..", "..");

/** The same string the app stamps into a game's `meta`, so a file recorded
 * from the terminal is as traceable as one recorded from the window. */
function appVersion(): string | undefined {
  try {
    return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version as string;
  } catch {
    return undefined;
  }
}

/**
 * `--ai Zerg/Hard/Rush,Protoss/Medium` gives one to three built-in AIs by
 * name: race, then difficulty, then an optional build. `--race N` and
 * `--difficulty N` remain the one-AI shorthand, by the proto's numbers.
 */
function parseOpponents(args: Record<string, string>): AiOpponent[] | undefined {
  if (args.ai) {
    return args.ai.split(",").map((spec) => {
      const [race = "", difficulty = "Easy", build = "RandomBuild"] = spec.split("/");
      const opponent = {
        race: optionValue(AI_RACES, race),
        difficulty: optionValue(AI_DIFFICULTIES, difficulty),
        build: optionValue(AI_BUILDS, build),
      };
      if (opponent.race === null || opponent.difficulty === null || opponent.build === null) {
        console.error(`[session] cannot read --ai "${spec}": expected race/difficulty/build, e.g. Zerg/Hard/Rush`);
        process.exit(1);
      }
      return opponent as AiOpponent;
    });
  }
  if (args.race || args.difficulty) {
    return [{ ...DEFAULT_AI, race: args.race ? Number(args.race) : DEFAULT_AI.race, difficulty: args.difficulty ? Number(args.difficulty) : DEFAULT_AI.difficulty }];
  }
  return undefined;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const map = args.map;

  if (!map) {
    console.error(
      "Usage: session --map <MapName.SC2Map> [--mode A|B|BvB] [--games-dir DIR] [--maps-dir DIR]\n" +
        "                 [--sc2-port P] [--bot-port P] [--ai Zerg/Hard/Rush,Protoss/Medium] [--watch 1|2]",
    );
    process.exit(1);
  }

  const bus = new EventBus();
  const controller = new SessionController({
    bus,
    dockerfileDir: join(REPO_ROOT, "docker"),
    mapsDir: args["maps-dir"] ? resolve(args["maps-dir"]) : join(REPO_ROOT, "maps"),
    gamesDir: args["games-dir"] ? resolve(args["games-dir"]) : join(REPO_ROOT, "games"),
    map,
    mode: (args.mode as GameMode) ?? "A",
    opponents: parseOpponents(args),
    hostPort: args["sc2-port"] ? Number(args["sc2-port"]) : undefined,
    botPort: args["bot-port"] ? Number(args["bot-port"]) : undefined,
    watchSeat: args.watch === "2" ? 2 : 1,
    appVersion: appVersion(),
  });

  // The container's own output is noisy and says nothing useful once SC2 is
  // up, so only the app's narration is printed unless it is asked for.
  const verbose = args.verbose !== undefined;
  bus.on("dockerLog", (event) => {
    if (verbose || event.source === "session" || event.source === "manager") {
      console.log(`[${event.source}] ${event.line}`);
    }
  });
  bus.on("sessionState", (state) => {
    const bots = state.seats
      ? state.seats.map((seat) => `p${seat.seat}=${seat.botConnected ? "connected" : "gone"}`).join(" ")
      : `bot=${state.botConnected ? "connected" : "gone"}`;
    console.log(`[state] ${state.phase} game=${state.gamesPlayed} loop=${state.loop} ${bots} client=${state.clientStatus}`);
  });

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log("[session] stopping.");
    await controller.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  const started = await controller.start();
  if (!started) {
    console.error(`[session] could not start: ${controller.status.error ?? "unknown reason"}`);
    await controller.stop();
    process.exit(1);
  }

  const seats = controller.status.seats;
  if (seats) {
    console.log("[session] running. Start each bot ladder-style. Ctrl+C to stop.");
    for (const seat of seats) {
      console.log(`[session]   player ${seat.seat}: --LadderServer ${seat.ladderServer} --GamePort ${seat.gamePort} --StartPort ${seat.startPort}`);
    }
  } else {
    console.log(`[session] running. Start your bot against 127.0.0.1:${args["bot-port"] ?? 5000}. Ctrl+C to stop.`);
  }
}

main().catch((err) => {
  console.error("[session] fatal:", err);
  process.exit(1);
});
