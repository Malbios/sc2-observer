/**
 * The telemetry contract (plan §3). These types are the contract: field names
 * here are what a bot writes and what the viewer reads, and the Python emitter
 * is a convenience wrapper around exactly this shape.
 *
 * This file is imported by all three processes, so it stays types-only with no
 * node or DOM imports.
 */

export const TELEMETRY_SCHEMA_VERSION = 1;

export type TelemetryKind = "hello" | "overlay" | "series" | "event" | "snapshot" | "entity" | "end";

export type EventLevel = "debug" | "info" | "warn" | "error";

/** Map coordinates, the same frame as `rawData.units` (§3.3). */
export type Point2 = [number, number];

/**
 * §3.2 calls `style` "rendering hints", so unknown keys are carried and
 * ignored rather than rejected: a bot may send hints a later viewer
 * understands, and that must not make the line invalid today.
 */
export interface TelemetryStyle {
  color?: string;
  opacity?: number;
  width?: number;
  label?: string;
  z?: number;
  [key: string]: unknown;
}

/** One entry of `hello.channels`. Pre-declaration is optional (§3.2);
 * undeclared channels appear on first use with everything defaulted. */
export interface ChannelDeclaration {
  ch: string;
  kind?: TelemetryKind;
  label?: string;
  unit?: string;
  range?: [number, number];
  visible?: boolean;
  /** `entity` channels only: keep data after the unit leaves the observation
   * (§3.3). Declared here because §3.3 names the behaviour but not where it
   * is switched on. */
  sticky?: boolean;
}

export interface HelloData {
  emitter?: string;
  name?: string;
  meta?: Record<string, unknown>;
  channels?: ChannelDeclaration[];
}

// -- overlay shapes ---------------------------------------------------------
// §3.3 names the shape vocabulary but not its field names. These spellings are
// the contract, and fixtures/testbot-smoke.ndjson is written in them.

export interface PointShape {
  type: "point";
  pos: Point2;
}
export interface CircleShape {
  type: "circle";
  pos: Point2;
  r: number;
}
export interface LineShape {
  type: "line";
  from: Point2;
  to: Point2;
}
export interface PolylineShape {
  type: "polyline";
  points: Point2[];
}
export interface PolygonShape {
  type: "polygon";
  points: Point2[];
}
export interface RectShape {
  type: "rect";
  p0: Point2;
  p1: Point2;
}
export interface TextShape {
  type: "text";
  pos: Point2;
  text: string;
}
/**
 * Heatmaps and influence maps. §3.3: a 200x200 grid as a JSON array is 40k
 * numbers per update, so `enc` carries a base64 payload instead, and the real
 * value of a cell is `offset + raw * scale`.
 */
export interface GridShape {
  type: "grid";
  origin: Point2;
  cell: number;
  w: number;
  h: number;
  enc?: "b64u8" | "b64f32";
  scale?: number;
  offset?: number;
  values: string | number[];
}

export type OverlayShape =
  | PointShape
  | CircleShape
  | LineShape
  | PolylineShape
  | PolygonShape
  | RectShape
  | TextShape
  | GridShape;

export const OVERLAY_SHAPE_TYPES = ["point", "circle", "line", "polyline", "polygon", "rect", "text", "grid"] as const;

// -- kind payloads ----------------------------------------------------------

export interface SeriesPair {
  name: string;
  value: number;
}
/** Named pairs, or a bare number when `ch` names the series itself (§3.3). */
export type SeriesData = number | SeriesPair[];

export interface EventData {
  msg: string;
  level?: EventLevel;
  data?: Record<string, unknown>;
  /** Optional, pins the event on the map. */
  pos?: Point2;
}

export interface EntityData {
  /** The game's own unit tag, which is what joins this to the observation. */
  tag: number;
  [key: string]: unknown;
}

// -- messages ---------------------------------------------------------------

interface EnvelopeBase {
  v: number;
  /** Monotonic per file, for ordering within a loop. */
  seq?: number;
  style?: TelemetryStyle;
  /** Overlays only: loops until this channel's content expires (§3.3). */
  ttl?: number;
}

interface LoopEnvelope extends EnvelopeBase {
  loop: number;
  ch: string;
}

export interface HelloMessage extends EnvelopeBase {
  kind: "hello";
  data: HelloData;
}
export interface EndMessage extends EnvelopeBase {
  kind: "end";
  data?: unknown;
}
export interface OverlayMessage extends LoopEnvelope {
  kind: "overlay";
  data: OverlayShape[];
}
export interface SeriesMessage extends LoopEnvelope {
  kind: "series";
  data: SeriesData;
}
export interface EventMessage extends LoopEnvelope {
  kind: "event";
  data: EventData;
}
export interface SnapshotMessage extends LoopEnvelope {
  kind: "snapshot";
  data: unknown;
}
export interface EntityMessage extends LoopEnvelope {
  kind: "entity";
  data: EntityData;
}

export type TelemetryMessage =
  | HelloMessage
  | EndMessage
  | OverlayMessage
  | SeriesMessage
  | EventMessage
  | SnapshotMessage
  | EntityMessage;

/** The messages that carry `loop` and `ch`, i.e. everything but hello/end. */
export type ChannelMessage = OverlayMessage | SeriesMessage | EventMessage | SnapshotMessage | EntityMessage;

// -- IPC data transfer objects ----------------------------------------------

export interface TelemetryStreamIpc {
  id: number;
  name: string;
  sourcePath: string;
  emitter: string | null;
  meta: Record<string, unknown> | null;
  firstLoop: number | null;
  lastLoop: number | null;
  attachedAt: string;
  messageCount: number;
  rejectedCount: number;
}

/** A channel as the tree should show it: declared hints where the bot gave
 * them, otherwise whatever was inferred from first use. */
export interface ChannelIpc {
  ch: string;
  kind: TelemetryKind;
  label: string | null;
  unit: string | null;
  range: [number, number] | null;
  defaultVisible: boolean;
  sticky: boolean;
  /** `series` channels only: the distinct `name`s seen on this channel. */
  seriesNames: string[];
}

export interface OverlayStateIpc {
  ch: string;
  loop: number;
  style: TelemetryStyle | null;
  shapes: OverlayShape[];
}
export interface SnapshotStateIpc {
  ch: string;
  loop: number;
  data: unknown;
  /** The snapshot this one replaced, so the inspector can diff consecutive
   * snapshots (§3.3) without a second query. */
  previous: unknown;
  previousLoop: number | null;
}
export interface EntityStateIpc {
  ch: string;
  loop: number;
  byTag: Record<number, EntityData>;
  /** From the channel's most recent message. `style.label` names the field to
   * render beside the unit on the map (§3.6). */
  style: TelemetryStyle | null;
}

/** Retention-resolved telemetry state at one loop. Series and events are not
 * here: they are range queries, not per-loop values. */
export interface TelemetryStateIpc {
  loop: number;
  overlays: OverlayStateIpc[];
  snapshots: SnapshotStateIpc[];
  entities: EntityStateIpc[];
}

/** Parallel arrays, which is uPlot's native data format. */
export interface SeriesDataIpc {
  ch: string;
  name: string;
  loops: number[];
  values: number[];
}

export interface EventIpc {
  seq: number;
  loop: number;
  ch: string;
  level: EventLevel;
  msg: string;
  pos: Point2 | null;
  data: Record<string, unknown> | null;
}

export interface EventFilterIpc {
  ch?: string;
  levels?: EventLevel[];
  text?: string;
  limit?: number;
}
