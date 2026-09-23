import { readFileSync } from "node:fs";
import WebSocket from "ws";
import { decodeResponse, encodeRequest, type Response } from "../protocol/schema";
import { SC2_STATUS, statusName } from "../protocol/status";
import { parseArgs } from "./args";

/**
 * Measures what the client actually does with a replay, before Phase 6 is
 * built on top of it. Phase 0 established the habit: the state table in
 * sc2api.proto is a good guide and a poor promise, and the cheapest bug is
 * the one found by a probe that changes nothing.
 *
 * Four questions, in the order the driver will ask them:
 *
 * 1. Does `replay_info` accept the replay as **bytes** (`replay_data`) rather
 *    than a path inside the container? If it does, nothing has to be copied in
 *    and no replay volume has to be mounted, exactly as `save_replay`
 *    returning bytes meant nothing had to be mounted to save one.
 * 2. Does `start_replay` accept the same bytes?
 * 3. What is the status sequence, and does stepping past the end of a replay
 *    really leave `in_replay`? That transition is how the driver will know a
 *    replay is over: §4.2's rule against timeouts applies here too.
 * 4. What does a refused replay look like? The user has to be told why their
 *    ladder replay will not load, and `ResponseStartReplay.Error` is where
 *    that text comes from.
 *
 * It also times a full playthrough and measures what the observations weigh,
 * which is what decides the driver's default step size.
 *
 * This talks straight to the container rather than through the proxy: it is
 * the client's behaviour being measured.
 *
 * Run with: node dist/cli/probe-replay.js --file game.SC2Replay [--url ws://127.0.0.1:5001/sc2api] [--step 8]
 */

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

interface Reply {
  response: Response;
  bytes: number;
}

/**
 * One request, one response. A refusal is a result here rather than a failure:
 * finding out which requests the client refuses, and what it says when it
 * does, is half the point.
 */
