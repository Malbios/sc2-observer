import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from "node:zlib";
import Database from "better-sqlite3";
import type { FrameEvent } from "../bus/EventBus";
import type {
  ChannelDeclaration,
  ChannelMessage,
  EventIpc,
  EventFilterIpc,
  EventLevel,
  Point2,
  SeriesDataIpc,
  TelemetryKind,
  TelemetryStyle,
} from "../shared/telemetry-types";

/** The schema this build writes and understands. Exported so the catalog can
 * say "this file is newer than me" without opening it through the store,
 * which would try to migrate it. */
export const SCHEMA_VERSION = 3;
const BATCH_SIZE = 50;
/** §6.4 asks for "one transaction per second (or per 50 events)". */
const FLUSH_INTERVAL_MS = 1000;

/**
 * Brotli quality for everything the store writes. The default, 11, is far too
 * slow for a flush that runs on the main thread: on a real ladder game's
 * observations (90 to 110 KB raw) it took 43 to 70 ms each, so a second's
 * batch at full replay speed froze the app for over a second. Quality 5 took
 * 1.3 to 2.1 ms for about 6% more bytes. Telemetry's many small JSON documents
 * compress nearly as well at 5 too. Reading is the same at any quality, so
 * files written at 11 open unchanged.
 */
const BROTLI_FAST = { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } };

function compressJson(value: unknown): Buffer {
  return brotliCompressSync(Buffer.from(JSON.stringify(value ?? null), "utf8"), BROTLI_FAST);
}

function decompressJson(blob: Buffer): unknown {
  return JSON.parse(brotliDecompressSync(blob).toString("utf8"));
}

/**
 * Ordered, additive migrations. Index i takes a file from version i to i+1,
 * so `MIGRATIONS.length` must equal SCHEMA_VERSION. Each one runs inside the
 * transaction that also stamps the new version, so a failed migration leaves
 * the file at its old version rather than half-upgraded.
 *
 * Everything here is `IF NOT EXISTS` on purpose: `schema_version` was stamped
 * unconditionally on every open before versioning existed, so files written by
 * earlier builds already claim version 1 and must not be re-created.
 */
const MIGRATIONS: ((db: Database.Database) => void)[] = [
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS frames (
        loop INTEGER NOT NULL,
        kind TEXT NOT NULL,
        direction TEXT NOT NULL,
        bytes BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_frames_kind_loop ON frames (kind, loop);
    `);
  },
  // v2: telemetry (plan §6.3). `series` and `events` are denormalized out of
  // the messages already in `telemetry` so charting and log filtering are
  // indexed queries rather than a decompress-and-scan of every row.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS streams (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        source_path TEXT NOT NULL,
        emitter TEXT,
        meta TEXT,
        channels TEXT,
        first_loop INTEGER,
        last_loop INTEGER,
        attached_at TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        rejected_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS telemetry (
        stream_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        loop INTEGER NOT NULL,
        ch TEXT NOT NULL,
        kind TEXT NOT NULL,
        style TEXT,
        ttl INTEGER,
        data BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_telemetry_ch_loop ON telemetry (ch, loop);
      CREATE INDEX IF NOT EXISTS idx_telemetry_loop ON telemetry (loop, seq);
      CREATE TABLE IF NOT EXISTS series (
        stream_id INTEGER NOT NULL,
        ch TEXT NOT NULL,
        name TEXT NOT NULL,
        loop INTEGER NOT NULL,
        value REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_series_ch_name_loop ON series (ch, name, loop);
      CREATE TABLE IF NOT EXISTS events (
        stream_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        loop INTEGER NOT NULL,
        ch TEXT NOT NULL,
        level TEXT NOT NULL,
        msg TEXT NOT NULL,
        pos_x REAL,
        pos_y REAL,
        data TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_loop ON events (loop, seq);
      CREATE TABLE IF NOT EXISTS checkpoints (
        loop INTEGER PRIMARY KEY,
        state BLOB NOT NULL
      );
    `);
  },
  // v3: which player a telemetry file belongs to, in a game between two bots.
  // NULL is the one bot of every other game, which is every file before this.
  (db) => {
    db.exec(`ALTER TABLE streams ADD COLUMN seat INTEGER`);
  },
];

