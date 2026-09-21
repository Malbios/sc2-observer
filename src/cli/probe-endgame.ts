import WebSocket from "ws";
import { decodeResponse, encodeRequest, type Response } from "../protocol/schema";
import { parseArgs } from "./args";

/**
 * Answers the last two §7.1 unknowns that Phase 4 is about to be built on,
 * against a real client rather than from the documentation.
 *
 * 1. Does `save_replay` work when issued after the game has ended? The state
 *    table in sc2api.proto says `save_replay | in_game` and `| ended (only
 *    after a game)`, but Phase 0 learned the hard way that a documented
 *    transition is worth confirming: the same table's `create_game` from
 *    `ended` was only believed once it had been seen. The session controller
 *    saves the replay on `ended`, so if this is wrong the whole auto-next-game
 *    flow has to be reordered to save while still `in_game`.
 * 2. What does `Response.status` actually do across a game? Nothing in src/
 *    reads it today, and the session controller's state machine is defined in
 *    terms of it, so the real sequence matters more than the enum's order.
 *
 * This talks straight to the container, not through the proxy, because it is
 * the client's behaviour being measured and the proxy would only add a party
 * that could be blamed for the result.
 *
 * Run with: node dist/cli/probe-endgame.js [--url ws://127.0.0.1:5001/sc2api] --map TorchesAIE.SC2Map
 */

/** Status in sc2api.proto. Named here only so the log is readable; this is a
 * probe, and the real mirror of this enum belongs with the session controller. */
const STATUS_NAMES: Record<number, string> = {
  1: "launched",
  2: "init_game",
  3: "in_game",
  4: "in_replay",
  5: "ended",
  6: "quit",
  99: "unknown",
};

/** DebugEndGame.EndResult.Surrender in debug.proto. */
const SURRENDER = 1;

const statusSeen: string[] = [];

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

async function connect(url: string, timeoutMs: number): Promise<WebSocket> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await openSocket(url);
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error(`could not connect to ${url} within ${timeoutMs}ms: ${(err as Error).message}`);
      }
      await sleep(500);
    }
  }
}

/**
 * One request, one response. Unlike the test bot's version this does not throw
 * on `response.error`: a refusal is a result here, not a failure, since half
 * the point is to find out which requests the client refuses and when.
 */
function request(ws: WebSocket, label: string, fields: Record<string, unknown>): Promise<Response> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    const onMessage = (data: Buffer): void => {
      cleanup();
      const response = decodeResponse(data);
      const status = response.status;
      const name = STATUS_NAMES[status] ?? String(status);
      if (statusSeen[statusSeen.length - 1] !== name) statusSeen.push(name);
      const failed = Array.isArray(response.error) && response.error.length > 0;
      console.log(`  ${label.padEnd(14)} -> status=${name}${failed ? ` ERROR ${JSON.stringify(response.error)}` : ""}`);
      resolve(response);
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error(`socket closed waiting for ${label}`));
    };
    ws.on("message", onMessage);
    ws.on("error", onError);
    ws.on("close", onClose);
    ws.send(encodeRequest(fields));
  });
}

/** `save_replay` returns the replay itself as bytes (ResponseSaveReplay.data),
 * which is why no replay volume has to be mounted into the container. */
function replayBytes(response: Response): number {
  const data = response.save_replay?.data;
  if (!data) return 0;
  return data.length ?? 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url || "ws://127.0.0.1:5001/sc2api";
  const map = args.map || "TorchesAIE.SC2Map";

  console.log(`[probe] connecting to ${url}`);
  const ws = await connect(url, 60_000);

  console.log("[probe] setting up a game");
  await request(ws, "ping", { ping: {} });
  await request(ws, "create_game", {
    create_game: {
      local_map: { map_path: map },
      player_setup: [
        { type: 1 /* Participant */ },
        { type: 2 /* Computer */, race: 2 /* Zerg */, difficulty: 2 /* Easy */ },
      ],
      realtime: false,
    },
  });
  const joined = await request(ws, "join_game", {
    join_game: { race: 2, player_name: "probe", options: { raw: true, score: true } },
  });
  // Presence, not truthiness: ResponseJoinGame.error is a proto2 optional enum
  // whose first value is 1, so protobufjs serves it off the prototype.
  if (!Object.prototype.hasOwnProperty.call(joined.join_game ?? {}, "player_id")) {
    throw new Error(`join rejected: ${JSON.stringify(joined.join_game)}`);
  }

  for (let i = 0; i < 5; i++) {
    await request(ws, "step", { step: { count: 8 } });
  }
  await request(ws, "observation", { observation: {} });

  // Question 1a: the documented in_game case, as the fallback if `ended` fails.
  console.log("[probe] save_replay while in_game");
  const inGameReplay = await request(ws, "save_replay", { save_replay: {} });
  const inGameBytes = replayBytes(inGameReplay);
  console.log(`  -> ${inGameBytes} bytes`);

  console.log("[probe] surrendering");
  await request(ws, "debug", { debug: { debug: [{ end_game: { end_result: SURRENDER } }] } });
  // The surrender only materializes once the game has been stepped past it.
  await request(ws, "step", { step: { count: 8 } });
  const afterEnd = await request(ws, "observation", { observation: {} });
  const playerResult = afterEnd.observation?.player_result;
  const gotResult = Array.isArray(playerResult) && playerResult.length > 0;
  console.log(`  player_result present: ${gotResult}${gotResult ? ` ${JSON.stringify(playerResult)}` : ""}`);

  // Question 1b: the one Phase 4 actually depends on.
  console.log("[probe] save_replay after ended");
  const endedReplay = await request(ws, "save_replay", { save_replay: {} });
  const endedBytes = replayBytes(endedReplay);
  const endedFailed = Array.isArray(endedReplay.error) && endedReplay.error.length > 0;
  console.log(`  -> ${endedBytes} bytes`);

  // The auto-next-game path, already proven in Phase 0 but free to reconfirm
  // here now that the client is genuinely in `ended` rather than `launched`.
  console.log("[probe] create_game again from ended");
  const nextGame = await request(ws, "create_game", {
    create_game: {
      local_map: { map_path: map },
      player_setup: [
        { type: 1 /* Participant */ },
        { type: 2 /* Computer */, race: 2 /* Zerg */, difficulty: 2 /* Easy */ },
      ],
      realtime: false,
    },
  });
  const nextGameFailed = Array.isArray(nextGame.error) && nextGame.error.length > 0;

  ws.close();

  console.log("\n=== results ===");
  console.log(`status sequence:            ${statusSeen.join(" -> ")}`);
  console.log(`save_replay in_game:        ${inGameBytes > 0 ? `${inGameBytes} bytes` : "NO DATA"}`);
  console.log(`player_result on surrender: ${gotResult ? "yes" : "NO"}`);
  console.log(`save_replay after ended:    ${endedFailed ? "REFUSED" : endedBytes > 0 ? `${endedBytes} bytes` : "NO DATA"}`);
  console.log(`create_game from ended:     ${nextGameFailed ? "REFUSED" : "accepted"}`);

  const ok = !endedFailed && endedBytes > 0 && gotResult && !nextGameFailed;
  console.log(
    ok
      ? "\nPhase 4 can save the replay on `ended` and create the next game from there."
      : "\nAt least one assumption does not hold; the session controller's end-of-game order needs rethinking."
  );
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`[probe] ${(err as Error).message}`);
  process.exit(1);
});
