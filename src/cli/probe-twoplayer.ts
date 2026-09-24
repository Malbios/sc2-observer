import { spawn } from "node:child_process";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { decodeResponse, encodeRequest, type Response } from "../protocol/schema";
import { parseArgs } from "./args";

/**
 * Two bots in one game, each on its own SC2 client: the step before building
 * bot-vs-bot into the app, and the tool that compares container layouts for it.
 *
 * It does what the app will do. It creates the game on client 1 over its own
 * connection, then relays each bot to its client over a connection it already
 * holds, because SC2 takes one connection at a time and the game has to be
 * created before either bot arrives. The bots are two test bots started with
 * the ladder flags AI Arena uses, so they join exactly as a ladder bot does.
 *
 * The relay is a pipe and nothing more: every frame goes through unchanged, in
 * order, which is the proxy's contract too, so the layout is all that is
 * being measured.
 *
 * Run with a client already listening on each API port:
 *   node dist/cli/probe-twoplayer.js --map TorchesAIE.SC2Map
 *        [--api-ports 5001,5002] [--start-port 5100] [--loops 2000]
 *        [--games 2] [--host-ip <ip>] [--api-host 127.0.0.1]
 */

const USAGE =
  "Usage: probe-twoplayer --map <MapName.SC2Map> [--api-ports 5001,5002] [--start-port 5100] " +
  "[--loops 2000] [--games 2] [--host-ip <ip>] [--api-host 127.0.0.1]";

/** Where the bots connect: one local port per client, in front of it. */
const RELAY_BASE_PORT = 6001;
const BOT_TIMEOUT_MS = 10 * 60_000;

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

