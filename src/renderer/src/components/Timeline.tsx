import type { JSX } from "react";
interface Props {
  loop: number;
  maxLoop: number;
  playing: boolean;
  speed: number;
  onSeek(loop: number): void;
  onTogglePlay(): void;
  onSpeedChange(speed: number): void;
}

const SPEEDS = [1, 2, 4, 8];

export function Timeline({ loop, maxLoop, playing, speed, onSeek, onTogglePlay, onSpeedChange }: Props): JSX.Element {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px" }}>
      <button onClick={onTogglePlay} style={{ width: 64 }}>
        {playing ? "Pause" : "Play"}
      </button>
      <input
        type="range"
        min={0}
        max={maxLoop}
        value={loop}
        onChange={(e) => onSeek(Number(e.target.value))}
        style={{ flex: 1 }}
      />
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
