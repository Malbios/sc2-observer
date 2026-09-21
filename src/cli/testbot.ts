import WebSocket from "ws";
import { decodeResponse, encodeRequest, type Response } from "../protocol/schema";
import { extractUnits, type UnitSummary } from "../state/frames";
import { parseArgs } from "./args";
import { TestTelemetryWriter, type Point, type TelemetryMapInfo } from "./testbot-telemetry";

/**
 * A scripted SC2 API client for exercising the live path quickly.
 *
 * Everything below the viewer is meant to be tested against recorded frames
 * (plan §7), but the proxy, the session controller and the telemetry tailer
 * only exist while a game is running, and the only other client we have
 * (C:\dev\sc2-ai) plays a full game before it ends. This joins, steps for a
 * configurable number of loops, and then ends the game whichever way we want
 * to test -- including the ways a real bot cannot be asked to fail.
 *
 * It is a dev tool, not part of the app: nothing under src/main, src/proxy,
 * src/bus, src/history or src/renderer may know it exists, and the app must
 * not be able to tell it apart from a real bot. Its request sequence and
 * field values mirror python-sc2 (sc2/main.py::_play_game, sc2/client.py) so
 * the traffic the app sees is the traffic a real bot produces. C:\dev\sc2-ai
 * stays the realism oracle; this does not replace it.
 */

const USAGE = `Usage: testbot [options]

  --url <ws url>        default ws://127.0.0.1:5000/sc2api (the proxy; use :5001 for the container)
  --race <name>         Terran | Zerg | Protoss | Random   (default Zerg)
  --name <string>       player name, and the telemetry file name (default testbot)
  --step <n>            game loops per step request         (default 8)
  --loops <n>           stop after this many game loops, 0 = play to the end (default 1000)
  --end <mode>          surrender | leave | disconnect | hang | play (default surrender)
  --chat <n>            send a chat action every n steps, 0 = off (default 0)
  --telemetry <dir>     write a §3 NDJSON telemetry file into this directory
  --create-game <map>   create the game first, e.g. TorchesAIE.SC2Map
                        (this is Mode B: use it straight against the container,
                         or through a proxy started in Mode B, which forwards it
                         instead of sending one of its own)
  --connect-timeout <ms>  how long to retry the initial connect (default 60000)
`;

const RACES: Record<string, number> = { norace: 0, terran: 1, zerg: 2, protoss: 3, random: 4 };
const END_MODES = ["surrender", "leave", "disconnect", "hang", "play"] as const;
type EndMode = (typeof END_MODES)[number];

/** DebugEndGame.EndResult in debug.proto. */
const SURRENDER = 1;
/** ActionChat.Channel.Broadcast in sc2api.proto. */
const CHAT_BROADCAST = 1;

const CONNECT_RETRY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

/**
 * Lockstep request/response over one socket, matching sc2/protocol.py's
 * __request: one binary protobuf frame out, exactly one back, no ids and no
 * multiplexing.
 */
class Sc2Connection {
  private constructor(private readonly ws: WebSocket) {}

  /**
   * GameProxy.start() waits for SC2 and sends its own createGame before it
   * opens the bot-facing server, so a test bot started first gets
   * ECONNREFUSED for a while. Retrying is required, not defensive padding.
   */
  static async connect(url: string, timeoutMs: number): Promise<Sc2Connection> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        return new Sc2Connection(await openSocket(url));
      } catch (err) {
        if (Date.now() > deadline) {
          throw new Error(`could not connect to ${url} within ${timeoutMs}ms: ${(err as Error).message}`);
        }
        await sleep(CONNECT_RETRY_MS);
      }
    }
  }

  request(fields: Record<string, unknown>): Promise<Response> {
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        this.ws.off("message", onMessage);
        this.ws.off("error", onError);
        this.ws.off("close", onClose);
      };
      const onMessage = (data: Buffer): void => {
        cleanup();
        const response = decodeResponse(data);
        if (Array.isArray(response.error) && response.error.length > 0) {
          reject(new Error(`${Object.keys(fields)[0]} failed: ${JSON.stringify(response.error)}`));
          return;
        }
        resolve(response);
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error(`socket closed while waiting for a ${Object.keys(fields)[0]} response`));
      };

      this.ws.on("message", onMessage);
      this.ws.on("error", onError);
      this.ws.on("close", onClose);
      this.ws.send(encodeRequest(fields));
    });
  }

  /** An abrupt drop with no close handshake, i.e. a crashed bot. */
  terminate(): void {
    this.ws.terminate();
  }

  close(): void {
    this.ws.close();
  }
}

