import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { EventBus } from "../bus/EventBus";
import type { HistoryStore } from "../history/HistoryStore";
import { telemetryRefusal } from "./attachRule";
import { StreamIngest } from "./ingest";

/**
 * Watches a folder of NDJSON telemetry files and feeds whatever lands there
 * into the open recording (§3.4).
 *
 * Polling is the ground truth and `fs.watch` is only an accelerator, per §5.
 * A file being appended to by another process is exactly the case `fs.watch`
 * handles worst: the OS may coalesce many appends into one event, deliver it
 * late, or on some filesystems not deliver it at all. A poll that finds
 * nothing costs one `stat` per file, so the safe thing is also the cheap one.
 *
 * Nothing here knows what a bot is. It reads bytes, hands complete lines to
 * the same StreamIngest the import CLI uses, and says "there is more".
 *
 * A game holds one telemetry file (attachRule.ts), so the tailer adopts the
 * first new file it finds while the game has none, and leaves every other
 * file alone.
 */

const POLL_INTERVAL_MS = 150;
const TELEMETRY_EXTENSION = ".ndjson";

/**
 * Cap on how much of one file a single poll will read. A folder may already
 * hold a finished 20 MB file when watching starts, and reading it in one go
 * would block the main process (and with it the whole UI) for as long as it
 * takes to parse. Slicing it costs a few extra polls and keeps the app alive.
 */
const MAX_READ_BYTES = 1 << 20;

interface WatchedFile {
  filePath: string;
  /** Bytes consumed so far. The resume point for the next read. */
  offset: number;
  /** A trailing line the last read cut in half, held until its newline turns up. */
  partial: string;
  /** Holds an incomplete UTF-8 sequence when a read lands mid-character. */
  decoder: StringDecoder;
  lineNo: number;
  ingest: StreamIngest;
}

export interface TailedFileStatus {
  path: string;
  name: string;
  messageCount: number;
  rejectedCount: number;
  lastLoop: number | null;
}

export interface TailerStatus {
  dir: string;
  files: TailedFileStatus[];
  /** Files in the folder that are deliberately not being read; see `skipped`. */
  skippedCount: number;
}

export class TelemetryTailer {
  /** The one file being read into the game, once one has been adopted. */
  private file: WatchedFile | null = null;
  /**
   * Files this tailer will not touch: in the ignore list, found while the game
   * already had telemetry, or truncated underneath it. Each would put a second
   * file's rows into the game or corrupt the first's, and each is sticky, so
   * it is decided once rather than per poll.
   */
  private readonly skipped = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private watcher: fs.FSWatcher | null = null;
  /** fs.watch can fire while a poll is mid-read; one poll at a time. */
  private polling = false;

  /**
   * @param ignorePaths files to leave alone however they change (§3.5). A
   * live game attaches by arrival: the folder still holds every earlier run's
   * file, and reading those would fill this game with another game's
   * telemetry on another game's loop axis. Naming them outright is the whole
   * mechanism, and it deliberately involves no clock. The obvious
   * alternative, "ignore anything not written since now", compares a
   * millisecond timestamp against a file mtime the filesystem keeps to about
   * 16ms on Windows, so a file the bot creates in the same instant is
   * sometimes seen as old and dropped for the rest of the game. That was
   * caught as a test that passed and failed on alternate runs.
   *
   * Watching a folder by hand passes the folder's current files too, so it
   * also adopts the first file written after it starts rather than an old run.
   */
  constructor(
    private readonly store: HistoryStore,
    private readonly bus: EventBus,
    readonly dir: string,
    ignorePaths: readonly string[] = []
  ) {
    for (const filePath of ignorePaths) this.skipped.add(this.key(filePath));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    // A forgotten tailer must not be the reason the process stays alive.
    this.timer.unref();
    try {
      this.watcher = fs.watch(this.dir, () => this.poll());
    } catch {
      // Accelerator only. Losing it costs latency, never data.
      this.watcher = null;
    }
    this.poll();
  }

