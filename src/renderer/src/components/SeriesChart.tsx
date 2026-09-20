import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { ChannelIpc, SeriesDataIpc } from "../../../shared/telemetry-types";
import { colorForChannel, cssColor } from "../colors";

/**
 * Series channels plotted against the game loop (§3.6), with the x-axis
 * cursor locked to the timeline so scrubbing the map moves the chart and
 * vice versa.
 *
 * Loop is the only time axis (a project non-negotiable), so nothing here
 * converts to wall-clock. uPlot was chosen in §5 for scrub performance: it
 * redraws thousands of points per frame without the chart becoming the
 * bottleneck.
 */

interface Props {
  channels: ChannelIpc[];
  /** Which `ch/name` keys the user has selected to plot. */
  selected: ReadonlySet<string>;
  onToggle(key: string, on: boolean): void;
  loop: number;
  maxLoop: number;
  onSeek(loop: number): void;
}

export function seriesKey(ch: string, name: string): string {
  return `${ch}/${name}`;
}

/** Every plottable (channel, name) pair, flattened out of the channel list. */
export function seriesOptions(channels: ChannelIpc[]): { key: string; ch: string; name: string; label: string }[] {
  const out: { key: string; ch: string; name: string; label: string }[] = [];
  for (const channel of channels) {
    if (channel.kind !== "series") continue;
    for (const name of channel.seriesNames) {
      out.push({ key: seriesKey(channel.ch, name), ch: channel.ch, name, label: `${channel.ch}/${name}` });
    }
  }
  return out;
}

export function SeriesChart({ channels, selected, onToggle, loop, maxLoop, onSeek }: Props): JSX.Element {
  const holderRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;

  const options = useMemo(() => seriesOptions(channels), [channels]);
  const active = useMemo(() => options.filter((option) => selected.has(option.key)), [options, selected]);
  const [data, setData] = useState<Map<string, SeriesDataIpc>>(new Map());

  // Fetch each selected series once. They are whole-game arrays, not per-loop
  // values, so this deliberately does not depend on `loop`.
  useEffect(() => {
    let cancelled = false;
    const missing = active.filter((option) => !data.has(option.key));
    if (missing.length === 0) return;
    Promise.all(missing.map((option) => window.spectator.getSeries(option.ch, option.name))).then((results) => {
      if (cancelled) return;
      setData((current) => {
        const next = new Map(current);
        for (const [index, result] of results.entries()) next.set(missing[index]!.key, result);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [active, data]);

  /**
   * uPlot wants one shared x array, so every series is resampled onto the
   * union of their loops. A bot may write two channels at different rates,
   * and carrying the last known value forward is what makes the two
   * comparable at a glance rather than one appearing to stop.
   */
  const aligned = useMemo(() => {
    const ready = active.filter((option) => data.has(option.key));
    if (ready.length === 0) return null;

    const loopSet = new Set<number>();
    for (const option of ready) {
      for (const value of data.get(option.key)!.loops) loopSet.add(value);
    }
    const loops = [...loopSet].sort((a, b) => a - b);

    const columns: number[][] = ready.map((option) => {
      const series = data.get(option.key)!;
      const out = new Array<number>(loops.length);
      let cursor = 0;
      let last = Number.NaN;
      for (const [index, at] of loops.entries()) {
        while (cursor < series.loops.length && series.loops[cursor]! <= at) {
          last = series.values[cursor]!;
          cursor++;
        }
        out[index] = last;
      }
      return out;
    });

    return { labels: ready, data: [loops, ...columns] as uPlot.AlignedData };
  }, [active, data]);

  // Build the plot when the selected set changes. uPlot is imperative, so the
  // series list is structural: changing it means a new chart, while new x/y
  // values are a setData call.
  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;
    plotRef.current?.destroy();
    plotRef.current = null;
    if (!aligned) return;

    const plot = new uPlot(
      {
        width: holder.clientWidth || 600,
        height: holder.clientHeight || 160,
        padding: [8, 12, 0, 0],
        legend: { show: false },
        cursor: {
          y: false,
          drag: { x: false, y: false },
          // Clicking the plot seeks, which is the other half of locking the
          // chart to the timeline.
          bind: {
            mousedown: (self, _target, handler) => (event) => {
              const at = self.posToVal(self.cursor.left ?? 0, "x");
              if (Number.isFinite(at)) onSeekRef.current(Math.max(0, Math.round(at)));
              return handler(event);
            },
          },
        },
        scales: { x: { time: false } },
        axes: [
          { stroke: "#8b93a1", grid: { stroke: "#2b323d", width: 1 }, ticks: { stroke: "#2b323d" } },
          { stroke: "#8b93a1", grid: { stroke: "#2b323d", width: 1 }, ticks: { stroke: "#2b323d" }, size: 48 },
        ],
        series: [
          { label: "loop" },
          ...aligned.labels.map((option) => ({
            label: option.label,
            stroke: cssColor(colorForChannel(option.ch)),
            width: 1.5,
            spanGaps: true,
          })),
        ],
      },
      aligned.data,
      holder
    );
    plotRef.current = plot;

    const resize = new ResizeObserver(() => {
      plot.setSize({ width: holder.clientWidth, height: holder.clientHeight });
    });
    resize.observe(holder);

    return () => {
      resize.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
  }, [aligned]);

  // Park uPlot's cursor on the timeline's loop so the two read as one control.
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    const left = plot.valToPos(loop, "x");
    plot.setCursor({ left, top: 0 });
  }, [loop, maxLoop, aligned]);

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      <div style={{ width: 190, overflowY: "auto", borderRight: "1px solid #2b323d", padding: "4px 8px 4px 0" }}>
        {options.length === 0 ? (
          <div style={{ fontSize: 12, color: "#8b93a1" }}>No series channels.</div>
        ) : (
          options.map((option) => (
            <label
              key={option.key}
              style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, minHeight: 20, cursor: "pointer" }}
            >
              <input
                type="checkbox"
                id={`series-${option.key}`}
                checked={selected.has(option.key)}
                onChange={(event) => onToggle(option.key, event.target.checked)}
                style={{ margin: 0 }}
              />
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  flexShrink: 0,
                  background: cssColor(colorForChannel(option.ch)),
                  opacity: selected.has(option.key) ? 1 : 0.3,
                }}
              />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{option.label}</span>
            </label>
          ))
        )}
      </div>
      <div ref={holderRef} style={{ flex: 1, minWidth: 0, position: "relative" }}>
        {!aligned && (
          <div style={{ fontSize: 12, color: "#8b93a1", padding: 8 }}>Select a series to plot.</div>
        )}
      </div>
    </div>
  );
}
