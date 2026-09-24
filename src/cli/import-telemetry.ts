import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { HistoryStore } from "../history/HistoryStore";
import { telemetryRefusal } from "../telemetry/attachRule";
import { StreamIngest } from "../telemetry/ingest";
import { parseArgs } from "./args";

/**
 * Attaches a telemetry NDJSON file to an existing recording.
 *
 * This is the same path the live tailer uses (§4: the tailer is "also used
 * verbatim for import of a file next to a replay"), so it doubles as the way
 * to check ingestion without running a game, and as Phase 5's "import a
 * telemetry file into an existing game".
 */

const USAGE = `Usage: import-telemetry <game.sqlite> --file <telemetry.ndjson>`;

async function main(): Promise<void> {
  const [gamePath] = process.argv.slice(2);
  const args = parseArgs(process.argv.slice(2));
  const filePath = args.file;

  if (!gamePath || gamePath.startsWith("--") || !filePath) {
    console.error(USAGE);
    process.exit(1);
  }

  const store = new HistoryStore(gamePath);
  const problem = telemetryRefusal(store);
  if (problem) {
    store.close();
    console.error(`[import] ${gamePath}: ${problem}`);
    process.exit(1);
  }
  const fallbackName = path.basename(filePath).replace(/\.ndjson$/i, "");
  const ingest = new StreamIngest(store, path.resolve(filePath), fallbackName);

  // Line at a time rather than readFileSync+split: a bot emitting a grid every
  // step can produce a file far larger than it is comfortable to hold twice.
  const lines = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of lines) {
    ingest.line(line, ++lineNo);
  }

  const summary = ingest.finish();
  store.close();

  console.log(`[import] ${filePath} -> ${gamePath}`);
  console.log(`[import] stream ${summary.streamId} "${summary.name}", ${lineNo} lines read`);
  console.log(`[import] ${summary.messageCount} messages, loops ${summary.firstLoop} to ${summary.lastLoop}`);
  console.log(`[import] hello: ${summary.sawHello ? "yes" : "no"}, end: ${summary.sawEnd ? "yes" : "no"}`);
  if (summary.outOfOrderCount > 0) {
    console.log(`[import] warning: ${summary.outOfOrderCount} messages arrived out of loop order`);
  }
  if (summary.rejectedCount > 0) {
    console.log(`[import] ${summary.rejectedCount} lines rejected:`);
    for (const rejection of summary.rejections) {
      console.log(`[import]   line ${rejection.line}: ${rejection.reason}`);
    }
    if (summary.rejectedCount > summary.rejections.length) {
      console.log(`[import]   ... and ${summary.rejectedCount - summary.rejections.length} more`);
    }
  }
}

main().catch((err) => {
  console.error("[import] fatal:", err);
  process.exit(1);
});
