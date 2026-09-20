import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import Database from "better-sqlite3";
import type { FrameEvent } from "../bus/EventBus";

const SCHEMA_VERSION = 1;
const BATCH_SIZE = 50;

export class HistoryStore {
  private readonly db: Database.Database;
  private pending: FrameEvent[] = [];

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS frames (
        loop INTEGER NOT NULL,
        kind TEXT NOT NULL,
        direction TEXT NOT NULL,
        bytes BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_frames_kind_loop ON frames (kind, loop);
    `);
    this.setMeta("schema_version", String(SCHEMA_VERSION));
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
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
    const insert = this.db.prepare("INSERT INTO frames (loop, kind, direction, bytes) VALUES (?, ?, ?, ?)");
    const insertMany = this.db.transaction((events: FrameEvent[]) => {
      for (const event of events) {
        insert.run(event.loop, event.kind, event.direction, brotliCompressSync(event.bytes));
      }
    });
    insertMany(this.pending);
    this.pending = [];
  }

  /** Reads the nearest response frame of `kind` at or before `loop`. */
  readFrameAtOrBefore(kind: string, loop: number): Uint8Array | undefined {
    const row = this.db
      .prepare("SELECT bytes FROM frames WHERE kind = ? AND direction = 'response' AND loop <= ? ORDER BY loop DESC LIMIT 1")
      .get(kind, loop) as { bytes: Buffer } | undefined;
    return row ? brotliDecompressSync(row.bytes) : undefined;
  }

  getMaxLoop(): number {
    const row = this.db.prepare("SELECT MAX(loop) as maxLoop FROM frames WHERE kind = 'observation'").get() as
      | { maxLoop: number | null }
      | undefined;
    return row?.maxLoop ?? 0;
  }

  close(): void {
    this.flush();
    this.db.close();
  }
}