/** A client that is still starting refuses connections for a while. */
async function connect(url: string, timeoutMs = 120_000): Promise<WebSocket> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await openSocket(url);
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`could not connect to ${url}: ${(err as Error).message}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

function request(ws: WebSocket, fields: Record<string, unknown>): Promise<Response> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: Buffer): void => {
      ws.off("close", onClose);
      resolve(decodeResponse(data));
    };
    const onClose = (): void => {
      ws.off("message", onMessage);
      reject(new Error("socket closed while waiting for a response"));
    };
    ws.once("message", onMessage);
    ws.once("close", onClose);
    ws.send(encodeRequest(fields));
  });
}

/**
 * Accepts one bot on `port` and pipes it to `upstream` both ways. The bot's
 * listener is attached before anything is awaited: a frame arriving in a gap
 * is lost with no error on either side (CLAUDE.md, "Traps").
 */
function relay(port: number, upstream: WebSocket): WebSocketServer {
  const server = new WebSocketServer({ host: "127.0.0.1", port, path: "/sc2api" });
  server.on("connection", (bot) => {
    bot.on("message", (data: Buffer) => upstream.send(data));
    upstream.on("message", (data: Buffer) => {
      if (bot.readyState === WebSocket.OPEN) bot.send(data);
    });
    bot.on("close", () => upstream.removeAllListeners("message"));
  });
  return server;
}

interface BotRun {
  label: string;
  exitCode: number | null;
  playerId: string | null;
  lastLoop: string | null;
  result: string | null;
  seconds: number;
  tail: string[];
}

function runBot(label: string, args: string[]): Promise<BotRun> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, "testbot.js"), ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const lines: string[] = [];
    const collect = (chunk: Buffer): void => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) lines.push(line);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill(), BOT_TIMEOUT_MS);
    child.on("exit", (code) => {
      clearTimeout(timer);
      const find = (re: RegExp): string | null => {
        for (let i = lines.length - 1; i >= 0; i--) {
          const match = lines[i]!.match(re);
          if (match) return match[1] ?? null;
        }
        return null;
      };
      resolve({
        label,
        exitCode: code,
        playerId: find(/joined as player (\d+)/),
        lastLoop: find(/(?:at|ended naturally at) loop (\d+)/),
        result: find(/player_result: (.*)$/),
        seconds: (Date.now() - started) / 1000,
        tail: lines.slice(-4),
      });
    });
  });
}

async function playOneGame(
  game: number,
  map: string,
  apiHost: string,
  apiPorts: [number, number],
  startPort: number,
  loops: number,
  hostIp: string | null
): Promise<boolean> {
  console.log(`\n[probe] game ${game}: connecting to both clients`);
  const upstreams = await Promise.all(apiPorts.map((port) => connect(`ws://${apiHost}:${port}/sc2api`)));

  const created = await request(upstreams[0]!, {
    create_game: {
      local_map: { map_path: map },
      player_setup: [{ type: 1 /* Participant */ }, { type: 1 /* Participant */ }],
      realtime: false,
    },
  });
  // Presence, not truthiness: an unset proto2 enum reads as its first value.
  const createResult = created.create_game ?? {};
  if (Object.prototype.hasOwnProperty.call(createResult, "error") || (created.error ?? []).length > 0) {
    console.log(`[probe] create_game refused: ${JSON.stringify(created.toJSON ? created.toJSON() : created)}`);
    upstreams.forEach((ws) => ws.close());
    return false;
  }
  console.log(`[probe] game ${game}: created on client 1 (${apiHost}:${apiPorts[0]})`);

  const relays = upstreams.map((ws, i) => relay(RELAY_BASE_PORT + i, ws));
  const common = ["--LadderServer", "127.0.0.1", "--StartPort", String(startPort), ...(hostIp ? ["--host-ip", hostIp] : [])];
  // One bot surrenders at the loop limit; the other plays on until the game
  // tells it the result, which is how a real opponent would learn it.
  const started = Date.now();
  const runs = await Promise.all([
    runBot("bot 1", [...common, "--GamePort", String(RELAY_BASE_PORT), "--race", "Terran", "--name", "bot1", "--loops", String(loops), "--end", "surrender"]),
    runBot("bot 2", [...common, "--GamePort", String(RELAY_BASE_PORT + 1), "--race", "Zerg", "--name", "bot2", "--loops", "0", "--end", "play"]),
  ]);
  const seconds = (Date.now() - started) / 1000;

  for (const run of runs) {
    console.log(
      `[probe] ${run.label}: exit ${run.exitCode}, player ${run.playerId ?? "-"}, last loop ${run.lastLoop ?? "-"}, ` +
        `result ${run.result ?? "-"}, ${run.seconds.toFixed(1)}s`
    );
    if (run.exitCode !== 0) for (const line of run.tail) console.log(`[probe]     ${line}`);
  }
  console.log(`[probe] game ${game}: ${loops} loops in ${seconds.toFixed(1)}s wall clock`);

  await Promise.all(relays.map((server) => new Promise((resolve) => server.close(resolve))));
  // A finished game leaves both clients in `ended`. Without leaving it, the
  // next game's create_game crashed the host client (seen in layout A).
  for (const [i, ws] of upstreams.entries()) {
    try {
      const left = await request(ws, { leave_game: {} });
      console.log(`[probe] client ${i + 1} left the game: status ${left.status}, errors ${JSON.stringify(left.error ?? [])}`);
    } catch (err) {
      console.log(`[probe] client ${i + 1} leave_game failed: ${(err as Error).message}`);
    }
  }
  upstreams.forEach((ws) => ws.close());
  return runs.every((run) => run.exitCode === 0 && run.playerId !== null);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.map) {
    console.error(USAGE);
    process.exit(1);
  }
  const [a, b] = (args["api-ports"] || "5001,5002").split(",").map(Number);
  const apiPorts: [number, number] = [a!, b!];
  const apiHost = args["api-host"] || "127.0.0.1";
  const startPort = Number(args["start-port"] || 5100);
  const loops = Number(args.loops || 2000);
  const games = Number(args.games || 2);
  const hostIp = args["host-ip"] || null;

  let passed = 0;
  for (let game = 1; game <= games; game++) {
    // Wait for the previous game's sockets to be released by the clients.
    if (game > 1) await new Promise((resolve) => setTimeout(resolve, 2000));
    if (await playOneGame(game, args.map, apiHost, apiPorts, startPort, loops, hostIp)) passed++;
  }
  console.log(`\n[probe] ${passed} of ${games} game(s) completed with both bots joined`);
  process.exit(passed === games ? 0 : 1);
}

main().catch((err) => {
  console.error("[probe] fatal:", err);
  process.exit(1);
});