  /**
   * Stops watching and closes every stream properly, which is what writes the
   * final checkpoint. Safe to call twice, because both quitting and opening
   * another recording go through here.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.watcher?.close();
    this.watcher = null;
    this.file?.ingest.finish();
  }

  status(): TailerStatus {
    const files: TailedFileStatus[] = [];
    if (this.file) {
      const summary = this.file.ingest.summary();
      files.push({
        path: this.file.filePath,
        name: summary.name,
        messageCount: summary.messageCount,
        rejectedCount: summary.rejectedCount,
        lastLoop: summary.lastLoop,
      });
    }
    return { dir: this.dir, files, skippedCount: this.skipped.size };
  }

  /** Windows paths are case-insensitive, so the identity of a file is its
   * resolved path folded to one case there and left alone elsewhere. */
  private key(filePath: string): string {
    const resolved = path.resolve(filePath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  /**
   * Reads whatever is new across the folder. Public because the timer is not
   * the only thing that should be able to ask: fs.watch drives it, and a test
   * drives it directly so that "does a half-written line survive" is a
   * question about bytes rather than about timing.
   */
  poll(): void {
    if (this.polling) return;
    this.polling = true;
    try {
      let appended = false;
      for (const filePath of this.listFiles()) {
        if (this.consume(filePath)) appended = true;
      }
      if (!appended || !this.file) return;

      this.file.ingest.settle();
      const { messageCount, lastLoop } = this.file.ingest.summary();
      // One transaction for the whole poll, and only then the announcement:
      // a listener that re-queries must not be able to beat the rows in.
      this.store.flush();
      this.bus.emit("telemetry", { dir: this.dir, messageCount, lastLoop });
    } finally {
      this.polling = false;
    }
  }

  private listFiles(): string[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      // The folder can be renamed or removed while watched; that is not fatal,
      // and it may well come back.
      return [];
    }
    return entries
      .filter((name) => name.toLowerCase().endsWith(TELEMETRY_EXTENSION))
      .map((name) => path.join(this.dir, name));
  }

  /** Reads whatever is new in one file. Returns whether any complete line was
   * ingested, which is what decides if the poll announces anything. */
  private consume(filePath: string): boolean {
    const key = this.key(filePath);
    if (this.skipped.has(key)) return false;

    let file = this.file;
    if (file && this.key(file.filePath) !== key) {
      this.skipped.add(key);
      return false;
    }
    if (!file) {
      // The game's one file is either this one or already somewhere else:
      // adopting a second would put two runs' telemetry into one game.
      if (telemetryRefusal(this.store) !== null) {
        this.skipped.add(key);
        return false;
      }
      file = {
        filePath,
        offset: 0,
        partial: "",
        decoder: new StringDecoder("utf8"),
        lineNo: 0,
        ingest: new StreamIngest(this.store, filePath, path.basename(filePath).replace(/\.ndjson$/i, "")),
      };
      this.file = file;
    }

    let size: number;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      return false; // deleted between the readdir and the stat
    }
    if (size === file.offset) return false;
    if (size < file.offset) {
      // Truncated or swapped for a different file under the same name. The
      // rows already ingested cannot be taken back, so re-reading from zero
      // would duplicate them; the file is dropped rather than guessed at.
      file.ingest.finish();
      this.file = null;
      this.skipped.add(key);
      return false;
    }

    const length = Math.min(size - file.offset, MAX_READ_BYTES);
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    let fd: number | null = null;
    try {
      // Opened and closed per poll rather than held: a long-lived handle on a
      // file another process is still writing is the kind of thing that makes
      // rename and delete fail on Windows.
      fd = fs.openSync(filePath, "r");
      read = fs.readSync(fd, buffer, 0, length, file.offset);
    } catch {
      return false;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
    if (read === 0) return false;
    file.offset += read;

    // A read boundary can fall anywhere: mid-character (the decoder holds the
    // incomplete sequence) or mid-line (partial holds the incomplete line).
    // Only whole lines reach the ingest, which is what makes killing the
    // emitter mid-write leave a consistent view rather than a rejected line.
    const text = file.partial + file.decoder.write(buffer.subarray(0, read));
    const lines = text.split("\n");
    file.partial = lines.pop() ?? "";
    for (const line of lines) {
      file.ingest.line(line.endsWith("\r") ? line.slice(0, -1) : line, ++file.lineNo);
    }
    return lines.length > 0;
  }
}