function request(ws: WebSocket, label: string, fields: Record<string, unknown>, quiet = false): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    const onMessage = (data: Buffer): void => {
      cleanup();
      const response = decodeResponse(data);
      const name = statusName(response.status);
      if (statusSeen[statusSeen.length - 1] !== name) statusSeen.push(name);
      const failed = Array.isArray(response.error) && response.error.length > 0;
      if (!quiet || failed) {
        console.log(`  ${label.padEnd(14)} -> status=${name}${failed ? ` ERROR ${JSON.stringify(response.error)}` : ""}`);
      }
      resolve({ response, bytes: data.length });
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

/** The error a replay request reports, by name rather than number. Both
 * responses carry the same shape: an `error` enum and `error_details`. */
function replayError(payload: Record<string, unknown> | undefined): string | null {
  if (!payload) return "no payload";
  if (!Object.prototype.hasOwnProperty.call(payload, "error")) return null;
  const details = payload["error_details"];
  return `${String(payload["error"])}${details ? `: ${String(details)}` : ""}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url || "ws://127.0.0.1:5001/sc2api";
  const file = args.file;
  const step = args.step ? Number(args.step) : 8;

  if (!file) {
    console.error("Usage: probe-replay --file <game.SC2Replay> [--url ws://127.0.0.1:5001/sc2api] [--step 8]");
    process.exit(1);
  }

  const replay = readFileSync(file);
  console.log(`[probe] ${file}: ${replay.length} bytes`);
  console.log(`[probe] connecting to ${url}`);
  const ws = await connect(url, 60_000);

  const { response: pinged } = await request(ws, "ping", { ping: {} });
  const startingStatus = pinged.status;
  // A container left behind by a killed session can be sitting in a game, and
  // `start_replay` is only valid from `launched`. The recovery is the one
  // CLAUDE.md already records for `create_game`.
  if (startingStatus === SC2_STATUS.inGame || startingStatus === SC2_STATUS.inReplay) {
    console.log("[probe] the client is busy; leaving whatever it is in first");
    await request(ws, "leave_game", { leave_game: {} });
  }

  // -- 1. replay_info from bytes -------------------------------------------
  console.log("[probe] replay_info from bytes");
  const { response: infoResponse } = await request(ws, "replay_info", { replay_info: { replay_data: replay } });
  const info = infoResponse.replay_info as Record<string, unknown> | undefined;
  const infoError = replayError(info);
  if (info && !infoError) {
    console.log(`  map: ${String(info["map_name"])} (${String(info["local_map_path"])})`);
    console.log(`  duration: ${String(info["game_duration_loops"])} loops, ${String(info["game_duration_seconds"])}s`);
    console.log(`  version: ${String(info["game_version"])}, base build ${String(info["base_build"])}, data ${String(info["data_version"])}`);
    for (const player of (info["player_info"] as Record<string, unknown>[]) ?? []) {
      console.log(`  player: ${JSON.stringify(player)}`);
    }
  }

  // -- 2. a deliberately broken replay, for the error shape -----------------
  console.log("[probe] start_replay with 64 bytes of nonsense");
  const { response: refused } = await request(ws, "start_replay", {
    start_replay: {
      replay_data: Buffer.alloc(64, 7),
      observed_player_id: 1,
      options: { raw: true, score: true },
      disable_fog: true,
    },
  });
  const refusedError = replayError(refused.start_replay as Record<string, unknown> | undefined);
  console.log(`  refused as: ${refusedError ?? "NOT REFUSED"}`);

  // -- 3. the real one ------------------------------------------------------
  console.log("[probe] start_replay from bytes");
  const { response: started } = await request(ws, "start_replay", {
    start_replay: {
      replay_data: replay,
      observed_player_id: 1,
      options: { raw: true, score: true },
      disable_fog: true,
      realtime: false,
    },
  });
  const startError = replayError(started.start_replay as Record<string, unknown> | undefined);
  if (startError) {
    console.log(`  refused: ${startError}`);
    ws.close();
    console.log("\n=== results ===");
    console.log(`replay_info from bytes: ${infoError ?? "accepted"}`);
    console.log(`start_replay from bytes: refused (${startError})`);
    console.log("\nThe driver will have to put the file inside the container and use replay_path.");
    process.exit(1);
  }

  const { response: gameInfo } = await request(ws, "game_info", { game_info: {} });
  const hasTerrain = Boolean((gameInfo.game_info as Record<string, unknown> | undefined)?.["start_raw"]);
  const { bytes: dataBytes } = await request(ws, "data", { data: { unit_type_id: true, ability_id: true } });

  // -- 4. the step loop, and how it ends ------------------------------------
  console.log(`[probe] stepping ${step} loops at a time`);
  const startedAt = Date.now();
  let observations = 0;
  let observationBytes = 0;
  let lastLoop = 0;
  let sawResult = false;
  let endedBy = "hit the cap";

  for (let i = 0; i < 20_000; i++) {
    const stepped = await request(ws, "step", { step: { count: step } }, true);
    if (stepped.response.status !== SC2_STATUS.inReplay) {
      endedBy = `status left in_replay on step (${statusName(stepped.response.status)})`;
      break;
    }
    const observed = await request(ws, "observation", { observation: {} }, true);
    observations++;
    observationBytes += observed.bytes;
    const observation = observed.response.observation as Record<string, unknown> | undefined;
    lastLoop = Number((observation?.["observation"] as Record<string, unknown> | undefined)?.["game_loop"] ?? lastLoop);
    const playerResult = observation?.["player_result"];
    if (Array.isArray(playerResult) && playerResult.length > 0) {
      sawResult = true;
      console.log(`  player_result at loop ${lastLoop}: ${JSON.stringify(playerResult)}`);
    }
    if (observed.response.status !== SC2_STATUS.inReplay) {
      endedBy = `status left in_replay on observation (${statusName(observed.response.status)})`;
      break;
    }
  }
  const elapsed = Date.now() - startedAt;
  ws.close();

  console.log("\n=== results ===");
  console.log(`status sequence:          ${statusSeen.join(" -> ")}`);
  console.log(`replay_info from bytes:   ${infoError ?? "accepted"}`);
  console.log(`broken replay reported:   ${refusedError ?? "NOT REFUSED (bad: nonsense was accepted)"}`);
  console.log(`start_replay from bytes:  accepted`);
  console.log(`game_info has terrain:    ${hasTerrain ? "yes" : "NO"}`);
  console.log(`data response:            ${dataBytes} bytes`);
  console.log(`observations:             ${observations} at ${step} loops each, to loop ${lastLoop}`);
  console.log(`observation bytes:        ${observationBytes} total, ${Math.round(observationBytes / Math.max(1, observations))} average`);
  console.log(`player_result in replay:  ${sawResult ? "yes" : "no"}`);
  console.log(`replay ended by:          ${endedBy}`);
  console.log(`wall clock:               ${(elapsed / 1000).toFixed(1)}s for ${lastLoop} loops`);

  const ok = !infoError && refusedError !== null && observations > 0 && endedBy.startsWith("status left");
  console.log(
    ok
      ? "\nThe driver can send the replay as bytes and take its ending from the status."
      : "\nAt least one assumption does not hold; read the lines above before building on them."
  );
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`[probe] ${(err as Error).message}`);
  process.exit(1);
});
