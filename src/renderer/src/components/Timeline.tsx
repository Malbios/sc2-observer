import type { JSX } from "react";
import type { EventIpc } from "../../../shared/telemetry-types";
import { colorForLevel, cssColor } from "../colors";

/**
 * How long each stream has been silent (§4.2). Purely display: a frozen
 * stream is a bot on a breakpoint, and the app shows that the picture is old
 * rather than deciding the game is over.
 */
export interface LiveState {
  frameIdleMs: number;
  /** Null when nothing is watching a telemetry folder. */
  telemetryIdleMs: number | null;
}

interface Props {
  loop: number;
  maxLoop: number;
  playing: boolean;
  speed: number;
  onSeek(loop: number): void;
  onTogglePlay(): void;
  onSpeedChange(speed: number): void;
  /** Event ticks to mark on the track (§3.6). */
  events: EventIpc[];
  /** Set while a session is running, which replaces the playback controls:
   * the live view follows the head and does not scrub (§6.4). */
  live?: LiveState | null;
  /** A replay still being recorded: the last loop that can be shown. The
   * track spans the whole game and marks how far recording has got; seeking
   * past it stops at it. */
  available?: number | null;
}

const SPEEDS = [1, 2, 4, 8];

/**
 * A range input's thumb travels over `width - thumbWidth`, so value 0 centres
 * the thumb at `thumbWidth / 2` rather than at the left edge. A tick strip
 * positioned naively at `loop / maxLoop * 100%` therefore drifts from the
 * thumb by half a thumb width at each end. Pinning the thumb size here and
 * insetting the strip by the same half keeps the two aligned; the alternative
 * was replacing the input with a div track and reimplementing drag, keyboard
 * and click-to-seek for no visual gain.
 */
const THUMB_SIZE = 14;
const TRACK_HEIGHT = 4;
const TICK_STRIP_HEIGHT = 10;

/** Chromium-only (this is Electron), so the -webkit- pseudo-elements are the
 * whole story: no cross-browser duplication needed. The unstyled control
 * renders a light track and the system accent colour, which reads as a stray
 * OS widget on the dark panel. */
const RANGE_CSS = `
.timeline-range {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: ${THUMB_SIZE}px;
  background: transparent;
  margin: 0;
  display: block;
  cursor: pointer;
}
.timeline-range::-webkit-slider-runnable-track {
  height: ${TRACK_HEIGHT}px;
  border-radius: ${TRACK_HEIGHT / 2}px;
  /* The recorded part of a replay still being recorded, like a video's
     buffered range. 0% for everything else, which is the plain track. */
  background: linear-gradient(to right, #56606e var(--recorded, 0%), #2b323d var(--recorded, 0%));
}
.timeline-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: ${THUMB_SIZE}px;
  height: ${THUMB_SIZE}px;
  border-radius: 50%;
  background: #e7e9ec;
  border: none;
  margin-top: ${(TRACK_HEIGHT - THUMB_SIZE) / 2}px;
}
.timeline-range:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 3px rgba(124, 214, 255, 0.4);
}
.timeline-tick {
  position: absolute;
  top: 0;
  width: 2px;
  height: ${TICK_STRIP_HEIGHT}px;
  border-radius: 1px;
  transform: translateX(-1px);
  cursor: pointer;
}
`;

export function Timeline({
  loop,
  maxLoop,
  playing,
  speed,
  onSeek,
  onTogglePlay,
  onSpeedChange,
  events,
  live = null,
  available = null,
}: Props): JSX.Element {
  const seek = (value: number): void => onSeek(available === null ? value : Math.min(value, available));
  const recordedPercent = available === null || maxLoop <= 0 ? 0 : Math.min(100, (available / maxLoop) * 100);
  // Two seconds of nothing is a stream that has stopped rather than one
  // between frames: a bot stepping normally produces one every few
  // milliseconds, and even a slow one does not go quiet for that long.
  const frozen = live !== null && live.frameIdleMs > 2000;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px" }}>
      <style>{RANGE_CSS}</style>
      {live ? (
        <span
          title={
            `last frame ${(live.frameIdleMs / 1000).toFixed(1)}s ago` +
            (live.telemetryIdleMs === null ? "" : `, last telemetry ${(live.telemetryIdleMs / 1000).toFixed(1)}s ago`)
          }
          style={{
            width: 64,
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            color: frozen ? "#8b93a1" : "#98c379",
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              background: frozen ? "#4a515c" : "#98c379",
              display: "inline-block",
            }}
          />
          {frozen ? `${Math.floor(live.frameIdleMs / 1000)}s` : "live"}
        </span>
      ) : (
        <button onClick={onTogglePlay} style={{ width: 64 }}>
          {playing ? "Pause" : "Play"}
        </button>
      )}

      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Same inset as the thumb's travel, so a tick at loop L sits exactly
            under the thumb when the cursor is at L. */}
        <div
          style={{
            position: "relative",
            height: TICK_STRIP_HEIGHT,
            margin: `0 ${THUMB_SIZE / 2}px 2px`,
          }}
        >
          {events.map((event, index) => (
            <div
              key={`${event.seq}-${event.loop}-${index}`}
              className="timeline-tick"
              title={`${event.loop}  ${event.ch}: ${event.msg}`}
              onClick={() => seek(event.loop)}
              style={{
                left: `${maxLoop > 0 ? (event.loop / maxLoop) * 100 : 0}%`,
                background: cssColor(colorForLevel(event.level)),
              }}
            />
          ))}
        </div>
        <input
          className="timeline-range"
          type="range"
          min={0}
          max={maxLoop}
          value={loop}
          disabled={live !== null}
          onChange={(e) => seek(Number(e.target.value))}
          style={{ ["--recorded" as string]: `${recordedPercent}%` }}
          title={available === null ? undefined : `recorded up to loop ${available}`}
        />
      </div>

      <span style={{ fontFamily: "monospace", fontSize: 12, width: 90, textAlign: "right" }}>
        {live ? `loop ${loop}` : `${loop} / ${maxLoop}`}
      </span>
      {!live && (
        <select value={speed} onChange={(e) => onSpeedChange(Number(e.target.value))}>
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
