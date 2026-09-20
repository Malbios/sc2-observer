import fs from "node:fs";
import path from "node:path";
import type { UnitSummary } from "../state/frames";
import {
  TELEMETRY_SCHEMA_VERSION,
  type ChannelDeclaration,
  type EventLevel,
  type GridShape,
  type OverlayShape,
  type Point2,
  type TelemetryMessage,
} from "../shared/telemetry-types";

/**
 * Test-data producer for the telemetry contract (plan §3). This is NOT the
 * emitter bots will use -- that one is a stdlib-only Python file and lives
 * with Phase 3, along with the real tailer and retention model under
 * src/telemetry/. This only exists to give the viewer a §3-conformant file
 * on the same loop axis as a real recording, so overlays land on real map
 * coordinates and `entity` messages key off real unit tags.
 *
 * §3.4's non-blocking / background-thread / bounded-buffer requirements are
 * about not stalling a real bot; they do not apply here. Lines are buffered
 * per loop and written with writeSync so a tailer genuinely sees the file
 * grow loop by loop, which is the behaviour Phase 3 needs to test against.
 */

const EMITTER = "testbot/1";

/**
 * A message as the writer hands it over: the envelope's `v` and `seq` are the
 * writer's to assign, everything else is the caller's. Distributes over the
 * union so each `kind` still checks against its own payload type.
 */
type Outgoing<M> = M extends TelemetryMessage ? Omit<M, "v" | "seq"> : never;
type OutgoingMessage = Outgoing<TelemetryMessage>;

/** Cells per side of the synthetic influence map on `test/heat`. */
const GRID_SIZE = 16;
/** Steps between `event` / `snapshot` / `entity` emissions. Series and the
 * main overlay go out every step; the rest would be pure noise at that rate. */
const EVENT_EVERY = 5;
const SNAPSHOT_EVERY = 10;
const ENTITY_EVERY = 2;
/** Entities are one message per (ch, tag), so this caps line volume. */
const ENTITY_LIMIT = 8;

const EVENT_LEVELS: EventLevel[] = ["debug", "info", "warn", "error"];
const ENTITY_TASKS = ["mine", "scout", "defend", "build", "idle"];

export interface Point {
  x: number;
  y: number;
}

export interface TelemetryMapInfo {
  /** Our own townhall position, taken from the first observation. */
  ourStart: Point;
  /** An enemy start location from game_info (SC2 omits our own). */
  enemyStart: Point;
  playableArea: { x0: number; y0: number; x1: number; y1: number };
}

export interface LoopSample {
  loop: number;
  /** How many steps have been taken, used to space out the slower kinds. */
  step: number;
  minerals: number;
  vespene: number;
  foodUsed: number;
  armyCount: number;
  ownUnits: UnitSummary[];
}

/** §3.4: "rounds floats to limit volume". */
function r2(value: number): number {
  return Math.round(value * 100) / 100;
}

function pointPair(p: Point): Point2 {
  return [r2(p.x), r2(p.y)];
}

export class TestTelemetryWriter {
  readonly filePath: string;
  private readonly fd: number;
  private readonly mapInfo: TelemetryMapInfo;
  private pending: string[] = [];
  private seq = 0;
  private lines = 0;
  private snapshotRevision = 0;

  constructor(dir: string, name: string, mapInfo: TelemetryMapInfo, meta: Record<string, unknown>) {
    this.mapInfo = mapInfo;
    fs.mkdirSync(dir, { recursive: true });
    // §3.4: "<data dir>/telemetry/<start timestamp>-<bot-chosen name>.ndjson".
    // Colons and dots are not legal in Windows filenames, so the ISO stamp is
    // stripped down rather than used verbatim.
    const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "");
    this.filePath = path.join(dir, `${stamp}-${name}.ndjson`);
    this.fd = fs.openSync(this.filePath, "a");

