import { useEffect, useRef } from "react";
import type { FrameAtLoopIpc, TerrainDataIpc } from "../../../shared/ipc-types";
import { colorForOwner, cssColor } from "../colors";

interface Props {
  terrain: TerrainDataIpc | null;
  frame: FrameAtLoopIpc | null;
  onRecenter(worldX: number, worldY: number): void;
}

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
    const rect = e.currentTarget.getBoundingClientRect();
    const scale = Math.min(SIZE / terrain.width, SIZE / terrain.height);
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    // MapView's world space already has y flipped (sprite.y = height - pos.y);
    // the minimap is drawn with the same flip, so canvas pixels map straight
    // through without flipping again here.
    onRecenter(clickX / scale, clickY / scale);
  };

  return (
    <canvas
      ref={canvasRef}
      width={SIZE}
      height={SIZE}
      onClick={handleClick}
      style={{ borderRadius: 6, cursor: "pointer", border: "1px solid #2b323d" }}
    />
  );
}
