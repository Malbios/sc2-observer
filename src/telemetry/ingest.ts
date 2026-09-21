import type { HistoryStore } from "../history/HistoryStore";
import type { ChannelMessage, HelloData } from "../shared/telemetry-types";
import { CHECKPOINT_EVERY, rebuildCheckpoints } from "./checkpoints";
import { parseTelemetryLine } from "./parse";
import { TelemetryModel } from "./TelemetryModel";
/** Rejections are logged, never fatal (§4), but a broken emitter can produce
 * one per line, so only the first few are kept for reporting. */
const MAX_REPORTED_REJECTIONS = 20;

export interface IngestSummary {
  streamId: number | null;
  name: string;
  messageCount: number;
  rejectedCount: number;
  outOfOrderCount: number;
  firstLoop: number | null;
  lastLoop: number | null;
  sawHello: boolean;
  sawEnd: boolean;
  rejections: { line: number; reason: string }[];
}

/**
 * Turns a sequence of NDJSON lines into store rows, building checkpoints as it
 * goes. §4 requires the tailer to be "used verbatim for import of a file next
 * to a replay", so this is the one implementation: the import CLI feeds it a
 * whole file, and the tailer feeds it each line as the file grows.
 *
 * Lines may be handed over in several batches; state carries across calls.
 */
export class StreamIngest {
  private readonly model = new TelemetryModel();
  private streamId: number | null = null;
  private nextCheckpointLoop = 0;
  private messageCount = 0;
  private rejectedCount = 0;
  private outOfOrderCount = 0;
  private firstLoop: number | null = null;
  private lastLoop: number | null = null;
  private sawHello = false;
  private sawEnd = false;
  private readonly rejections: { line: number; reason: string }[] = [];

  constructor(
    private readonly store: HistoryStore,
    private readonly sourcePath: string,
    private readonly fallbackName: string
  ) {}

  /** `lineNo` is 1-based and is used both for rejection reporting and as the
   * `seq` fallback when a message omits one (§3.2 makes seq optional). */
  line(text: string, lineNo: number): void {
    if (text.trim() === "") return; // blank lines are not rejections

    const result = parseTelemetryLine(text);
    if (!result.ok) {
      this.rejectedCount++;
      if (this.rejections.length < MAX_REPORTED_REJECTIONS) {
        this.rejections.push({ line: lineNo, reason: result.reason });
      }
      return;
    }

    const message = result.message;
    if (message.kind === "hello") {
      this.sawHello = true;
      this.openStream(message.data);
      return;
    }
    if (message.kind === "end") {
      this.sawEnd = true;
      return;
    }

    const streamId = this.streamId ?? this.openStream(null);
    this.checkpointThrough(message.loop);

    this.store.recordTelemetry(streamId, message as ChannelMessage, lineNo);
    this.model.apply(message as ChannelMessage);

    this.messageCount++;
    if (this.firstLoop === null) this.firstLoop = message.loop;
    if (this.lastLoop !== null && message.loop < this.lastLoop) this.outOfOrderCount++;
    this.lastLoop = Math.max(this.lastLoop ?? message.loop, message.loop);
  }

  /**
   * A `hello` may be absent, and §3.4 only says it is written first, so a
   * stream row is created lazily either way. The row exists before any message
   * references it because `telemetry.stream_id` would otherwise dangle.
   */
  private openStream(hello: HelloData | null): number {
    if (this.streamId !== null) return this.streamId;
    this.streamId = this.store.createStream({
      name: hello?.name || this.fallbackName,
      sourcePath: this.sourcePath,
      emitter: hello?.emitter ?? null,
      meta: hello?.meta ?? null,
      channels: hello?.channels ?? null,
    });
    // A second file joining the game invalidates every checkpoint written so
    // far: each one holds the state of one stream while claiming to hold the
    // game's. They are dropped here and rebuilt from the merged order when a
    // stream finishes (see ./checkpoints).
    if (this.store.streamCount() > 1) this.store.clearCheckpoints();
    return this.streamId;
  }

  /** True once this game has more than one telemetry file, which is when no
   * single stream can write a checkpoint that is true of the whole game. */
  private get shared(): boolean {
    return this.store.streamCount() > 1;
  }

  /**
   * Writes any checkpoints the cursor has passed. Called before applying the
   * message at `loop`, so a checkpoint at X holds exactly the messages with
   * loop <= X. This assumes non-decreasing loops, which is what a bot writing
   * once per step produces; `outOfOrderCount` surfaces it when that does not
   * hold rather than letting checkpoints go quietly wrong.
   */
  private checkpointThrough(loop: number): void {
    while (loop > this.nextCheckpointLoop) {
      // A stream that shares the game cannot speak for it. Its boundaries are
      // still tracked, so that if the other stream is later detached this one
      // carries on from the right place.
      if (!this.shared) {
        this.store.recordCheckpoint(this.nextCheckpointLoop, this.model.capture());
      }
      this.nextCheckpointLoop += CHECKPOINT_EVERY;
    }
  }

  /**
   * Brings the stream row's running totals up to date without closing the
   * stream, for a file that is still being written. This deliberately writes
   * no checkpoint: the tailer calls it after every poll, and a checkpoint per
   * poll would replace §6.3's one-per-500-loops with one every 150ms.
   *
   * The caller flushes, so a poll that touched several files pays for one
   * transaction rather than one each.
   */
  settle(): void {
    if (this.streamId === null || this.lastLoop === null) return;
    this.store.updateStream(this.streamId, {
      firstLoop: this.firstLoop,
      lastLoop: this.lastLoop,
      messageCount: this.messageCount,
      rejectedCount: this.rejectedCount,
    });
  }

  /** Flushes buffers and writes the closing checkpoint. Safe to call more than
   * once, so the tailer can settle after each poll cycle. */
  finish(): IngestSummary {
    if (this.streamId !== null && this.lastLoop !== null && !this.shared) {
      this.store.recordCheckpoint(this.lastLoop, this.model.capture());
    }
    this.settle();
    this.store.flush();
    // A game with several files gets its checkpoints back here, built from all
    // of them at once. Closing is the right moment: during live tailing the
    // viewer follows the head and never seeks backwards, so the only cost of
    // having none until now is to a scrub that has not happened yet.
    if (this.shared) rebuildCheckpoints(this.store);
    return this.summary();
  }

  summary(): IngestSummary {
    return {
      streamId: this.streamId,
      name: this.fallbackName,
      messageCount: this.messageCount,
      rejectedCount: this.rejectedCount,
      outOfOrderCount: this.outOfOrderCount,
      firstLoop: this.firstLoop,
      lastLoop: this.lastLoop,
      sawHello: this.sawHello,
      sawEnd: this.sawEnd,
      rejections: this.rejections,
    };
  }
}
