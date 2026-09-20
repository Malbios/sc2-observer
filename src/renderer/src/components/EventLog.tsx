import { useEffect, useMemo, useState, type JSX } from "react";
import type { EventIpc, EventLevel } from "../../../shared/telemetry-types";
import { colorForLevel, cssColor } from "../colors";

/**
 * The filterable event log of §3.6: filter by channel, level and text, click
 * a row to move the timeline cursor to that loop.
 *
 * Filtering runs in the main process rather than here, so the panel never
 * holds a whole game's events just to hide most of them.
 */

const LEVELS: EventLevel[] = ["debug", "info", "warn", "error"];

interface Props {
  channels: string[];
  loop: number;
  onSeek(loop: number): void;
  /** Bumped when new rows are ingested, so the list refetches. */
  revision: number;
}

export function EventLog({ channels, loop, onSeek, revision }: Props): JSX.Element {
  const [events, setEvents] = useState<EventIpc[]>([]);
  const [channel, setChannel] = useState("");
  const [levels, setLevels] = useState<ReadonlySet<EventLevel>>(new Set(LEVELS));
  const [text, setText] = useState("");

  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(() => {
      window.spectator
        .getEvents({
          ch: channel || undefined,
          levels: levels.size === LEVELS.length ? undefined : [...levels],
          text: text || undefined,
        })
        .then((result) => {
          if (!cancelled) setEvents(result);
        });
      // Typing a filter should not fire a query per keystroke.
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [channel, levels, text, revision]);

  /** The row the cursor is at or just past, so the log tracks playback. */
  const currentIndex = useMemo(() => {
    let index = -1;
    for (const [i, event] of events.entries()) {
      if (event.loop <= loop) index = i;
      else break;
    }
    return index;
  }, [events, loop]);

  const toggleLevel = (level: EventLevel, on: boolean): void => {
    setLevels((current) => {
      const next = new Set(current);
      if (on) next.add(level);
      else next.delete(level);
      return next;
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, paddingBottom: 6, flexWrap: "wrap" }}>
        <select
          id="event-channel"
          value={channel}
          onChange={(event) => setChannel(event.target.value)}
          style={{ fontSize: 12, maxWidth: 180 }}
        >
          <option value="">all channels</option>
          {channels.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>

        {LEVELS.map((level) => (
          <label key={level} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, cursor: "pointer" }}>
            <input
              type="checkbox"
              id={`event-level-${level}`}
              checked={levels.has(level)}
              onChange={(event) => toggleLevel(level, event.target.checked)}
              style={{ margin: 0 }}
            />
            <span style={{ color: cssColor(colorForLevel(level)) }}>{level}</span>
          </label>
        ))}

        <input
          id="event-text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="filter text"
          style={{ fontSize: 12, flex: 1, minWidth: 120 }}
        />
        <span style={{ fontSize: 11, color: "#8b93a1" }}>{events.length} events</span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", fontSize: 12 }}>
        {events.length === 0 ? (
          <div style={{ color: "#8b93a1", padding: "4px 0" }}>No events match.</div>
        ) : (
          events.map((event, index) => (
            <div
              key={`${event.seq}-${event.loop}-${index}`}
              onClick={() => onSeek(event.loop)}
              style={{
                display: "flex",
                gap: 8,
                alignItems: "baseline",
                padding: "2px 6px",
                cursor: "pointer",
                borderRadius: 3,
                background: index === currentIndex ? "#242a33" : "transparent",
              }}
            >
              <span style={{ fontFamily: "ui-monospace, monospace", color: "#8b93a1", minWidth: 54, textAlign: "right" }}>
                {event.loop}
              </span>
              <span
                style={{
                  color: cssColor(colorForLevel(event.level)),
                  minWidth: 38,
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: 0.4,
                }}
              >
                {event.level}
              </span>
              <span style={{ color: "#8b93a1", minWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {event.ch}
              </span>
              <span style={{ flex: 1 }}>{event.msg}</span>
              {event.pos && <span style={{ color: "#6b7482", fontSize: 11 }}>@{event.pos[0]}, {event.pos[1]}</span>}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
