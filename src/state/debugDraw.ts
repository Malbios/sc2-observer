import type { Request } from "../protocol/schema";
import type { OverlayShape, OverlayStateIpc } from "../shared/telemetry-types";

/**
 * Native SC2 debug draws (`Request.debug` -> `DebugDraw`) as overlays on
 * `_game/debug`, which §3.6 reserves for exactly this.
 *
 * Deliberately a straight translation: lines, boxes, spheres and world-space
 * text become the telemetry vocabulary's line, rect, circle and text. Reading
 * JSON out of debug text as extra shapes, as vscode-starcraft does, is not
 * done here: the telemetry file is where a bot says anything richer.
 */

export const DEBUG_CHANNEL = "_game/debug";

/** SC2 draws a shape with no color in white. */
const DEFAULT_COLOR = "#ffffff";

/** One draw request, grouped by color: each group is one overlay, because an
 * overlay carries a single style. */
export type DebugDrawing = { color: string; shapes: OverlayShape[] }[];

const has = (value: unknown, field: string): boolean =>
  typeof value === "object" && value !== null && Object.prototype.hasOwnProperty.call(value, field);

function colorOf(shape: Record<string, any>): string {
  if (!has(shape, "color")) return DEFAULT_COLOR;
  const channel = (value: unknown): string => Math.max(0, Math.min(255, Number(value) || 0)).toString(16).padStart(2, "0");
  return `#${channel(shape.color.r)}${channel(shape.color.g)}${channel(shape.color.b)}`;
}

/**
 * The drawing in one debug request, or null when it draws nothing at all. A
 * request with only non-draw commands (a surrender, a created unit) is not a
 * draw and must not clear what is on screen; one with a draw command that
 * happens to be empty is, and does.
 */
export function readDebugDraw(request: Request): DebugDrawing | null {
  let drew = false;
  const byColor = new Map<string, OverlayShape[]>();
  const add = (color: string, shape: OverlayShape): void => {
    const shapes = byColor.get(color) ?? [];
    shapes.push(shape);
    byColor.set(color, shapes);
  };

  for (const command of request.debug?.debug ?? []) {
    if (!has(command, "draw")) continue;
    drew = true;
    const draw = command.draw;
    for (const line of draw.lines ?? []) {
      const p0 = line.line?.p0;
      const p1 = line.line?.p1;
      if (!p0 || !p1) continue;
      add(colorOf(line), { type: "line", from: [p0.x ?? 0, p0.y ?? 0], to: [p1.x ?? 0, p1.y ?? 0] });
    }
    for (const box of draw.boxes ?? []) {
      if (!box.min || !box.max) continue;
      add(colorOf(box), { type: "rect", p0: [box.min.x ?? 0, box.min.y ?? 0], p1: [box.max.x ?? 0, box.max.y ?? 0] });
    }
    for (const sphere of draw.spheres ?? []) {
      if (!sphere.p) continue;
      add(colorOf(sphere), { type: "circle", pos: [sphere.p.x ?? 0, sphere.p.y ?? 0], r: sphere.r ?? 0 });
    }
    for (const text of draw.text ?? []) {
      // Screen-space text (`virtual_pos`) has no place on a map.
      if (!has(text, "world_pos")) continue;
      add(colorOf(text), { type: "text", pos: [text.world_pos.x ?? 0, text.world_pos.y ?? 0], text: text.text ?? "" });
    }
  }

  if (!drew) return null;
  return [...byColor].map(([color, shapes]) => ({ color, shapes }));
}

/**
 * SC2's own rule: each draw request replaces everything drawn before it, so
 * the state at loop L is the last draw at or before L.
 */
export class DebugDrawModel {
  private readonly draws: { loop: number; drawing: DebugDrawing }[] = [];

  /** Draws arrive in loop order from both sources. */
  add(loop: number, drawing: DebugDrawing): void {
    this.draws.push({ loop, drawing });
  }

  get isEmpty(): boolean {
    return this.draws.length === 0;
  }

  overlaysAt(loop: number): OverlayStateIpc[] {
    // The last draw at or before `loop`, by binary search.
    let lo = 0;
    let hi = this.draws.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.draws[mid]!.loop <= loop) lo = mid + 1;
      else hi = mid;
    }
    const current = this.draws[lo - 1];
    if (!current) return [];
    return current.drawing.map(({ color, shapes }) => ({
      ch: DEBUG_CHANNEL,
      loop: current.loop,
      style: { color },
      shapes,
    }));
  }
}
