import WebSocket, { WebSocketServer } from "ws";
import { EventBus } from "../bus/EventBus";
import { decodeRequest, decodeResponse, encodeRequest } from "../protocol/schema";
import { classifyRequest, classifyResponse, LoopTracker } from "../state/frames";

export interface GameProxyOptions {
  sessionId: string;
  bus: EventBus;
  mapPath: string;
  botHost?: string;
  botPort?: number;
  sc2Host?: string;
  sc2Port?: number;
}

/**
 * Mode A only (see the implementation plan §1/§4): this proxy itself sends
 * `createGame`, then listens for the bot and relays every frame between the
 * bot and SC2 unchanged, in order, publishing each one to the event bus. It
 * never alters, delays, or reorders bot traffic once the bot is connected.
 */
export class GameProxy {
  private readonly sessionId: string;
  private readonly bus: EventBus;
  private readonly mapPath: string;
  private readonly botHost: string;
  private readonly botPort: number;
  private readonly sc2Host: string;
  private readonly sc2Port: number;
  private readonly loopTracker = new LoopTracker();
  private server: WebSocketServer | null = null;
  private storedOnceKinds = new Set<string>();

  constructor(options: GameProxyOptions) {
    this.sessionId = options.sessionId;
    this.bus = options.bus;
    this.mapPath = options.mapPath;
    this.botHost = options.botHost ?? "127.0.0.1";
    this.botPort = options.botPort ?? 5000;
    this.sc2Host = options.sc2Host ?? "127.0.0.1";
    this.sc2Port = options.sc2Port ?? 5001;
  }

  private get sc2Url(): string {
    return `ws://${this.sc2Host}:${this.sc2Port}/sc2api`;
  }

  private connectSc2(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.sc2Url);
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
  }

  private async waitForSc2Ready(timeoutMs = 120_000, intervalMs = 1_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const ws = await this.connectSc2();
        ws.close();
        return;
      } catch (err) {
        if (Date.now() > deadline) {
          throw new Error(`SC2 did not accept a connection within ${timeoutMs}ms: ${(err as Error).message}`);
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
  }

  private async sendCreateGame(): Promise<void> {
    const ws = await this.connectSc2();

    const responsePromise = new Promise<Uint8Array>((resolve, reject) => {
      ws.once("message", (data: Buffer) => resolve(data));
      ws.once("error", reject);
    });

    ws.send(
      encodeRequest({
        create_game: {
          local_map: { map_path: this.mapPath },
          player_setup: [
            { type: 1 /* Participant */ },
            { type: 2 /* Computer */, race: 2 /* Zerg */, difficulty: 2 /* Easy */ },
          ],
          realtime: false,
        },
      })
    );

    const responseBytes = await responsePromise;
    ws.close();

    const response = decodeResponse(responseBytes);
    if (response.error && response.error.length > 0) {
      throw new Error(`createGame failed: ${JSON.stringify(response.error)}`);
    }
  }

  private publishResponse(bytes: Uint8Array): void {
    const decoded = decodeResponse(bytes);
    const loop = this.loopTracker.observe(decoded);
    const kind = classifyResponse(decoded);
    // gameInfo and data are static for the whole game (§6.3: "gameInfo and
    // data appear once") but some bots re-request them every step; only the
    // first copy is worth persisting.
    const storeOnce = kind === "gameInfo" || kind === "data";
    const alreadyStored = kind !== null && this.storedOnceKinds.has(kind);
    if (kind && !(storeOnce && alreadyStored)) {
      this.bus.emit("frame", { sessionId: this.sessionId, loop, kind, direction: "response", bytes });
      if (storeOnce) this.storedOnceKinds.add(kind);
    }

    const playerResult = decoded.observation?.player_result;
    if (Array.isArray(playerResult) && playerResult.length > 0) {
      this.bus.emit("gameEnded", { sessionId: this.sessionId, loop });
    }
  }

  private publishRequest(bytes: Uint8Array): void {
    const decoded = decodeRequest(bytes);
    const kind = classifyRequest(decoded);
    if (kind) {
      this.bus.emit("frame", { sessionId: this.sessionId, loop: this.loopTracker.loop, kind, direction: "request", bytes });
    }
  }

  async start(): Promise<void> {
    await this.waitForSc2Ready();
    await this.sendCreateGame();

    this.server = new WebSocketServer({ host: this.botHost, port: this.botPort });

    this.server.on("connection", async (botWs) => {
      // Attach the bot-side listener synchronously, before the `await`
      // below yields control. A frame arriving during that window would
      // otherwise fire 'message' with nobody listening yet and be silently
      // dropped forever (ws does not buffer for latecomer listeners),
      // hanging both sides -- found and fixed in the Phase 0 spike.
      const pending: Buffer[] = [];
      let sc2Ws: WebSocket | null = null;

      botWs.on("message", (data: Buffer) => {
        this.publishRequest(data);
        if (sc2Ws) {
          sc2Ws.send(data);
        } else {
          pending.push(data);
        }
      });

      try {
        sc2Ws = await this.connectSc2();
      } catch (err) {
        botWs.close();
        return;
      }

      for (const data of pending.splice(0)) {
        sc2Ws.send(data);
      }

      sc2Ws.on("message", (data: Buffer) => {
        this.publishResponse(data);
        botWs.send(data);
      });

      const closeBoth = () => {
        botWs.close();
        sc2Ws?.close();
      };
      botWs.on("close", closeBoth);
      sc2Ws.on("close", closeBoth);
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }
}
