import { HistoryStore } from "../history/HistoryStore";
import { decodeResponse } from "../protocol/schema";
import { extractUnits } from "../state/frames";
import { parseArgs } from "./args";

function main(): void {
  const [file] = process.argv.slice(2);
  const args = parseArgs(process.argv.slice(2));
  const loop = args.loop ? Number(args.loop) : undefined;

  if (!file || loop === undefined) {
    console.error("Usage: dump <file.sqlite> --loop <L>");
    process.exit(1);
  }

  const store = new HistoryStore(file);
  console.log(`map: ${store.getMeta("map")}`);
  console.log(`mode: ${store.getMeta("mode")}`);
  console.log(`started_at: ${store.getMeta("started_at")}`);
  console.log(`ended_at: ${store.getMeta("ended_at")}`);

  const bytes = store.readFrameAtOrBefore("observation", loop);
  if (!bytes) {
    console.error(`No observation frame found at or before loop ${loop}`);
    process.exit(1);
  }

  const response = decodeResponse(bytes);
  const units = extractUnits(response);
  const actualLoop = response.observation?.observation?.game_loop;

  console.log(`requested loop: ${loop}, nearest recorded loop: ${actualLoop}`);
  console.log(`unit count: ${units.length}`);
  for (const unit of units) {
    console.log(`  tag=${unit.tag} type=${unit.unitType} owner=${unit.owner} pos=${JSON.stringify(unit.pos)}`);
  }

  store.close();
}

main();