function parseEndMode(value: string | undefined): EndMode {
  const mode = (value ?? "surrender") as EndMode;
  if (!END_MODES.includes(mode)) {
    throw new Error(`unknown --end mode "${value}", expected one of ${END_MODES.join(", ")}`);
  }
  return mode;
}

function parseRace(value: string | undefined): number {
  const race = RACES[(value ?? "Zerg").toLowerCase()];
  if (race === undefined) {
    throw new Error(`unknown --race "${value}", expected Terran, Zerg, Protoss or Random`);
  }
  return race;
}

/**
 * game_info.start_raw.start_locations holds the *enemy* starts (SC2 leaves
 * our own out), and our own start is wherever our townhall is sitting in the
 * first observation. Falls back to the centre of the playable area so a map
 * with unexpected data still produces a usable telemetry file.
 */
function deriveMapInfo(gameInfo: Response, ownUnits: UnitSummary[]): TelemetryMapInfo {
  const startRaw = gameInfo.game_info?.start_raw ?? {};
  const area = startRaw.playable_area ?? {};
  const playableArea = {
    x0: area.p0?.x ?? 0,
    y0: area.p0?.y ?? 0,
    x1: area.p1?.x ?? startRaw.map_size?.x ?? 0,
    y1: area.p1?.y ?? startRaw.map_size?.y ?? 0,
  };
  const centre: Point = { x: (playableArea.x0 + playableArea.x1) / 2, y: (playableArea.y0 + playableArea.y1) / 2 };

  const townhall = ownUnits.reduce<UnitSummary | null>(
    (best, unit) => (unit.pos && (!best || unit.radius > best.radius) ? unit : best),
    null
  );
  const ourStart: Point = townhall?.pos ? { x: townhall.pos.x, y: townhall.pos.y } : centre;

  const firstEnemy = (startRaw.start_locations ?? [])[0];
  const enemyStart: Point = firstEnemy
    ? { x: firstEnemy.x, y: firstEnemy.y }
    : { x: 2 * centre.x - ourStart.x, y: 2 * centre.y - ourStart.y };

  return { ourStart, enemyStart, playableArea };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if ("help" in args) {
    console.log(USAGE);
    return;
  }

  const url = args.url || "ws://127.0.0.1:5000/sc2api";
  const race = parseRace(args.race);
  const name = args.name || "testbot";
  const stepSize = args.step ? Number(args.step) : 8;
  const maxLoops = args.loops !== undefined ? Number(args.loops) : 1000;
  const endMode = parseEndMode(args.end);
  const chatEvery = args.chat ? Number(args.chat) : 0;
  const telemetryDir = args.telemetry || null;
  const createMap = args["create-game"] || null;
  const connectTimeout = args["connect-timeout"] ? Number(args["connect-timeout"]) : 60_000;

  console.log(`[testbot] connecting to ${url} (up to ${connectTimeout}ms)...`);
  const conn = await Sc2Connection.connect(url, connectTimeout);

  if (createMap) {
    console.log(`[testbot] creating the game itself (map=${createMap}).`);
    await conn.request({
      create_game: {
        local_map: { map_path: createMap },
        player_setup: [
          { type: 1 /* Participant */ },
          { type: 2 /* Computer */, race: 2 /* Zerg */, difficulty: 2 /* Easy */ },
        ],
        realtime: false,
      },
    });
  }

  // Same fields python-sc2 sends (sc2/client.py join_game). No server_ports /
  // client_ports: those are only for bot-vs-bot, which §8 puts out of scope.
  const joined = await conn.request({
    join_game: {
      race,
      player_name: name,
      options: {
        raw: true,
        score: true,
        show_cloaked: true,
        show_burrowed_shadows: true,
        show_placeholders: true,
        raw_affects_selection: false,
        raw_crop_to_playable_area: false,
      },
    },
  });
  // Presence, not truthiness. ResponseJoinGame.error is a proto2 optional
  // enum whose first value is MissingParticipation = 1, so protobufjs serves
  // 1 off the message prototype even for a response that never carried the
  // field -- a successful join looks like a rejection if you just read it.
  // Fields actually present on the wire are own properties; defaults are not.
  const joinResult = joined.join_game ?? {};
  if (!Object.prototype.hasOwnProperty.call(joinResult, "player_id")) {
    throw new Error(`joinGame rejected: error=${joinResult.error} ${joinResult.error_details ?? ""}`);
  }
  const playerId: number = joinResult.player_id;
  console.log(`[testbot] joined as player ${playerId}.`);

  // Load-bearing, not cosmetic: HistoryStore keeps only the first `data` and
  // `gameInfo` responses, and the viewer's unit-type names and terrain come
  // from exactly those two. A recording made without them is unusable.
  await conn.request({ data: { ability_id: true, unit_type_id: true, upgrade_id: true, buff_id: true, effect_id: true } });
  const gameInfo = await conn.request({ game_info: {} });
  await conn.request({ ping: {} });

  let telemetry: TestTelemetryWriter | null = null;
  let loop = 0;
  let step = 0;
  let naturalEnd = false;

  for (;;) {
    const observation = await conn.request({ observation: {} });
    const inner = observation.observation?.observation ?? {};
    loop = inner.game_loop ?? 0;

    const playerResult = observation.observation?.player_result;
    if (Array.isArray(playerResult) && playerResult.length > 0) {
      naturalEnd = true;
      console.log(`[testbot] game ended naturally at loop ${loop}.`);
      break;
    }

    const ownUnits = extractUnits(observation).filter((unit) => unit.owner === playerId);

    if (telemetryDir && !telemetry) {
      telemetry = new TestTelemetryWriter(telemetryDir, name, deriveMapInfo(gameInfo, ownUnits), {
        url,
        step: stepSize,
        end: endMode,
        map: gameInfo.game_info?.map_name ?? null,
      });
      console.log(`[testbot] writing telemetry to ${telemetry.filePath}`);
    }

    const common = inner.player_common ?? {};
    telemetry?.emitLoop({
      loop,
      step,
      minerals: common.minerals ?? 0,
      vespene: common.vespene ?? 0,
      foodUsed: common.food_used ?? 0,
      armyCount: common.army_count ?? 0,
      ownUnits,
    });

    // A chat action is the cheapest real Request.action: it proves action
    // frames round-trip through the proxy and land in the recording without
    // needing ability-id lookups. Raw unit commands wait for Phase 6.
    if (chatEvery > 0 && step % chatEvery === 0) {
      await conn.request({
        action: { actions: [{ action_chat: { channel: CHAT_BROADCAST, message: `testbot loop ${loop}` } }] },
      });
    }

    if (maxLoops > 0 && loop >= maxLoops && endMode !== "play") break;

    await conn.request({ step: { count: stepSize } });
    step++;
  }

  if (naturalEnd) {
    telemetry?.end("natural", loop);
    conn.close();
    console.log("[testbot] done.");
    return;
  }

  switch (endMode) {
    case "surrender": {
      console.log(`[testbot] surrendering at loop ${loop}.`);
      await conn.request({ debug: { debug: [{ end_game: { end_result: SURRENDER } }] } });
      // The surrender only becomes a player_result once the game advances and
      // somebody observes it. Without these two the proxy never sees the end,
      // so the recorder never flushes.
      await conn.request({ step: { count: stepSize } });
      const final = await conn.request({ observation: {} });
      const result = final.observation?.player_result;
      console.log(`[testbot] player_result: ${JSON.stringify(result ?? null)}`);
      telemetry?.end("surrender", loop);
      conn.close();
      break;
    }
    case "leave": {
      // Phase 0 confirmed in_game -> launched. It produces no player_result,
      // so `record` will sit there waiting: that is the §7.1 "no status
      // transition" gap the session controller has to close, not a bug here.
      console.log(`[testbot] leaving the game at loop ${loop} (expect no player_result).`);
      await conn.request({ leave_game: {} });
      telemetry?.end("leave", loop);
      conn.close();
      break;
    }
    case "disconnect": {
      // §7.1: "Behaviour when the bot disconnects mid-game". No close
      // handshake and no telemetry `end` line, i.e. a crashed bot.
      console.log(`[testbot] dropping the connection at loop ${loop} with no handshake.`);
      conn.terminate();
      break;
    }
    case "hang": {
      // A halted bot freezes the lockstep game on its own; the app only shows
      // the frozen state (§4.2). The socket stays open and the telemetry file
      // stops growing without an `end` line.
      console.log(`[testbot] holding at loop ${loop} with the socket open. Ctrl-C to stop.`);
      await new Promise<never>(() => {});
      break;
    }
    case "play":
      // Unreachable: `play` only leaves the loop via naturalEnd.
      break;
  }

  console.log("[testbot] done.");
}

main().catch((err) => {
  console.error("[testbot] fatal:", err);
  process.exit(1);
});
