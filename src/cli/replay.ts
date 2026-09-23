/**
 * Plays a `.SC2Replay` through the client and records it as a game, from the
 * terminal.
 *
 * This is to the replay driver what `record` is to the proxy: the smallest
 * thing that exercises the real path, so the driver can be debugged against a
 * log rather than through a React tree. It expects a container to be running
 * already and no live session to be using it, because SC2 accepts one client
 * at a time.
 *
 * Run with:
 *   node dist/cli/replay.js --file game.SC2Replay [--out game.sqlite]
 *        [--games-dir DIR] [--player 1] [--step 8] [--speed max|1|2|8]
 *        [--sc2-port 5001]
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EventBus } from "../bus/EventBus";
import { connectSc2 } from "../protocol/connection";
import { OBSERVER_SLOT, ReplayDriver, type ReplaySpeed } from "../replay/ReplayDriver";
import { ReplaySession } from "../replay/ReplaySession";
import { parseArgs } from "./args";

const REPO_ROOT = join(__dirname, "..", "..");

function appVersion(): string | undefined {
  try {
    return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version as string;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const file = args.file;
  if (!file) {
    console.error(
      "Usage: replay --file <game.SC2Replay> [--out game.sqlite] [--games-dir DIR]\n" +
        "              [--watch N] [--player N] [--step 8] [--speed max|1|2|8] [--sc2-port 5001]",
    );
    process.exit(1);
  }

  const filePath = resolve(file);
  const replayData = readFileSync(filePath);
  const port = args["sc2-port"] ? Number(args["sc2-port"]) : 5001;
  const url = `ws://127.0.0.1:${port}/sc2api`;
  const speed: ReplaySpeed = args.speed && args.speed !== "max" ? Number(args.speed) : "max";

  const bus = new EventBus();
  const driver = new ReplayDriver({
    bus,
    sessionId: "replay",
    connect: () => connectSc2(url),
    replayData,
    observedPlayerId: args.watch === undefined ? OBSERVER_SLOT : Number(args.watch),
    stepLoops: args.step ? Number(args.step) : undefined,
    speed,
  });

  console.log(`[replay] ${filePath}: ${replayData.length} bytes`);
  const info = await driver.readInfo();
  console.log(`[replay] ${info.mapName} (${info.localMapPath}), ${info.durationLoops} loops, ${info.gameVersion}`);
  for (const player of info.players) {
    console.log(`[replay] player ${player.playerId}: ${player.name} (${player.race}) ${player.result ?? "no result"}`);
  }

  // Two different players, deliberately. `--watch` is whose vision the
  // recording holds, defaulting to the observer slot, which sees the whole
  // map. `--player` is whose result the game file calls its own, defaulting
  // to the first participant, which for a ladder replay is the bot.
  const observed = args.watch === undefined ? OBSERVER_SLOT : Number(args.watch);
  const subject = args.player
    ? Number(args.player)
    : info.players.find((player) => player.type === "Participant")?.playerId ?? 1;
  driver.observeAs(observed);
  console.log(`[replay] watching as ${observed === OBSERVER_SLOT ? "an observer (whole map)" : `player ${observed}`}, result from player ${subject}`);

  const session = new ReplaySession({
    bus,
    gamesDir: args["games-dir"] ? resolve(args["games-dir"]) : join(REPO_ROOT, "games"),
    outPath: args.out ? resolve(args.out) : undefined,
    sourcePath: filePath,
    info,
    observedPlayerId: observed,
    subjectPlayerId: subject,
    appVersion: appVersion(),
  });
  session.attach();

  let lastReported = -1;
  bus.on("replayProgress", (progress) => {
    // One line per 10%, because a converted 20-minute game is thousands of
    // steps and the useful signal is "it is moving".
    const percent = progress.totalLoops > 0 ? Math.floor((progress.loop / progress.totalLoops) * 10) * 10 : -1;
    if (percent > lastReported) {
      lastReported = percent;
      console.log(`[replay] ${percent}% (loop ${progress.loop} of ${progress.totalLoops})`);
    }
  });

  const startedAt = Date.now();
  await driver.start();
  await driver.run();
  session.close();

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[replay] done in ${elapsed}s: ${session.gameFile}`);
}

main().catch((err) => {
  console.error(`[replay] ${(err as Error).message}`);
  process.exit(1);
});