export interface StreamInfo {
  name: string;
  sourcePath: string;
  emitter: string | null;
  meta: Record<string, unknown> | null;
  channels: ChannelDeclaration[] | null;
  /** The player this file belongs to in a game between two bots; null in
   * every other game. */
  seat?: number | null;
}

export interface StreamRow extends StreamInfo {
  id: number;
  firstLoop: number | null;
  lastLoop: number | null;
  attachedAt: string;
  messageCount: number;
  rejectedCount: number;
}

/** One `telemetry` row, decompressed. */
export interface StoredTelemetry {
  streamId: number;
  seq: number;
  loop: number;
  ch: string;
  kind: TelemetryKind;
  style: TelemetryStyle | null;
  ttl: number | null;
  data: unknown;
}

interface TelemetryRow {
  streamId: number;
  seq: number;
  loop: number;
  ch: string;
  kind: string;
  style: string | null;
  ttl: number | null;
  data: Buffer;
}
interface SeriesRow {
  streamId: number;
  ch: string;
  name: string;
  loop: number;
  value: number;
}
interface EventRow {
  streamId: number;
  seq: number;
  loop: number;
  ch: string;
  level: string;
  msg: string;
  posX: number | null;
  posY: number | null;
  data: string | null;
}

/**
 * A `series` message may carry a bare number instead of named pairs, in which
 * case "`ch` names the series itself" (§3.3). The chart still needs a label,
 * so the channel's last path segment becomes the name: `econ/supply` charts as
 * "supply".
 */
function seriesNameForChannel(ch: string): string {
  const segments = ch.split("/");
  return segments[segments.length - 1] || ch;
}

