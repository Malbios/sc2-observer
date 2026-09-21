import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { EventBus } from "../bus/EventBus";
import type { HistoryStore } from "../history/HistoryStore";
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
  private readonly files = new Map<string, WatchedFile>();
  /**
   * Files this tailer will not touch: already imported into this recording, or
   * truncated underneath it. Both cases would duplicate or corrupt rows if
   * read, and both are sticky, so they are decided once rather than per poll.
   */
  private readonly skipped = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private watcher: fs.FSWatcher | null = null;
  /** fs.watch can fire while a poll is mid-read; one poll at a time. */
  private polling = false;

  constructor(
    private readonly store: HistoryStore,
    private readonly bus: EventBus,
    readonly dir: string
  ) {}

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
    for (const file of this.files.values()) {
      file.ingest.finish();
    }
  }

  status(): TailerStatus {
    return {
      dir: this.dir,
      files: [...this.files.values()].map((file) => {
        const summary = file.ingest.summary();
        return {
          path: file.filePath,
          name: summary.name,
          messageCount: summary.messageCount,
          rejectedCount: summary.rejectedCount,
          lastLoop: summary.lastLoop,
        };
      }),
      skippedCount: this.skipped.size,
    };
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
      if (!appended) return;

      let messageCount = 0;
      let lastLoop: number | null = null;
      for (const file of this.files.values()) {
        file.ingest.settle();
        const summary = file.ingest.summary();
        messageCount += summary.messageCount;
        if (summary.lastLoop !== null) lastLoop = Math.max(lastLoop ?? summary.lastLoop, summary.lastLoop);
      }
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

    let file = this.files.get(key);
    if (!file) {
      // Reading a file that is already a stream in this recording would
      // duplicate every row it holds: two streams, overlays drawn twice, every
      // series counted twice. The manual attach refuses for the same reason.
      if (this.alreadyAttached(filePath)) {
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
      this.files.set(key, file);
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
      this.files.delete(key);
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

  private alreadyAttached(filePath: string): boolean {
    const key = this.key(filePath);
    return this.store.getStreams().some((stream) => this.key(stream.sourcePath) === key);
  }
}
