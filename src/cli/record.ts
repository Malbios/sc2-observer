import { EventBus } from "../bus/EventBus";
import { GameProxy } from "../proxy/GameProxy";
import { HistoryStore } from "../history/HistoryStore";
import { parseArgs } from "./args";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const map = args.map;
  const out = args.out;

  if (!map || !out) {
    console.error("Usage: record --map <MapName.SC2Map> --out <file.sqlite> [--sc2-host H] [--sc2-port P] [--bot-port P]");
    process.exit(1);
  }

  const bus = new EventBus();
  const store = new HistoryStore(out);
  const sessionId = `session-${Date.now()}`;

  store.setMeta("map", map);
  store.setMeta("mode", "A");
  store.setMeta("started_at", new Date().toISOString());

  bus.on("frame", (event) => store.recordFrame(event));

  const proxy = new GameProxy({
    sessionId,
    bus,
    mapPath: map,
    sc2Host: args["sc2-host"],
    sc2Port: args["sc2-port"] ? Number(args["sc2-port"]) : undefined,
    botPort: args["bot-port"] ? Number(args["bot-port"]) : undefined,
  });

  const ended = new Promise<void>((resolve) => {
    bus.on("gameEnded", () => resolve());
  });

  console.log(`[record] waiting for SC2 and sending createGame (map=${map})...`);
  await proxy.start();
  console.log("[record] listening for the bot.");

  await ended;
  console.log("[record] game ended; flushing and closing.");

  store.setMeta("ended_at", new Date().toISOString());
  proxy.stop();
  store.close();
  console.log(`[record] recorded to ${out}`);
}

main().catch((err) => {
  console.error("[record] fatal:", err);
  process.exit(1);
});
