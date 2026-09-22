/**
 * The global catalog file (§6.2), which holds settings and nothing else.
 *
 * §6.2 chose "SQLite per game + catalog", and the catalog file stays, but
 * there is deliberately no `games` table: every column of a game row is
 * derived from the game file itself (see `peek.ts` for why a cache of them has
 * no workable staleness key), and tags live in the game's own `meta` so they
 * survive the file being copied elsewhere.
 *
 * What is left is the things that belong to the app rather than to any game:
 * the folder the file picker last opened, and in Phase 6 ports, retention and
 * the rest of §7's settings.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

const SCHEMA_VERSION = 1;

/** Ordered and additive, on the same terms as `HistoryStore.MIGRATIONS`:
 * index i takes a file from version i to i+1, and an existing entry is never
 * edited. */
const MIGRATIONS: ((db: Database.Database) => void)[] = [
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  },
];

export class CatalogStore {
  private readonly db: Database.Database;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.migrate();
  }

  /**
   * Unlike a game file, a catalog newer than this build is not refused. It
   * holds preferences: losing one is a preference reset, while refusing to
   * start because of one would make a downgrade unrecoverable without finding
   * and deleting the file by hand.
   */
  private migrate(): void {
    const stored = Number(this.get("schema_version", "meta") ?? 0);
    if (stored >= SCHEMA_VERSION) return;

    this.db.transaction(() => {
      for (let version = stored; version < SCHEMA_VERSION; version++) {
        MIGRATIONS[version]!(this.db);
      }
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run("schema_version", String(SCHEMA_VERSION));
    })();
  }

  private get(key: string, table: "meta" | "settings"): string | undefined {
    const row = this.db.prepare(`SELECT value FROM ${table} WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  getSetting(key: string): string | undefined {
    return this.get(key, "settings");
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  /** Forgetting a setting is not the same as storing an empty one: the caller
   * gets `undefined` back and can apply its own default. */
  clearSetting(key: string): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  close(): void {
    this.db.close();
  }
}
