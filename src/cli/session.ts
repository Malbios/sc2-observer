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
import { join, resolve } from "node:path";
import { EventBus } from "../bus/EventBus";
import { GameMode } from "../proxy/GameProxy";
import { SessionController } from "../session/SessionController";
import { parseArgs } from "./args";

const REPO_ROOT = join(__dirname, "..", "..");

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const map = args.map;

  if (!map) {
    console.error(
      "Usage: session --map <MapName.SC2Map> [--mode A|B] [--games-dir DIR] [--maps-dir DIR]\n" +
        "                 [--sc2-port P] [--bot-port P] [--race N] [--difficulty N]",
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
    opponentRace: args.race ? Number(args.race) : undefined,
    opponentDifficulty: args.difficulty ? Number(args.difficulty) : undefined,
    hostPort: args["sc2-port"] ? Number(args["sc2-port"]) : undefined,
    botPort: args["bot-port"] ? Number(args["bot-port"]) : undefined,
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
    console.log(
      `[state] ${state.phase} game=${state.gamesPlayed} loop=${state.loop} ` +
        `bot=${state.botConnected ? "connected" : "gone"} client=${state.clientStatus}`,
    );
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

  console.log("[session] running. Start your bot against 127.0.0.1:5000. Ctrl+C to stop.");
}

main().catch((err) => {
  console.error("[session] fatal:", err);
  process.exit(1);
});
