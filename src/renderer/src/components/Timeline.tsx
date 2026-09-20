import type { JSX } from "react";
import type { EventIpc } from "../../../shared/telemetry-types";
import { colorForLevel, cssColor } from "../colors";

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
  background: #2b323d;
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
}: Props): JSX.Element {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px" }}>
      <style>{RANGE_CSS}</style>
      <button onClick={onTogglePlay} style={{ width: 64 }}>
        {playing ? "Pause" : "Play"}
      </button>

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
              onClick={() => onSeek(event.loop)}
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
          onChange={(e) => onSeek(Number(e.target.value))}
        />
      </div>

      <span style={{ fontFamily: "monospace", fontSize: 12, width: 90, textAlign: "right" }}>
        {loop} / {maxLoop}
      </span>
      <select value={speed} onChange={(e) => onSpeedChange(Number(e.target.value))}>
        {SPEEDS.map((s) => (
          <option key={s} value={s}>
            {s}×
          </option>
        ))}
      </select>
    </div>
  );
}
