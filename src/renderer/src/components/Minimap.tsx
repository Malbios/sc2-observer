import { useEffect, useRef, type JSX } from "react";
import type { FrameAtLoopIpc, TerrainDataIpc } from "../../../shared/ipc-types";
import { colorForOwner, cssColor } from "../colors";

interface Props {
  terrain: TerrainDataIpc | null;
  frame: FrameAtLoopIpc | null;
  onRecenter(worldX: number, worldY: number): void;
}

/** Backing-store size. The canvas is CSS-sized to whatever the right rail can
 * spare, so this is resolution, not layout: the drawing code works in these
 * pixels and the browser scales the result. */
const SIZE = 200;

export function Minimap({ terrain, frame, onRecenter }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !terrain) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const scale = Math.min(SIZE / terrain.width, SIZE / terrain.height);
    const w = terrain.width * scale;
    const h = terrain.height * scale;

    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = "#1b1f26";
    ctx.fillRect(0, 0, SIZE, SIZE);

    ctx.fillStyle = "#2b323d";
    ctx.fillRect(0, 0, w, h);

    for (const unit of frame?.units ?? []) {
      if (!unit.pos) continue;
      const px = unit.pos.x * scale;
      const py = h - unit.pos.y * scale;
      ctx.fillStyle = cssColor(colorForOwner(unit.owner));
      ctx.fillRect(px - 1, py - 1, 2, 2);
    }
  }, [terrain, frame]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!terrain) return;
    // Two conversions, in order. The element is displayed at whatever square
    // the rail can spare, which is not the backing-store size, so the click
    // becomes a backing pixel first. clientWidth and offsetX are both measured
    // inside the border, so the 1px frame does not skew the result.
    const displayed = e.currentTarget.clientWidth;
    if (displayed <= 0) return;
    const canvasX = (e.nativeEvent.offsetX * SIZE) / displayed;
    const canvasY = (e.nativeEvent.offsetY * SIZE) / displayed;

    // Then a backing pixel becomes a world unit. MapView's world space already
    // has y flipped (sprite.y = height - pos.y) and the minimap is drawn with
    // the same flip, so this maps straight through without flipping again.
    const scale = Math.min(SIZE / terrain.width, SIZE / terrain.height);
    onRecenter(canvasX / scale, canvasY / scale);
  };

  return (
    <canvas
      ref={canvasRef}
      width={SIZE}
      height={SIZE}
      onClick={handleClick}
      style={{
        // The rail gives up height as the bottom dock grows, so the width and
        // height attributes above are backing-store resolution and these are
        // the layout. Height is the flex main size and shrinks; an auto width
        // plus aspect-ratio keeps the box square while it does, which is why
        // alignSelf is needed -- a stretched column item would fix the width
        // at the rail's and letterbox the drawing instead. The 50% cap leaves
        // the inspector below it room at any rail height.
        height: SIZE,
        maxHeight: "50%",
        width: "auto",
        maxWidth: "100%",
        aspectRatio: "1",
        alignSelf: "flex-start",
        flexShrink: 1,
        minHeight: 0,
        borderRadius: 6,
        cursor: "pointer",
        border: "1px solid #2b323d",
      }}
    />
  );
}
