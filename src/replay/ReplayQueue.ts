import { basename } from "node:path";
import type { EventBus, ReplayProgressEvent } from "../bus/EventBus";
import type { Sc2Connection } from "../protocol/connection";
import type { ConversionIpc } from "../shared/ipc-types";
import { OBSERVER_SLOT, ReplayDriver, type ReplayInfo } from "./ReplayDriver";
import { ReplaySession } from "./ReplaySession";

/**
 * Converts replays into game files, one at a time, every viewpoint of each.
 *
 * SC2 plays a replay from one viewpoint, fixed when it starts, and one view's
 * fog cannot be derived from another's. So a replay is played once from the
 * observer slot, which sees everything, and once as each player, and every
 * pass lands in the same game file under its own viewpoint (schema v4). The
 * game is offered when all of them are done; waiting a few minutes once beats
 * waiting again whenever another view is wanted.
 *
 * The client is one seat, so this runs one pass at a time and only while
 * nothing else holds the client (`clientFree`). Nothing here knows about
 * Electron: the app and the `replay` CLI drive the same queue.
 */
export interface ReplayQueueOptions {
  bus: EventBus;
  connect: () => Promise<Sc2Connection>;
  gamesDir: string;
  readReplay: (path: string) => Uint8Array;
  /** Brings the client up; resolves to the reason it could not, or null. */
  ensureClient?: () => Promise<string | null>;
  /** False while something else (a live session) holds the client. Items
   * then wait, and `kick()` resumes them when it is free again. */
  clientFree?: () => boolean;
  /** Only these viewpoints instead of all of them (the CLI's `--watch`). */
  viewpoints?: number[] | null;
  /** Whose result the file reports; the first participant by default. */
  subjectPlayerId?: number | null;
  /** A fixed file for a single conversion (the CLI's `--out`). */
  outPath?: string;
  stepLoops?: number;
  appVersion?: string;
}

/** The bus session id conversion frames carry, so a live view can ignore
 * them and a replay session records only its own. */
export const CONVERSION_SESSION_ID = "conversion";

interface Item extends ConversionIpc {
  stopRequested: boolean;
}

export class ReplayQueue {
  private readonly options: ReplayQueueOptions;
  private readonly items: Item[] = [];
  private readonly listeners = new Set<() => void>();
  private nextId = 1;
  private running = false;
  private driver: ReplayDriver | null = null;
  /** The recording being written, so its file is known (and kept out of the
   * games list) from its first frame rather than from the end of a pass. */
  private session: ReplaySession | null = null;
  private idleWaiters: (() => void)[] = [];

  constructor(options: ReplayQueueOptions) {
    this.options = options;
    options.bus.on("replayProgress", this.onProgress);
  }

  /** A copy of every item, oldest first, for the list. */
  get conversions(): ConversionIpc[] {
    return this.items.map(({ stopRequested: _stop, ...item }) => ({ ...item }));
  }

  /** Whether a conversion holds the client right now. */
  get isConverting(): boolean {
    return this.items.some((item) => item.state === "converting");
  }

  /** Game files still being written, which must not be opened, exported or
   * deleted yet. */
  get busyFiles(): string[] {
    return this.items
      .filter((item) => item.state === "converting" && item.gameFile !== null)
      .map((item) => item.gameFile!);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  enqueue(paths: string[]): ConversionIpc[] {
    for (const sourcePath of paths) {
      this.items.push({
        id: this.nextId++,
        sourcePath,
        sourceName: basename(sourcePath),
        state: "waiting",
        note: null,
        gameFile: null,
        pass: 0,
        passes: 0,
        loop: 0,
        totalLoops: 0,
        error: null,
        stopRequested: false,
      });
    }
    this.changed();
    this.kick();
    return this.conversions;
  }

  /** A waiting item leaves the queue; a converting one stops, keeping the
   * viewpoints it finished. */
  stop(id: number): void {
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return;
    if (item.state === "waiting") {
      this.items.splice(this.items.indexOf(item), 1);
    } else if (item.state === "converting") {
      item.stopRequested = true;
      this.driver?.stop();
    } else {
      // A finished, failed or stopped row: stopping it again is dismissing it.
      this.items.splice(this.items.indexOf(item), 1);
    }
    this.changed();
  }

  /** Starts working through the queue if it is not already and the client is
   * free. Called on enqueue, and by the app when a live session ends. */
  kick(): void {
    if (this.running) return;
    this.running = true;
    void this.work().finally(() => {
      this.running = false;
      if (!this.items.some((item) => item.state === "waiting" || item.state === "converting")) {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const resolve of waiters) resolve();
      }
    });
  }

