import { useMemo, type JSX } from "react";
import type { ChannelIpc } from "../../../shared/telemetry-types";
import { colorForChannel, cssColor } from "../colors";

/**
 * The channel tree of §3.6, built from `ch` strings alone.
 *
 * Nothing here knows any channel name in advance: the hierarchy is whatever
 * splitting on "/" produces, and the kind badge is whatever the bot wrote. A
 * bot adding a layer, renaming a module or switching race changes what appears
 * here and nothing else in the app, which is the bot-ignorance rule showing up
 * as a UI property rather than a policy.
 */

interface Node {
  name: string;
  path: string;
  /** Set when this exact path is a channel; intermediate nodes have none. */
  channel: ChannelIpc | null;
  children: Node[];
}

interface Props {
  channels: ChannelIpc[];
  visible: ReadonlySet<string>;
  onToggle(paths: string[], visible: boolean): void;
  onAttach(): void;
  streamCount: number;
  /** Result of the last attach, so a rejected line or a duplicate file is
   * visible in the UI rather than only in the console. */
  notice: string | null;
}

const KIND_ABBREVIATION: Record<string, string> = {
  overlay: "ov",
  series: "sr",
  event: "ev",
  snapshot: "sn",
  entity: "en",
};

function buildTree(channels: ChannelIpc[]): Node[] {
  const roots: Node[] = [];
  const byPath = new Map<string, Node>();

  for (const channel of channels) {
    const segments = channel.ch.split("/");
    let prefix = "";
    let siblings = roots;
    for (const [index, segment] of segments.entries()) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      let node = byPath.get(prefix);
      if (!node) {
        node = { name: segment, path: prefix, channel: null, children: [] };
        byPath.set(prefix, node);
        siblings.push(node);
      }
      if (index === segments.length - 1) node.channel = channel;
      siblings = node.children;
    }
  }
  return roots;
}

/** Every channel at or below a node, so toggling a branch moves all of it. */
function channelsUnder(node: Node): string[] {
  const out: string[] = [];
  const walk = (current: Node): void => {
    if (current.channel) out.push(current.path);
    current.children.forEach(walk);
  };
  walk(node);
  return out;
}

function TreeRow({
  node,
  depth,
  visible,
  onToggle,
}: {
  node: Node;
  depth: number;
  visible: ReadonlySet<string>;
  onToggle(paths: string[], visible: boolean): void;
}): JSX.Element {
  const paths = channelsUnder(node);
  const shownCount = paths.filter((path) => visible.has(path)).length;
  const allShown = paths.length > 0 && shownCount === paths.length;
  const someShown = shownCount > 0 && !allShown;
  const kind = node.channel?.kind;

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: depth * 12, minHeight: 22 }}>
        <input
          type="checkbox"
          id={`channel-${node.path}`}
          checked={allShown}
          ref={(element) => {
            // A branch with only some of its channels on is neither checked
            // nor unchecked; indeterminate is only settable from script.
            if (element) element.indeterminate = someShown;
          }}
          onChange={(event) => onToggle(paths, event.target.checked)}
          disabled={paths.length === 0}
          style={{ margin: 0 }}
        />
        <label
          htmlFor={`channel-${node.path}`}
          title={node.channel ? node.channel.ch : node.path}
          style={{
            fontSize: 12,
            cursor: paths.length > 0 ? "pointer" : "default",
            color: node.channel ? "#e7e9ec" : "#8b93a1",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {node.channel?.label ?? node.name}
        </label>
        {kind && (
          <span
            style={{
              marginLeft: "auto",
              fontSize: 9,
              letterSpacing: 0.5,
              textTransform: "uppercase",
              color: cssColor(colorForChannel(node.path)),
              border: `1px solid ${cssColor(colorForChannel(node.path))}`,
              borderRadius: 3,
              padding: "0 3px",
              opacity: 0.8,
            }}
          >
            {KIND_ABBREVIATION[kind] ?? kind.slice(0, 2)}
          </span>
        )}
      </div>
      {node.children.map((child) => (
        <TreeRow key={child.path} node={child} depth={depth + 1} visible={visible} onToggle={onToggle} />
      ))}
    </>
  );
}

export function ChannelTree({ channels, visible, onToggle, onAttach, streamCount, notice }: Props): JSX.Element {
  const tree = useMemo(() => buildTree(channels), [channels]);
  const allPaths = useMemo(() => channels.map((channel) => channel.ch), [channels]);
  const allShown = allPaths.length > 0 && allPaths.every((path) => visible.has(path));

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 11, letterSpacing: 0.6, textTransform: "uppercase", color: "#8b93a1" }}>Channels</span>
        {channels.length > 0 && (
          <button
            onClick={() => onToggle(allPaths, !allShown)}
            style={{ marginLeft: "auto", fontSize: 11, background: "none", border: "none", color: "#8b93a1", cursor: "pointer", padding: 0 }}
          >
            {allShown ? "none" : "all"}
          </button>
        )}
      </div>

      {channels.length === 0 ? (
        <div style={{ fontSize: 12, color: "#8b93a1", lineHeight: 1.5 }}>
          {streamCount === 0
            ? "No telemetry attached to this recording."
            : "Attached, but no channels were written."}
        </div>
      ) : (
        <div style={{ overflowY: "auto", minHeight: 0, flex: 1, marginRight: -8, paddingRight: 8 }}>
          {tree.map((node) => (
            <TreeRow key={node.path} node={node} depth={0} visible={visible} onToggle={onToggle} />
          ))}
        </div>
      )}

      <button onClick={onAttach} style={{ marginTop: 12, fontSize: 12 }}>
        Attach Telemetry...
      </button>
      {notice && <div style={{ marginTop: 6, fontSize: 11, color: "#8b93a1", lineHeight: 1.4 }}>{notice}</div>}
    </div>
  );
}
