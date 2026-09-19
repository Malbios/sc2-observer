"use strict";

// Phase 0 throwaway spike (see the implementation plan, §7 / Phase 0).
//
// Mode A only: this script itself sends `createGame` to SC2 in the
// container (map + one Computer opponent, one open Participant slot),
// then listens on the bot-facing port and forwards every frame between
// the bot and SC2 unchanged, in order, logging each one. It never
// alters, delays, or reorders bot traffic once the bot is connected.

const path = require("path");
const protobuf = require("protobufjs");
const WebSocket = require("ws");

const VENDOR_DIR = path.join(__dirname, "..", "vendor");
const BOT_PORT = 5000; // matches C:\dev\sc2-ai\run.py's hardcoded default
const SC2_HOST = "127.0.0.1";
const SC2_PORT = 5001; // container's published SC2 port (see run-spike.ps1)
const MAP_PATH = "TorchesAIE.SC2Map"; // relative to the container's Maps dir
const SC2_URL = `ws://${SC2_HOST}:${SC2_PORT}/sc2api`;

function loadProto() {
  const root = new protobuf.Root();
  root.resolvePath = (_origin, target) => (path.isAbsolute(target) ? target : path.join(VENDOR_DIR, target));
  root.loadSync(path.join(VENDOR_DIR, "s2clientprotocol", "sc2api.proto"), { keepCase: true });
  return {
    Request: root.lookupType("SC2APIProtocol.Request"),
    Response: root.lookupType("SC2APIProtocol.Response"),
  };
}

const { Request, Response } = loadProto();

function describeFrame(TypeForDecode, buffer) {
  try {
    const msg = TypeForDecode.decode(buffer);
    const oneofField = TypeForDecode === Request ? "request" : "response";
    return msg[oneofField] || "(empty)";
  } catch (err) {
    return `(undecodable: ${err.message})`;
  }
}

function connectSc2() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SC2_URL);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

async function waitForSc2Ready(timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const ws = await connectSc2();
      ws.close();
      return;
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error(`SC2 did not accept a connection within ${timeoutMs}ms: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

async function sendCreateGame() {
  const ws = await connectSc2();

  const request = Request.create({
    create_game: {
      local_map: { map_path: MAP_PATH },
      player_setup: [
        { type: 1 /* Participant */ },
        { type: 2 /* Computer */, race: 2 /* Zerg */, difficulty: 2 /* Easy */ },
      ],
      realtime: false,
    },
  });

  const responsePromise = new Promise((resolve, reject) => {
    ws.once("message", (data) => {
      try {
        resolve(Response.decode(data));
      } catch (err) {
        reject(err);
      }
    });
    ws.once("error", reject);
  });

  ws.send(Request.encode(request).finish());
  const response = await responsePromise;
  ws.close();

  console.log("[spike] createGame response:", JSON.stringify(response.create_game));
  return response;
}

function startProxyServer() {
  const server = new WebSocket.Server({ host: "127.0.0.1", port: BOT_PORT });
  console.log(`[spike] listening for the bot on ws://127.0.0.1:${BOT_PORT}/sc2api`);

  server.on("connection", async (botWs, req) => {
    console.log(`[spike] bot connected (${req.url})`);

    let frameCount = 0;

    // Attach the bot-side listener synchronously, before the `await` below
    // yields control. Otherwise a frame the bot sends while we're still
    // opening the SC2-side connection fires 'message' with nobody listening
    // yet and is silently dropped forever (ws does not buffer for latecomer
    // listeners) -- both sides then wait on each other indefinitely. Buffer
    // anything that arrives before sc2Ws is ready and flush it in order.
    const pending = [];
    let sc2Ws = null;

    botWs.on("message", (data) => {
      if (sc2Ws) {
        frameCount += 1;
        console.log(`[spike] #${frameCount} bot -> sc2  (${data.length}B) ${JSON.stringify(describeFrame(Request, data))}`);
        sc2Ws.send(data);
      } else {
        pending.push(data);
      }
    });

    try {
      sc2Ws = await connectSc2();
    } catch (err) {
      console.error("[spike] failed to open the SC2-side connection:", err.message);
      botWs.close();
      return;
    }

    for (const data of pending.splice(0)) {
      frameCount += 1;
      console.log(`[spike] #${frameCount} bot -> sc2  (${data.length}B, buffered) ${JSON.stringify(describeFrame(Request, data))}`);
      sc2Ws.send(data);
    }

    sc2Ws.on("message", (data) => {
      frameCount += 1;
      console.log(`[spike] #${frameCount} sc2 -> bot  (${data.length}B) ${JSON.stringify(describeFrame(Response, data))}`);
      botWs.send(data);
    });

    const closeBoth = (side) => (code, reason) => {
      console.log(`[spike] ${side} closed (code=${code} reason=${reason})`);
      botWs.close();
      sc2Ws.close();
    };
    botWs.on("close", closeBoth("bot"));
    sc2Ws.on("close", closeBoth("sc2"));

    botWs.on("error", (err) => console.error("[spike] bot socket error:", err.message));
    sc2Ws.on("error", (err) => console.error("[spike] sc2 socket error:", err.message));
  });

  return server;
}

async function main() {
  console.log("[spike] waiting for SC2 to accept connections...");
  await waitForSc2Ready(120_000, 1_000);
  console.log("[spike] SC2 is up. Sending createGame (Mode A)...");
  await sendCreateGame();
  startProxyServer();
}

main().catch((err) => {
  console.error("[spike] fatal:", err);
  process.exit(1);
});
