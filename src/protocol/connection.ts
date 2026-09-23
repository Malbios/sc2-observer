import WebSocket from "ws";
import { encodeRequest } from "./schema";

/**
 * One request, one response, against the client in the container.
 *
 * This is an interface rather than a class so the replay driver can be driven
 * by canned frames in a test, the way `ClientHost`/`GameHost` let the session
 * controller be tested without Docker (§7). The proxy deliberately does not
 * use it: its relay hands bytes straight through in both directions and must
 * never pair them up.
 */
export interface Sc2Connection {
  /** The encoded `Response` bytes. Protocol-level errors come back in the
   * response, not as exceptions; only a broken socket throws. */
  request(fields: Record<string, unknown>): Promise<Uint8Array>;
  close(): void;
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

class WebSocketConnection implements Sc2Connection {
  constructor(private readonly ws: WebSocket) {}

  request(fields: Record<string, unknown>): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        this.ws.off("message", onMessage);
        this.ws.off("error", onError);
        this.ws.off("close", onClose);
      };
      const onMessage = (data: Buffer): void => {
        cleanup();
        resolve(data);
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error("the client closed the connection"));
      };
      // Attached before the send, never after: a listener added after an
      // await loses frames that arrive in the gap, and `ws` neither buffers
      // them nor complains (CLAUDE.md).
      this.ws.on("message", onMessage);
      this.ws.on("error", onError);
      this.ws.on("close", onClose);
      this.ws.send(encodeRequest(fields));
    });
  }

  close(): void {
    this.ws.close();
  }
}

/** Connects, retrying until the deadline, because a container that has just
 * started refuses connections for a while before it accepts them. */
export async function connectSc2(url: string, timeoutMs = 60_000): Promise<Sc2Connection> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return new WebSocketConnection(await openSocket(url));
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error(`could not connect to ${url} within ${timeoutMs}ms: ${(err as Error).message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}
