import { useMemo, useState, type JSX } from "react";
import type { SnapshotStateIpc } from "../../../shared/telemetry-types";

/**
 * The snapshot inspector of §3.6: a collapsible JSON tree with "diff against
 * previous".
 *
 * Snapshots are the one kind that joins on nothing -- they are read, not
 * drawn -- so what matters is seeing what changed between the bot's last two
 * pictures of itself rather than where on the map they sit.
 */

const CHANGE_COLORS = {
  added: "#8be04f",
  changed: "#ffc24f",
  removed: "#ff6b5b",
  same: "#e7e9ec",
} as const;

type Change = keyof typeof CHANGE_COLORS;

/** Levels expanded on first render; deeper nodes start collapsed so a large
 * snapshot does not arrive as a wall of text. */
const DEFAULT_OPEN_DEPTH = 2;

const MISSING = Symbol("missing");

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null;
}

function classify(value: unknown, previous: unknown | typeof MISSING): Change {
  if (previous === MISSING) return "added";
  if (value === MISSING) return "removed";
  // Structural comparison: a snapshot is plain JSON by definition (§3.3), so
  // serializing is both correct and cheap enough at these sizes.
  return JSON.stringify(value) === JSON.stringify(previous) ? "same" : "changed";
}

function preview(value: unknown): string {
  if (Array.isArray(value)) return `[${value.length}]`;
  if (isContainer(value)) return `{${Object.keys(value).length}}`;
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function childKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((_, index) => String(index));
  if (isContainer(value)) return Object.keys(value);
  return [];
}

function childValue(value: unknown, key: string): unknown | typeof MISSING {
  if (!isContainer(value)) return MISSING;
  const record = value as Record<string, unknown>;
  return key in record ? record[key] : MISSING;
}

function JsonNode({
  label,
  value,
  previous,
  depth,
  showDiff,
}: {
  label: string;
  value: unknown | typeof MISSING;
  previous: unknown | typeof MISSING;
  depth: number;
  showDiff: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(depth < DEFAULT_OPEN_DEPTH);
  const change = showDiff ? classify(value, previous) : "same";
  const resolved = value === MISSING ? previous : value;
  const container = isContainer(resolved);

  // Union of both sides' keys so a key that disappeared still shows.
  const keys = useMemo(() => {
    if (!container) return [];
    const merged = [...childKeys(value === MISSING ? undefined : value)];
    if (showDiff) {
      for (const key of childKeys(previous === MISSING ? undefined : previous)) {
        if (!merged.includes(key)) merged.push(key);
      }
    }
    return merged;
  }, [value, previous, container, showDiff]);

  return (
    <div style={{ paddingLeft: depth === 0 ? 0 : 10 }}>
      <div
        onClick={container ? () => setOpen((current) => !current) : undefined}
        style={{
          display: "flex",
          gap: 6,
          alignItems: "baseline",
          cursor: container ? "pointer" : "default",
          fontFamily: "ui-monospace, monospace",
          fontSize: 11,
          lineHeight: 1.6,
          textDecoration: change === "removed" ? "line-through" : "none",
          opacity: change === "removed" ? 0.7 : 1,
        }}
      >
        {container && <span style={{ color: "#6b7482", width: 8 }}>{open ? "▾" : "▸"}</span>}
        <span style={{ color: "#8b93a1" }}>{label}</span>
        <span style={{ color: CHANGE_COLORS[change] }}>{preview(resolved)}</span>
      </div>
      {container && open && (
        <div style={{ borderLeft: "1px solid #2b323d", marginLeft: 3 }}>
          {keys.map((key) => (
            <JsonNode
              key={key}
              label={key}
              value={childValue(value === MISSING ? undefined : value, key)}
              previous={showDiff ? childValue(previous === MISSING ? undefined : previous, key) : MISSING}
              depth={depth + 1}
              showDiff={showDiff}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface Props {
  snapshots: SnapshotStateIpc[];
}

/**
 * Laid out like the series tab: channels down the left, content on the right.
 * A snapshot is a document, so it wants the dock's width rather than a 240px
 * rail, and keeping the map visible above it means you can see the state the
 * bot was describing while you read what it thought about it.
 */
export function SnapshotInspector({ snapshots }: Props): JSX.Element {
  const [showDiff, setShowDiff] = useState(true);
  const [selectedCh, setSelectedCh] = useState<string | null>(null);

  const selected = snapshots.find((snapshot) => snapshot.ch === selectedCh) ?? snapshots[0] ?? null;

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      <div style={{ width: 190, overflowY: "auto", borderRight: "1px solid #2b323d", padding: "4px 8px 4px 0" }}>
        {snapshots.length === 0 ? (
          <div style={{ fontSize: 12, color: "#8b93a1" }}>No snapshot channels at this loop.</div>
        ) : (
          snapshots.map((snapshot) => (
            <div
              key={snapshot.ch}
              onClick={() => setSelectedCh(snapshot.ch)}
              style={{
                fontSize: 12,
                padding: "3px 6px",
                borderRadius: 3,
                cursor: "pointer",
                background: selected?.ch === snapshot.ch ? "#242a33" : "transparent",
                color: selected?.ch === snapshot.ch ? "#e7e9ec" : "#8b93a1",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {snapshot.ch}
            </div>
          ))
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0, paddingLeft: 10 }}>
        {selected && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: "#6b7482" }}>
                @{selected.loop}
                {showDiff && selected.previousLoop !== null && ` vs @${selected.previousLoop}`}
              </span>
              <label style={{ marginLeft: "auto", fontSize: 11, color: "#8b93a1", display: "flex", gap: 4, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  id="snapshot-diff"
                  checked={showDiff}
                  onChange={(event) => setShowDiff(event.target.checked)}
                  style={{ margin: 0 }}
                />
                diff against previous
              </label>
            </div>
            <div style={{ overflow: "auto", minHeight: 0, flex: 1 }}>
              <JsonNode
                label=""
                value={selected.data}
                previous={selected.previousLoop === null ? MISSING : selected.previous}
                depth={0}
                showDiff={showDiff}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
