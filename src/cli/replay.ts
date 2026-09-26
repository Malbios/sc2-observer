/**
 * Converts `.SC2Replay` files into game files from the terminal, the way the
 * app's replay queue does: one file per replay, holding every viewpoint (the
 * observer slot, which sees everything, then each player).
 *
 * This is to the replay queue what `record` is to the proxy: the smallest
 * thing that exercises the real path, so it can be debugged against a log
 * rather than through a React tree. It expects a container to be running
 * already and no live session to be using it, because SC2 accepts one client
 * at a time.
 *
 * Run with:
 *   node dist/cli/replay.js --file game.SC2Replay [--file other.SC2Replay ...]
 *        [--out game.sqlite] [--games-dir DIR] [--watch N] [--player N]
 *        [--step 8] [--sc2-port 5001]
 *
 * `--watch N` converts only that viewpoint (0 is the observer slot).
 * `--player N` is whose result the file reports, the first participant by
 * default. `--out` names the file, and so takes a single replay.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EventBus } from "../bus/EventBus";
import { connectSc2 } from "../protocol/connection";
import { ReplayQueue } from "../replay/ReplayQueue";

const REPO_ROOT = join(__dirname, "..", "..");

function appVersion(): string | undefined {
  try {
    return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version as string;
  } catch {
    return undefined;
  }
}

/** Every value of a flag that may repeat (`--file a --file b`). The shared
 * parser keeps only the last, and a batch of replays is the point here. */
function allValues(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === `--${flag}`) values.push(argv[i + 1]!);
  }
  return values;
}

function single(argv: string[], flag: string): string | undefined {
  const values = allValues(argv, flag);
  return values[values.length - 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const files = allValues(argv, "file").map((file) => resolve(file));
  const out = single(argv, "out");
  if (files.length === 0 || (out && files.length > 1)) {
    console.error(
      "Usage: replay --file <game.SC2Replay> [--file ...] [--out game.sqlite] [--games-dir DIR]\n" +
        "              [--watch N] [--player N] [--step 8] [--sc2-port 5001]\n" +
        "--out takes a single replay.",
    );
    process.exit(1);
  }

  const port = Number(single(argv, "sc2-port") ?? 5001);
  const url = `ws://127.0.0.1:${port}/sc2api`;
  const watch = single(argv, "watch");
  const player = single(argv, "player");
  const step = single(argv, "step");
  const gamesDir = single(argv, "games-dir");

  const bus = new EventBus();
  const queue = new ReplayQueue({
    bus,
    connect: () => connectSc2(url),
    gamesDir: gamesDir ? resolve(gamesDir) : join(REPO_ROOT, "games"),
    outPath: out ? resolve(out) : undefined,
    readReplay: (file) => readFileSync(file),
    subjectPlayerId: player === undefined ? null : Number(player),
    stepLoops: step ? Number(step) : undefined,
    appVersion: appVersion(),
  });

  // One line per pass and per 10% of it: a converted 20-minute game is
  // thousands of steps, and the useful signal is "it is moving".
  let last = "";
  queue.onChange(() => {
    for (const item of queue.conversions) {
      if (item.state !== "converting" || item.passes === 0) continue;
      const percent = item.totalLoops > 0 ? Math.floor((item.loop / item.totalLoops) * 10) * 10 : 0;
      const line = `[replay] ${item.sourceName}: view ${item.pass} of ${item.passes}, ${percent}%`;
      if (line !== last) {
        last = line;
        console.log(line);
      }
    }
  });

  const startedAt = Date.now();
  queue.enqueue(files.map((filePath) => ({ filePath, viewpoints: watch === undefined ? null : [Number(watch)] })));
  await queue.whenIdle();
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  let failed = false;
  for (const item of queue.conversions) {
    if (item.state === "done") {
      console.log(`[replay] ${item.sourceName}: ${item.passes} view(s) in ${item.gameFile}`);
    } else {
      failed = true;
      console.error(`[replay] ${item.sourceName}: ${item.state}${item.error ? `: ${item.error}` : ""}`);
    }
  }
  console.log(`[replay] done in ${elapsed}s`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(`[replay] ${(err as Error).message}`);
  process.exit(1);
});