  /** Resolves when nothing is waiting or converting (the CLI waits on it). */
  whenIdle(): Promise<void> {
    if (!this.running && !this.items.some((item) => item.state === "waiting" || item.state === "converting")) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Stops everything, for quitting: the current pass ends and the waiting
   * items are dropped. */
  shutdown(): void {
    for (const item of this.items) if (item.state === "waiting") item.state = "stopped";
    const current = this.items.find((item) => item.state === "converting");
    if (current) current.stopRequested = true;
    this.driver?.stop();
    this.options.bus.off("replayProgress", this.onProgress);
  }

  private async work(): Promise<void> {
    for (;;) {
      const item = this.items.find((entry) => entry.state === "waiting");
      if (!item) return;
      if (this.options.clientFree && !this.options.clientFree()) {
        if (item.note !== "waiting for the live session to end") {
          item.note = "waiting for the live session to end";
          this.changed();
        }
        return;
      }
      await this.convert(item);
    }
  }

  private async convert(item: Item): Promise<void> {
    item.state = "converting";
    item.note = "starting the client";
    this.changed();

    const problem = this.options.ensureClient ? await this.options.ensureClient() : null;
    if (problem) return this.fail(item, problem);

    let replayData: Uint8Array;
    try {
      replayData = this.options.readReplay(item.sourcePath);
    } catch (err) {
      return this.fail(item, (err as Error).message);
    }

    item.note = "reading the replay";
    this.changed();
    let info: ReplayInfo;
    const reader = this.newDriver(replayData, OBSERVER_SLOT);
    try {
      info = await reader.readInfo();
    } catch (err) {
      return this.fail(item, (err as Error).message);
    } finally {
      reader.close();
    }

    // The observer first, so the view that sees everything exists even if
    // the rest are stopped, then every player, in id order.
    const all = [OBSERVER_SLOT, ...info.players.map((player) => player.playerId).sort((a, b) => a - b)];
    const passes = [...new Set(this.options.viewpoints ?? all)];
    const subject =
      this.options.subjectPlayerId ?? info.players.find((player) => player.type === "Participant")?.playerId ?? 1;

    const session = new ReplaySession({
      bus: this.options.bus,
      gamesDir: this.options.gamesDir,
      outPath: this.options.outPath,
      sourcePath: item.sourcePath,
      info,
      sessionId: CONVERSION_SESSION_ID,
      subjectPlayerId: subject,
      appVersion: this.options.appVersion,
    });
    session.attach();
    this.session = session;
    item.passes = passes.length;
    item.totalLoops = info.durationLoops;

    let failure: string | null = null;
    for (let index = 0; index < passes.length && !item.stopRequested; index++) {
      const viewpoint = passes[index]!;
      item.pass = index + 1;
      item.loop = 0;
      item.note = "loading the replay";
      this.changed();

      session.setViewpoint(viewpoint);
      const driver = this.newDriver(replayData, viewpoint);
      this.driver = driver;
      try {
        await driver.start();
        item.note = null;
        this.changed();
        await driver.run();
      } catch (err) {
        // Stopping closes the connection under a request in flight, which
        // then rejects: that is the stop, not a failure.
        if (!item.stopRequested) failure = (err as Error).message;
      } finally {
        this.driver = null;
        driver.close();
      }
      item.gameFile = session.gameFile;

      if (failure || item.stopRequested) {
        // A view that was not played to its end is not a view of the game.
        // The one exception is the very first: with nothing else finished,
        // what was recorded is better kept than thrown away.
        if (session.completedViewpoints > 0) session.discardViewpoint(viewpoint);
        else session.completeViewpoint(viewpoint);
        break;
      }
      session.completeViewpoint(viewpoint);
    }

    session.close(failure ? "failed" : item.stopRequested ? "stopped" : undefined);
    this.session = null;
    item.gameFile = session.gameFile;
    item.note = null;
    item.error = failure;
    item.state = failure ? "failed" : item.stopRequested ? "stopped" : "done";
    this.changed();
  }

  private fail(item: Item, problem: string): void {
    item.state = "failed";
    item.note = null;
    item.error = problem;
    this.changed();
  }

  private newDriver(replayData: Uint8Array, viewpoint: number): ReplayDriver {
    return new ReplayDriver({
      bus: this.options.bus,
      sessionId: CONVERSION_SESSION_ID,
      connect: this.options.connect,
      replayData,
      observedPlayerId: viewpoint,
      stepLoops: this.options.stepLoops,
      speed: "max",
    });
  }

  private readonly onProgress = (event: ReplayProgressEvent): void => {
    if (event.sessionId !== CONVERSION_SESSION_ID) return;
    const item = this.items.find((entry) => entry.state === "converting");
    if (!item) return;
    item.loop = event.loop;
    if (event.totalLoops > 0) item.totalLoops = event.totalLoops;
    item.gameFile = this.session?.gameFile ?? item.gameFile;
    this.changed();
  };

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}