    this.push({
      kind: "hello",
      data: {
        emitter: EMITTER,
        name,
        meta,
        // Pre-declaration is optional (§3.2); declared here precisely so the
        // channel tree has something to render before the first use of each.
        channels: [
          { ch: "econ", kind: "series", label: "Economy" },
          { ch: "econ/supply", kind: "series", label: "Supply used", range: [0, 200] },
          { ch: "test/shapes", kind: "overlay", label: "Shapes", visible: true },
          { ch: "test/heat", kind: "overlay", label: "Influence", visible: false },
          { ch: "test/transient", kind: "overlay", label: "Transient", visible: true },
          { ch: "test/log", kind: "event", label: "Log" },
          { ch: "test/plan", kind: "snapshot", label: "Plan" },
          { ch: "test/tasks", kind: "entity", label: "Unit tasks" },
        ],
      },
    });
    this.flush();
  }

  private push(message: OutgoingMessage): void {
    this.pending.push(JSON.stringify({ v: TELEMETRY_SCHEMA_VERSION, seq: this.seq++, ...message }));
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    fs.writeSync(this.fd, `${this.pending.join("\n")}\n`);
    this.lines += this.pending.length;
    this.pending = [];
  }

  /**
   * A 16x16 influence map over the playable area, encoded per §3.3's compact
   * grid option so the b64u8 path gets exercised rather than the plain-array
   * one. Values are a pattern that moves with the loop, so consecutive
   * updates are visibly different.
   */
  private heatGrid(loop: number): GridShape {
    const { x0, y0, x1, y1 } = this.mapInfo.playableArea;
    const cell = r2(Math.max(x1 - x0, y1 - y0) / GRID_SIZE);
    const values = new Uint8Array(GRID_SIZE * GRID_SIZE);
    const t = loop / 200;
    for (let gy = 0; gy < GRID_SIZE; gy++) {
      for (let gx = 0; gx < GRID_SIZE; gx++) {
        values[gy * GRID_SIZE + gx] = Math.round(127 + 127 * Math.sin((gx + gy) * 0.4 + t));
      }
    }
    return {
      type: "grid",
      origin: [r2(x0), r2(y0)],
      cell,
      w: GRID_SIZE,
      h: GRID_SIZE,
      enc: "b64u8",
      // Decoded value = offset + raw * scale, mapping 0-255 onto 0-1.
      scale: 1 / 255,
      offset: 0,
      values: Buffer.from(values).toString("base64"),
    };
  }

  /**
   * §3.3 names the shape vocabulary but not its field names; the spellings
   * live in ../shared/telemetry-types.ts, which both this writer and the
   * viewer's renderer compile against, so the two cannot drift apart.
   */
  private shapes(loop: number): OverlayShape[] {
    const our = this.mapInfo.ourStart;
    const enemy = this.mapInfo.enemyStart;
    const mid = { x: (our.x + enemy.x) / 2, y: (our.y + enemy.y) / 2 };
    const angle = loop / 120;
    return [
      { type: "circle", pos: pointPair(our), r: 6 },
      { type: "line", from: pointPair(our), to: pointPair(enemy) },
      { type: "rect", p0: [r2(our.x - 8), r2(our.y - 8)], p1: [r2(our.x + 8), r2(our.y + 8)] },
      { type: "text", pos: [r2(our.x), r2(our.y + 10)], text: `loop ${loop}` },
      {
        type: "polyline",
        points: [
          pointPair(mid),
          [r2(mid.x + 10 * Math.cos(angle)), r2(mid.y + 10 * Math.sin(angle))],
          [r2(mid.x + 14 * Math.cos(angle + 0.5)), r2(mid.y + 14 * Math.sin(angle + 0.5))],
        ],
      },
    ];
  }

  /** Everything this loop produces, flushed as one write. */
  emitLoop(sample: LoopSample): void {
    const { loop, step } = sample;

    // Two series forms from §3.3: named pairs, and a bare number on a channel
    // that names the series itself.
    this.push({
      kind: "series",
      loop,
      ch: "econ",
      data: [
        { name: "minerals", value: sample.minerals },
        { name: "vespene", value: sample.vespene },
        { name: "army", value: sample.armyCount },
      ],
    });
    this.push({ kind: "series", loop, ch: "econ/supply", data: sample.foodUsed });

    this.push({
      kind: "overlay",
      loop,
      ch: "test/shapes",
      style: { color: "#4fc3f7", width: 1.5, label: "shapes" },
      data: this.shapes(loop),
    });

    if (step % 2 === 0) {
      this.push({
        kind: "overlay",
        loop,
        ch: "test/heat",
        style: { opacity: 0.5, z: -1 },
        data: [this.heatGrid(loop)],
      });
    }

    if (step % ENTITY_EVERY === 0) {
      // One message per (ch, tag): §3.3 retention replaces per-tag, not
      // per-channel, so these cannot be batched into one message.
      for (const [index, unit] of sample.ownUnits.slice(0, ENTITY_LIMIT).entries()) {
        this.push({
          kind: "entity",
          loop,
          ch: "test/tasks",
          data: {
            tag: unit.tag,
            task: ENTITY_TASKS[(index + step) % ENTITY_TASKS.length],
            priority: (index % 3) + 1,
            since: loop,
          },
        });
      }
    }

    if (step % EVENT_EVERY === 0) {
      const index = Math.floor(step / EVENT_EVERY);
      // ttl is described in §3.3 ("until `ttl` loops elapse if `ttl` is set")
      // without pinning where it lives; envelope level, next to `style`,
      // since it is retention rather than payload.
      this.push({
        kind: "overlay",
        loop,
        ch: "test/transient",
        style: { color: "#ff7043" },
        ttl: 40,
        data: [{ type: "point", pos: pointPair(this.mapInfo.enemyStart) }],
      });

      const level = EVENT_LEVELS[index % EVENT_LEVELS.length];
      const positioned = index % 2 === 0;
      this.push({
        kind: "event",
        loop,
        ch: "test/log",
        data: {
          msg: `step ${step}: ${sample.ownUnits.length} own units, ${sample.minerals} minerals`,
          level,
          data: { step, units: sample.ownUnits.length },
          ...(positioned ? { pos: pointPair(this.mapInfo.ourStart) } : {}),
        },
      });
    }

    if (step % SNAPSHOT_EVERY === 0) {
      this.snapshotRevision++;
      this.push({
        kind: "snapshot",
        loop,
        ch: "test/plan",
        data: {
          revision: this.snapshotRevision,
          objective: this.snapshotRevision % 2 === 0 ? "expand" : "defend",
          queue: ENTITY_TASKS.slice(this.snapshotRevision % ENTITY_TASKS.length),
          resources: { minerals: sample.minerals, vespene: sample.vespene },
        },
      });
    }

    this.flush();
  }

  /**
   * §3.4: absence of `end` is not an error, so the abrupt exits (disconnect,
   * hang) deliberately never call this -- that is what makes them useful as
   * the "killed mid-write" case.
   */
  end(reason: string, loop: number): void {
    this.push({ kind: "end", data: { reason, loop, lines: this.lines + this.pending.length + 1 } });
    this.flush();
    fs.closeSync(this.fd);
  }
}