export class HistoryStore {
  private readonly db: Database.Database;
  private readonly statements = new Map<string, Database.Statement>();
  private pendingFrames: FrameEvent[] = [];
  private pendingTelemetry: TelemetryRow[] = [];
  private pendingSeries: SeriesRow[] = [];
  private pendingEvents: EventRow[] = [];
  private lastFlushAt = Date.now();
  private closed = false;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    // `meta` has to exist before anything else, since it holds the version
    // that decides what else to create.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.migrate();
  }

  /**
   * Brings the file up to SCHEMA_VERSION, or refuses it. A file written by a
   * newer build is not something this one can read safely: the tables it does
   * not know about are the least of it, since a newer build may also have
   * changed what the tables it *does* know about mean.
   */
  private migrate(): void {
    const stored = Number(this.getMeta("schema_version") ?? 0);
    if (stored > SCHEMA_VERSION) {
      this.db.close();
      throw new Error(
        `schema_version ${stored} is newer than this build understands (${SCHEMA_VERSION}); ` +
          "open it with a newer build of Spectator."
      );
    }
    if (stored === SCHEMA_VERSION) return;

    this.db.transaction(() => {
      for (let version = stored; version < SCHEMA_VERSION; version++) {
        MIGRATIONS[version]!(this.db);
      }
      this.setMeta("schema_version", String(SCHEMA_VERSION));
    })();
  }

  /**
   * Prepared statements are reusable and preparing is not free. Scrubbing the
   * timeline issues several reads per frame, so every query goes through here
   * rather than re-preparing at each call site.
   */
  private stmt(sql: string): Database.Statement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  setMeta(key: string, value: string): void {
    this.stmt("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  getMeta(key: string): string | undefined {
    const row = this.stmt("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  recordFrame(event: FrameEvent): void {
    this.pendingFrames.push(event);
    this.maybeFlush();
  }

  // -- telemetry writes ------------------------------------------------------

  createStream(info: StreamInfo): number {
    const result = this
      .stmt(
        "INSERT INTO streams (name, source_path, emitter, meta, channels, attached_at, seat) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        info.name,
        info.sourcePath,
        info.emitter,
        info.meta ? JSON.stringify(info.meta) : null,
        info.channels ? JSON.stringify(info.channels) : null,
        new Date().toISOString(),
        info.seat ?? null
      );
    return Number(result.lastInsertRowid);
  }

  /**
   * How many telemetry files are attached to this game. Kept as a query rather
   * than a counter because streams can be added and removed by more than one
   * caller, and a stale count decides whether checkpoints mean anything.
   */
  streamCount(): number {
    return (this.stmt("SELECT COUNT(*) AS n FROM streams").get() as { n: number }).n;
  }

  updateStream(id: number, counts: { firstLoop: number | null; lastLoop: number | null; messageCount: number; rejectedCount: number }): void {
    this.stmt(
      "UPDATE streams SET first_loop = ?, last_loop = ?, message_count = ?, rejected_count = ? WHERE id = ?"
    ).run(counts.firstLoop, counts.lastLoop, counts.messageCount, counts.rejectedCount, id);
  }

  /**
   * Buffers one message. Every message lands in `telemetry` as received (§6.3);
   * `series` and `event` additionally fan out into their denormalized tables,
   * which is what makes charting and log filtering indexed rather than a scan
   * over compressed blobs.
   *
   * `seq` is optional in the contract (§3.2), so callers pass a fallback -- the
   * line number, for a file -- to keep ordering within a loop stable.
   */
  recordTelemetry(streamId: number, message: ChannelMessage, fallbackSeq: number): void {
    const seq = message.seq ?? fallbackSeq;
    this.pendingTelemetry.push({
      streamId,
      seq,
      loop: message.loop,
      ch: message.ch,
      kind: message.kind,
      style: message.style ? JSON.stringify(message.style) : null,
      ttl: message.ttl ?? null,
      data: compressJson(message.data),
    });

    if (message.kind === "series") {
      const pairs =
        typeof message.data === "number"
          ? [{ name: seriesNameForChannel(message.ch), value: message.data }]
          : message.data;
      for (const pair of pairs) {
        this.pendingSeries.push({ streamId, ch: message.ch, name: pair.name, loop: message.loop, value: pair.value });
      }
    } else if (message.kind === "event") {
      const pos = message.data.pos ?? null;
      this.pendingEvents.push({
        streamId,
        seq,
        loop: message.loop,
        ch: message.ch,
        level: message.data.level ?? "info",
        msg: message.data.msg,
        posX: pos ? pos[0] : null,
        posY: pos ? pos[1] : null,
        data: message.data.data ? JSON.stringify(message.data.data) : null,
      });
    }

    this.maybeFlush();
  }

  recordCheckpoint(loop: number, state: unknown): void {
    this.stmt("INSERT INTO checkpoints (loop, state) VALUES (?, ?) ON CONFLICT(loop) DO UPDATE SET state = excluded.state").run(
      loop,
      compressJson(state)
    );
  }

  private get pendingCount(): number {
    return this.pendingFrames.length + this.pendingTelemetry.length + this.pendingSeries.length + this.pendingEvents.length;
  }

  private maybeFlush(): void {
    if (this.pendingCount >= BATCH_SIZE || Date.now() - this.lastFlushAt >= FLUSH_INTERVAL_MS) {
      this.flush();
    }
  }

  /** One transaction across every buffer, so a crash leaves a file that is
   * consistent rather than one where a series row outlived its message. */
  flush(): void {
    if (this.pendingCount === 0) {
      this.lastFlushAt = Date.now();
      return;
    }
    const frames = this.pendingFrames;
    const telemetry = this.pendingTelemetry;
    const series = this.pendingSeries;
    const events = this.pendingEvents;
    this.pendingFrames = [];
    this.pendingTelemetry = [];
    this.pendingSeries = [];
    this.pendingEvents = [];

    const insertFrame = this.stmt("INSERT INTO frames (loop, kind, direction, bytes) VALUES (?, ?, ?, ?)");
    const insertTelemetry = this.stmt(
      "INSERT INTO telemetry (stream_id, seq, loop, ch, kind, style, ttl, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const insertSeries = this.stmt("INSERT INTO series (stream_id, ch, name, loop, value) VALUES (?, ?, ?, ?, ?)");
    const insertEvent = this.stmt(
      "INSERT INTO events (stream_id, seq, loop, ch, level, msg, pos_x, pos_y, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );

    this.db.transaction(() => {
      for (const event of frames) {
        insertFrame.run(event.loop, event.kind, event.direction, brotliCompressSync(event.bytes, BROTLI_FAST));
      }
      for (const row of telemetry) {
        insertTelemetry.run(row.streamId, row.seq, row.loop, row.ch, row.kind, row.style, row.ttl, row.data);
      }
      for (const row of series) {
        insertSeries.run(row.streamId, row.ch, row.name, row.loop, row.value);
      }
      for (const row of events) {
        insertEvent.run(row.streamId, row.seq, row.loop, row.ch, row.level, row.msg, row.posX, row.posY, row.data);
      }
    })();
    this.lastFlushAt = Date.now();
  }

  /** Reads the nearest response frame of `kind` at or before `loop`. */
  readFrameAtOrBefore(kind: string, loop: number): Uint8Array | undefined {
    const row = this.stmt(
      "SELECT bytes FROM frames WHERE kind = ? AND direction = 'response' AND loop <= ? ORDER BY loop DESC LIMIT 1"
    ).get(kind, loop) as { bytes: Buffer } | undefined;
    return row ? brotliDecompressSync(row.bytes) : undefined;
  }

  /** Every frame of one kind and direction, in the order it was recorded.
   * Requests are read this way rather than per loop: what a bot asked for is
   * a history to replay forward, not a state to look up. */
  readFrames(kind: string, direction: "request" | "response"): { loop: number; bytes: Uint8Array }[] {
    const rows = this.stmt(
      "SELECT loop, bytes FROM frames WHERE kind = ? AND direction = ? ORDER BY loop, rowid"
    ).all(kind, direction) as { loop: number; bytes: Buffer }[];
    return rows.map((row) => ({ loop: row.loop, bytes: brotliDecompressSync(row.bytes) }));
  }

  getMaxLoop(): number {
    const row = this.stmt("SELECT MAX(loop) as maxLoop FROM frames WHERE kind = 'observation'").get() as
      | { maxLoop: number | null }
      | undefined;
    return row?.maxLoop ?? 0;
  }

  // -- telemetry reads -------------------------------------------------------

  getStreams(): StreamRow[] {
    const rows = this.stmt("SELECT * FROM streams ORDER BY id").all() as Record<string, any>[];
    return rows.map((row) => ({
      id: row["id"],
      name: row["name"],
      sourcePath: row["source_path"],
      emitter: row["emitter"],
      meta: row["meta"] ? JSON.parse(row["meta"]) : null,
      channels: row["channels"] ? JSON.parse(row["channels"]) : null,
      seat: row["seat"] ?? null,
      firstLoop: row["first_loop"],
      lastLoop: row["last_loop"],
      attachedAt: row["attached_at"],
      messageCount: row["message_count"],
      rejectedCount: row["rejected_count"],
    }));
  }

  /** Messages in `(afterLoop, throughLoop]`, in the order they must be
   * replayed to resolve retention. `afterLoop` is exclusive so a checkpoint's
   * own loop is not applied twice. */
  readTelemetryRange(afterLoop: number, throughLoop: number): StoredTelemetry[] {
    const rows = this.stmt(
      "SELECT stream_id, seq, loop, ch, kind, style, ttl, data FROM telemetry WHERE loop > ? AND loop <= ? ORDER BY loop, seq"
    ).all(afterLoop, throughLoop) as Record<string, any>[];
    return rows.map((row) => ({
      streamId: row["stream_id"],
      seq: row["seq"],
      loop: row["loop"],
      ch: row["ch"],
      kind: row["kind"],
      style: row["style"] ? JSON.parse(row["style"]) : null,
      ttl: row["ttl"],
      data: decompressJson(row["data"]),
    }));
  }

  /** Highest loop any telemetry message carries, or null if there is none.
   * The timeline's range is the later of this and the last frame: telemetry
   * can outlive the frames, and a loop you cannot scrub to is a loop whose
   * messages are stored and unreachable. */
  getTelemetryMaxLoop(): number | null {
    const row = this.stmt("SELECT MAX(loop) AS m FROM telemetry").get() as { m: number | null };
    return row.m;
  }

  /**
   * Removes a stream and everything that came in through it, in one
   * transaction: a half-removed stream would leave a chart with values whose
   * messages no longer exist.
   *
   * Checkpoints are not this method's business, but they are wrong the moment
   * a stream leaves, so nothing should call this directly. `detachStream` in
   * `telemetry/detach.ts` is the way in (§3.5).
   *
   * Returns false when there is no such stream, which is what a second click
   * on a row that has already gone looks like.
   */
  deleteStream(id: number): boolean {
    // Anything still buffered belongs to the file as it was before the
    // detach, and writing it afterwards would put some of the stream back.
    this.flush();
    return this.db.transaction((): boolean => {
      const existing = this.stmt("SELECT 1 AS present FROM streams WHERE id = ?").get(id);
      if (existing === undefined) return false;
      for (const table of ["telemetry", "series", "events"]) {
        this.db.prepare(`DELETE FROM ${table} WHERE stream_id = ?`).run(id);
      }
      this.stmt("DELETE FROM streams WHERE id = ?").run(id);
      return true;
    })();
  }

  /**
   * Throws away every checkpoint. They are a cache of the resolved state, so
   * this only costs time: `TelemetryResolver` falls back to replaying from the
   * first message. Called when a checkpoint's meaning changes underneath it,
   * which is whenever the set of streams in the file does.
   */
  clearCheckpoints(): void {
    this.stmt("DELETE FROM checkpoints").run();
  }

  readCheckpointAtOrBefore(loop: number): { loop: number; state: unknown } | undefined {
    const row = this.stmt("SELECT loop, state FROM checkpoints WHERE loop <= ? ORDER BY loop DESC LIMIT 1").get(loop) as
      | { loop: number; state: Buffer }
      | undefined;
    return row ? { loop: row.loop, state: decompressJson(row.state) } : undefined;
  }

  /** Every distinct channel that has actually been written to, with the kind
   * it was written as. The channel tree is built from this plus whatever
   * `hello` pre-declared, so an undeclared channel still appears (§3.2). */
  getTelemetryChannels(): { ch: string; kind: TelemetryKind }[] {
    return this.stmt("SELECT DISTINCT ch, kind FROM telemetry ORDER BY ch, kind").all() as {
      ch: string;
      kind: TelemetryKind;
    }[];
  }

  getSeriesNames(): { ch: string; name: string }[] {
    return this.stmt("SELECT DISTINCT ch, name FROM series ORDER BY ch, name").all() as { ch: string; name: string }[];
  }

  /** Parallel arrays, which is uPlot's native input format. */
  readSeries(ch: string, name: string): SeriesDataIpc {
    const rows = this.stmt("SELECT loop, value FROM series WHERE ch = ? AND name = ? ORDER BY loop").all(ch, name) as {
      loop: number;
      value: number;
    }[];
    const loops = new Array<number>(rows.length);
    const values = new Array<number>(rows.length);
    for (let i = 0; i < rows.length; i++) {
      loops[i] = rows[i]!.loop;
      values[i] = rows[i]!.value;
    }
    return { ch, name, loops, values };
  }

  /**
   * §6.3 calls for full-text search on `msg`. FTS5 availability in this
   * better-sqlite3 build is unverified and a game produces hundreds of events,
   * not millions, so a LIKE scan is the honest choice until volume argues
   * otherwise.
   */
  readEvents(filter: EventFilterIpc = {}): EventIpc[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.ch) {
      where.push("ch = ?");
      params.push(filter.ch);
    }
    if (filter.levels && filter.levels.length > 0) {
      where.push(`level IN (${filter.levels.map(() => "?").join(", ")})`);
      params.push(...filter.levels);
    }
    if (filter.text) {
      where.push("msg LIKE ? ESCAPE '\\'");
      params.push(`%${filter.text.replace(/[\\%_]/g, "\\$&")}%`);
    }
    const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    const limit = filter.limit ?? 5000;
    const rows = this.stmt(
      `SELECT seq, loop, ch, level, msg, pos_x, pos_y, data FROM events${clause} ORDER BY loop, seq LIMIT ?`
    ).all(...params, limit) as Record<string, any>[];
    return rows.map((row) => ({
      seq: row["seq"],
      loop: row["loop"],
      ch: row["ch"],
      level: row["level"] as EventLevel,
      msg: row["msg"],
      pos: row["pos_x"] === null ? null : ([row["pos_x"], row["pos_y"]] as Point2),
      data: row["data"] ? JSON.parse(row["data"]) : null,
    }));
  }

  /** Safe to call twice: ipc.ts closes the previous store before opening a
   * new one, and better-sqlite3 throws on a double close. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.flush();
    this.statements.clear();
    this.db.close();
  }
}
