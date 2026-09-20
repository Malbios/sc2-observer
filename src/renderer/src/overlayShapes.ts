import * as PIXI from "pixi.js";
import type { GridShape, OverlayShape, Point2, TelemetryStyle } from "../../shared/telemetry-types";
import { colorForChannel } from "./colors";

/**
 * Draws §3.3's overlay shape vocabulary in map coordinates.
 *
 * Everything here works in world units, the same space the unit markers use,
 * so overlays pan and zoom with the map rather than floating over it. The one
 * conversion is the y-flip: telemetry carries SC2 map coordinates where y
 * grows upward, and the world container has y growing downward, flipped about
 * `terrainHeight` (the same flip MapView applies to unit positions).
 */

/** Stroke width when a channel declares none. World units, so ~0.4 of a game
 * tile: thin enough not to swamp a unit, thick enough to see when zoomed out. */
const DEFAULT_WIDTH = 0.4;
/** Text is rendered at a fixed font size and scaled to this height in world
 * units, since a Pixi Text cannot be sized in world units directly. */
const TEXT_WORLD_HEIGHT = 3;
const TEXT_FONT_SIZE = 32;

export interface DrawContext {
  terrainHeight: number;
  color: number;
  alpha: number;
  width: number;
}

export function contextFor(ch: string, style: TelemetryStyle | null, terrainHeight: number): DrawContext {
  const declared = typeof style?.color === "string" ? Number.parseInt(style.color.replace(/^#/, ""), 16) : NaN;
  return {
    terrainHeight,
    color: Number.isFinite(declared) ? declared : colorForChannel(ch),
    alpha: typeof style?.opacity === "number" ? style.opacity : 1,
    width: typeof style?.width === "number" ? style.width : DEFAULT_WIDTH,
  };
}

/** Base64 to bytes without Buffer, which the renderer does not have. */
function base64Bytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Real cell values for a grid, resolving §3.3's compact encodings. Decoding
 * happens here rather than in the main process on purpose: the base64 string
 * is smaller than the decoded array, so it is the cheaper thing to send over
 * IPC, and the renderer is where it turns into pixels anyway.
 */
export function decodeGrid(shape: GridShape): Float32Array {
  const count = shape.w * shape.h;
  const out = new Float32Array(count);
  const scale = typeof shape.scale === "number" ? shape.scale : 1;
  const offset = typeof shape.offset === "number" ? shape.offset : 0;

  if (typeof shape.values === "string") {
    const bytes = base64Bytes(shape.values);
    if (shape.enc === "b64f32") {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < count && (i + 1) * 4 <= bytes.byteLength; i++) {
        out[i] = offset + view.getFloat32(i * 4, true) * scale;
      }
    } else {
      for (let i = 0; i < count && i < bytes.length; i++) {
        out[i] = offset + bytes[i]! * scale;
      }
    }
    return out;
  }

  for (let i = 0; i < count && i < shape.values.length; i++) {
    out[i] = offset + shape.values[i]! * scale;
  }
  return out;
}

/**
 * A grid becomes one texture of w*h pixels scaled up to its footprint, rather
 * than w*h rectangles: §5 chose PixiJS partly because a 200x200 influence map
 * is 40k cells, which is far too many Graphics primitives to redraw per loop.
 * Cell value drives alpha, so a heatmap reads as intensity over the terrain.
 */
export function buildGridTexture(shape: GridShape, color: number): PIXI.Texture {
  const values = decodeGrid(shape);
  const canvas = document.createElement("canvas");
  canvas.width = shape.w;
  canvas.height = shape.h;
  const ctx = canvas.getContext("2d")!;
  const image = ctx.createImageData(shape.w, shape.h);

  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;

  // Cell value drives alpha directly, clamped to 0..1, rather than being
  // normalized against this grid's own min and max. Per-grid normalization
  // would make a uniformly-zero influence map render as fully opaque and
  // would change the meaning of a colour between one loop and the next, which
  // is exactly what a heatmap must not do. `scale`/`offset` exist (§3.3) so a
  // bot can map its own range onto 0..1; alpha is the only channel there is.
  for (let gy = 0; gy < shape.h; gy++) {
    // Grid row 0 is the lowest map y, but canvas row 0 is the top.
    const dstRow = shape.h - 1 - gy;
    for (let gx = 0; gx < shape.w; gx++) {
      const idx = (dstRow * shape.w + gx) * 4;
      const value = Math.max(0, Math.min(1, values[gy * shape.w + gx]!));
      image.data[idx] = r;
      image.data[idx + 1] = g;
      image.data[idx + 2] = b;
      image.data[idx + 3] = Math.round(value * 255);
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = PIXI.Texture.from(canvas);
  // One texel is one grid cell; keep the cell edges crisp, matching terrain.
  texture.source.scaleMode = "nearest";
  return texture;
}

/** Where a grid sprite sits in world space, accounting for the y-flip. */
export function gridBounds(shape: GridShape, terrainHeight: number): { x: number; y: number; width: number; height: number } {
  const width = shape.w * shape.cell;
  const height = shape.h * shape.cell;
  return {
    x: shape.origin[0],
    y: terrainHeight - (shape.origin[1] + height),
    width,
    height,
  };
}

/** Draws every non-grid, non-text shape of one channel into one Graphics. */
export function drawShapes(graphics: PIXI.Graphics, shapes: OverlayShape[], ctx: DrawContext): void {
  const flip = (p: Point2): [number, number] => [p[0], ctx.terrainHeight - p[1]];
  const stroke = { width: ctx.width, color: ctx.color, alpha: ctx.alpha };

  for (const shape of shapes) {
    switch (shape.type) {
      case "point": {
        const [x, y] = flip(shape.pos);
        // A point has no radius of its own; draw it at stroke weight so it
        // stays visible without pretending to a size the bot never gave.
        graphics.circle(x, y, ctx.width).fill({ color: ctx.color, alpha: ctx.alpha });
        break;
      }
      case "circle": {
        const [x, y] = flip(shape.pos);
        graphics.circle(x, y, shape.r).stroke(stroke);
        break;
      }
      case "line": {
        const [x0, y0] = flip(shape.from);
        const [x1, y1] = flip(shape.to);
        graphics.moveTo(x0, y0).lineTo(x1, y1).stroke(stroke);
        break;
      }
      case "polyline":
      case "polygon": {
        const points = shape.points.map(flip);
        if (points.length === 0) break;
        graphics.moveTo(points[0]![0], points[0]![1]);
        for (const [x, y] of points.slice(1)) graphics.lineTo(x, y);
        if (shape.type === "polygon") graphics.closePath();
        graphics.stroke(stroke);
        break;
      }
      case "rect": {
        const [x0, y0] = flip(shape.p0);
        const [x1, y1] = flip(shape.p1);
        graphics
          .rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0))
          .stroke(stroke);
        break;
      }
      default:
        // text and grid are display objects of their own, handled by MapView.
        break;
    }
  }
}

export function makeText(content: string, ctx: DrawContext): PIXI.Text {
  const text = new PIXI.Text({
    text: content,
    style: { fontFamily: "system-ui, sans-serif", fontSize: TEXT_FONT_SIZE, fill: ctx.color },
  });
  text.anchor.set(0.5, 1);
  text.scale.set(TEXT_WORLD_HEIGHT / TEXT_FONT_SIZE);
  text.alpha = ctx.alpha;
  return text;
}

export const TEXT_ANCHOR_OFFSET = TEXT_WORLD_HEIGHT * 0.2;
