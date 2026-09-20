import {
  OVERLAY_SHAPE_TYPES,
  TELEMETRY_SCHEMA_VERSION,
  type EventLevel,
  type OverlayShape,
  type Point2,
  type TelemetryKind,
  type TelemetryMessage,
} from "../shared/telemetry-types";

/**
 * Per-line validation for the telemetry contract (plan §3).
 *
 * §4 requires "schema validation with clear per-line rejection (bad lines are
 * logged, never fatal)". So this never throws: it returns a reason a human can
 * act on, and rejects the whole line rather than silently repairing part of it.
 * A half-understood overlay drawn in the wrong place is worse than one that is
 * reported as broken.
 */

export type ParseResult = { ok: true; message: TelemetryMessage } | { ok: false; reason: string };

const KINDS: TelemetryKind[] = ["hello", "overlay", "series", "event", "snapshot", "entity", "end"];
const LEVELS: EventLevel[] = ["debug", "info", "warn", "error"];

function reject(reason: string): ParseResult {
  return { ok: false, reason };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPoint(value: unknown): value is Point2 {
  return Array.isArray(value) && value.length >= 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1]);
}

function isPointList(value: unknown): value is Point2[] {
  return Array.isArray(value) && value.length > 0 && value.every(isPoint);
}

/** Returns a reason the shape is unusable, or null if it can be drawn. */
function shapeProblem(shape: unknown): string | null {
  if (!isPlainObject(shape)) return "shape is not an object";
  const type = shape["type"];
  if (typeof type !== "string" || !(OVERLAY_SHAPE_TYPES as readonly string[]).includes(type)) {
    return `unknown shape type ${JSON.stringify(type)}`;
  }

  switch (type as OverlayShape["type"]) {
    case "point":
      return isPoint(shape["pos"]) ? null : "point needs pos [x, y]";
    case "circle":
      if (!isPoint(shape["pos"])) return "circle needs pos [x, y]";
      return isFiniteNumber(shape["r"]) ? null : "circle needs a numeric r";
    case "line":
      if (!isPoint(shape["from"])) return "line needs from [x, y]";
      return isPoint(shape["to"]) ? null : "line needs to [x, y]";
    case "polyline":
    case "polygon":
      return isPointList(shape["points"]) ? null : `${type} needs a non-empty points list`;
    case "rect":
      if (!isPoint(shape["p0"])) return "rect needs p0 [x, y]";
      return isPoint(shape["p1"]) ? null : "rect needs p1 [x, y]";
    case "text":
      if (!isPoint(shape["pos"])) return "text needs pos [x, y]";
      return typeof shape["text"] === "string" ? null : "text needs a string text";
    case "grid": {
      if (!isPoint(shape["origin"])) return "grid needs origin [x, y]";
      if (!isFiniteNumber(shape["cell"]) || (shape["cell"] as number) <= 0) return "grid needs a positive cell size";
      const w = shape["w"];
      const h = shape["h"];
      if (!Number.isInteger(w) || (w as number) <= 0) return "grid needs a positive integer w";
      if (!Number.isInteger(h) || (h as number) <= 0) return "grid needs a positive integer h";
      const enc = shape["enc"];
      if (enc !== undefined && enc !== "b64u8" && enc !== "b64f32") return `unknown grid enc ${JSON.stringify(enc)}`;
      const values = shape["values"];
      if (typeof values === "string") {
        return enc === undefined ? "grid with string values needs enc" : null;
      }
      if (!Array.isArray(values) || !values.every(isFiniteNumber)) return "grid values must be a base64 string or a number array";
      // Only checkable for the plain-array form; base64 length depends on enc.
      return values.length === (w as number) * (h as number) ? null : `grid values length ${values.length} is not w*h`;
    }
  }
}

/** Returns a reason the payload is unusable for `kind`, or null. */
function dataProblem(kind: TelemetryKind, data: unknown): string | null {
  switch (kind) {
    case "hello":
      return isPlainObject(data) ? null : "hello data must be an object";
    case "end":
      return null; // §3.2 leaves end's payload free-form, and it may be absent.
    case "overlay": {
      if (!Array.isArray(data)) return "overlay data must be a list of shapes";
      for (const [index, shape] of data.entries()) {
        const problem = shapeProblem(shape);
        if (problem) return `shape ${index}: ${problem}`;
      }
      return null;
    }
    case "series": {
      if (isFiniteNumber(data)) return null;
      if (!Array.isArray(data)) return "series data must be a number or a list of {name, value}";
      if (data.length === 0) return "series data list is empty";
      for (const [index, pair] of data.entries()) {
        if (!isPlainObject(pair)) return `series ${index} is not an object`;
        if (typeof pair["name"] !== "string" || pair["name"] === "") return `series ${index} needs a non-empty name`;
        if (!isFiniteNumber(pair["value"])) return `series ${index} (${pair["name"]}) needs a numeric value`;
      }
      return null;
    }
    case "event": {
      if (!isPlainObject(data)) return "event data must be an object";
      if (typeof data["msg"] !== "string") return "event needs a string msg";
      const level = data["level"];
      if (level !== undefined && !LEVELS.includes(level as EventLevel)) return `unknown event level ${JSON.stringify(level)}`;
      if (data["pos"] !== undefined && !isPoint(data["pos"])) return "event pos must be [x, y]";
      if (data["data"] !== undefined && !isPlainObject(data["data"])) return "event data.data must be an object";
      return null;
    }
    case "snapshot":
      // "Any JSON value" (§3.3), so anything that survived JSON.parse is fine.
      return data === undefined ? "snapshot needs a data value" : null;
    case "entity": {
      if (!isPlainObject(data)) return "entity data must be an object";
      return isFiniteNumber(data["tag"]) ? null : "entity needs a numeric tag";
    }
  }
}

export function parseTelemetryLine(line: string): ParseResult {
  if (line.trim() === "") return reject("empty line");

  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (err) {
    return reject(`invalid JSON: ${(err as Error).message}`);
  }
  if (!isPlainObject(raw)) return reject("line is not a JSON object");

  const version = raw["v"];
  if (!isFiniteNumber(version)) return reject("missing or non-numeric v");
  if (version > TELEMETRY_SCHEMA_VERSION) {
    return reject(`schema version ${version} is newer than this build understands (${TELEMETRY_SCHEMA_VERSION})`);
  }

  const kind = raw["kind"];
  if (typeof kind !== "string" || !KINDS.includes(kind as TelemetryKind)) {
    return reject(`unknown kind ${JSON.stringify(kind)}`);
  }

  if (raw["seq"] !== undefined && !isFiniteNumber(raw["seq"])) return reject("seq must be a number");
  if (raw["style"] !== undefined && !isPlainObject(raw["style"])) return reject("style must be an object");
  if (raw["ttl"] !== undefined && (!isFiniteNumber(raw["ttl"]) || (raw["ttl"] as number) < 0)) {
    return reject("ttl must be a non-negative number");
  }

  // hello and end sit outside the loop axis; everything else is keyed by it.
  if (kind !== "hello" && kind !== "end") {
    const loop = raw["loop"];
    if (!Number.isInteger(loop) || (loop as number) < 0) return reject("loop must be a non-negative integer");
    const ch = raw["ch"];
    if (typeof ch !== "string" || ch === "") return reject("ch must be a non-empty string");
  }

  const problem = dataProblem(kind as TelemetryKind, raw["data"]);
  if (problem) return reject(problem);

  return { ok: true, message: raw as unknown as TelemetryMessage };
}
