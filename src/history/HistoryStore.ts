import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import Database from "better-sqlite3";
import type { FrameEvent } from "../bus/EventBus";

const SCHEMA_VERSION = 1;
const BATCH_SIZE = 50;

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
];

export class HistoryStore {
  private readonly db: Database.Database;
  private readonly statements = new Map<string, Database.Statement>();
  private pending: FrameEvent[] = [];
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
    this.pending.push(event);
    if (this.pending.length >= BATCH_SIZE) {
      this.flush();
    }
  }

  flush(): void {
    if (this.pending.length === 0) return;
    const insert = this.stmt("INSERT INTO frames (loop, kind, direction, bytes) VALUES (?, ?, ?, ?)");
    const events = this.pending;
    this.pending = [];
    this.db.transaction(() => {
      for (const event of events) {
        insert.run(event.loop, event.kind, event.direction, brotliCompressSync(event.bytes));
      }
    })();
  }

  /** Reads the nearest response frame of `kind` at or before `loop`. */
  readFrameAtOrBefore(kind: string, loop: number): Uint8Array | undefined {
    const row = this.stmt(
      "SELECT bytes FROM frames WHERE kind = ? AND direction = 'response' AND loop <= ? ORDER BY loop DESC LIMIT 1"
    ).get(kind, loop) as { bytes: Buffer } | undefined;
    return row ? brotliDecompressSync(row.bytes) : undefined;
  }

  getMaxLoop(): number {
    const row = this.stmt("SELECT MAX(loop) as maxLoop FROM frames WHERE kind = 'observation'").get() as
      | { maxLoop: number | null }
      | undefined;
    return row?.maxLoop ?? 0;
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
