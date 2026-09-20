import { useEffect, useRef, useState } from "react";
import * as PIXI from "pixi.js";
import type { FrameAtLoopIpc, TerrainDataIpc, UnitSummaryIpc, UnitTypeInfoIpc } from "../../../shared/ipc-types";
import { colorForCategory, colorForOwner, lightenTint } from "../colors";
import { loadIconTexture } from "../icons";

interface UnitVisual {
  container: PIXI.Container;
  shape: PIXI.Graphics;
  icon: PIXI.Sprite;
  underConstruction: PIXI.Graphics;
  selection: PIXI.Graphics;
}

export interface MapViewHandle {
  recenterOn(worldX: number, worldY: number): void;
}

interface Props {
  terrain: TerrainDataIpc | null;
  frame: FrameAtLoopIpc | null;
  selectedTag: number | null;
  onSelectUnit(unit: UnitSummaryIpc): void;
  unitTypeInfo: Record<number, UnitTypeInfoIpc>;
  mapHandleRef: React.MutableRefObject<MapViewHandle | null>;
}

interface HoverInfo {
  x: number;
  y: number;
  label: string;
}

/** Grayscale, per-cell terrain: unpathable (cliffs/water) near-black,
 * pathable-but-unplaceable (ramps) mid gray, buildable ground light gray
 * with a subtle height tint, plus a faint checkerboard so individual
 * 1-world-unit cells read as a grid rather than a smoothed gradient (the
 * texture is rendered at native per-cell resolution and upscaled with
 * nearest-neighbor filtering -- see where the texture is created below --
 * so these per-cell edges stay crisp instead of blurring together). Row 0
 * of the source grids is world y=0 (bottom); this flips to canvas row 0 =
 * top once, here, so nothing downstream needs to think about it again. */
function buildTerrainCanvas(terrain: TerrainDataIpc): HTMLCanvasElement {
  const { width, height, terrainHeight, pathingGrid, placementGrid } = terrain;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const image = ctx.createImageData(width, height);

  for (let y = 0; y < height; y++) {
    const dstRow = height - 1 - y;
    for (let x = 0; x < width; x++) {
      const srcIdx = y * width + x;
      const dstIdx = (dstRow * width + x) * 4;
      const t = terrainHeight[srcIdx] / 255;
      const checker = (x + y) % 2 === 0 ? 4 : -4;

      let shade: number;
      if (pathingGrid[srcIdx] === 0) {
        shade = 18 + t * 20; // cliffs / water: near-black
      } else if (placementGrid[srcIdx] === 0) {
        shade = 110 + t * 25; // ramps / unbuildable pathable ground: mid gray
      } else {
        shade = 195 + t * 35; // buildable ground: light gray / white
      }
      shade = Math.max(0, Math.min(255, shade + checker));

      image.data[dstIdx] = shade;
      image.data[dstIdx + 1] = shade;
      image.data[dstIdx + 2] = shade;
      image.data[dstIdx + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

export function MapView({ terrain, frame, selectedTag, onSelectUnit, unitTypeInfo, mapHandleRef }: Props): JSX.Element {
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const appRef = useRef<PIXI.Application | null>(null);
  const worldRef = useRef<PIXI.Container | null>(null);
  const unitsLayerRef = useRef<PIXI.Container | null>(null);
  const terrainSpriteRef = useRef<PIXI.Sprite | null>(null);
  const terrainRef = useRef<TerrainDataIpc | null>(null);
  const hasFitCameraRef = useRef(false);
  const cleanupListenersRef = useRef<(() => void) | null>(null);
  const fitCameraRef = useRef<() => void>(() => {});
  const lastPointerCanvasPosRef = useRef<{ x: number; y: number } | null>(null);
  const updateHoverRef = useRef<() => void>(() => {});
  // Keyed by unit tag and reused across ticks -- the previous version threw
  // away and recreated every unit's Graphics object on every playback tick
  // (many times a second) via removeChildren(), which detaches children
  // without destroying their GPU-side geometry/buffers. That leaked until
  // WebGL ran out of resources and the context died (a blank white canvas),
  // and was the main cost behind the reported slowness even before that.
  const unitVisualsRef = useRef<Map<number, UnitVisual>>(new Map());
  // Keyed by unitType id (not name -- cheaper lookup on the hot path). Absent
  // key = not yet requested; loadIconTexture has its own by-name cache, so
  // firing it again while a load is pending is harmless, not a re-fetch.
  const iconTexturesRef = useRef<Map<number, PIXI.Texture | null>>(new Map());
  // Bumped when an icon finishes loading, so paused playback still picks up
  // the swap from fallback shape to icon (nothing else would re-run the
  // units effect while paused).
  const [iconVersion, setIconVersion] = useState(0);
  // Flips true once Pixi's async init resolves. Both effects below depend
  // on it, not just on `terrain`/`frame` -- otherwise, if terrain or the
  // first frame arrives before init finishes, the effect reads null refs,
  // bails, and (for terrain, which never changes again for the same
  // recording) never gets a second chance to run.
  const [pixiReady, setPixiReady] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let destroyed = false;
    const app = new PIXI.Application();

    (async () => {
      await app.init({
        canvas,
        resizeTo: canvas.parentElement ?? undefined,
        background: 0x14171c,
        antialias: true,
      });
      if (destroyed) {
        app.destroy();
        return;
      }
      appRef.current = app;

      const world = new PIXI.Container();
      app.stage.addChild(world);
      worldRef.current = world;

      const unitsLayer = new PIXI.Container();
      // zIndex-based stacking (units over buildings over neutral resources)
      // instead of insertion order, since frame.units isn't sorted by
      // category -- see where zIndex is set per-marker below.
      unitsLayer.sortableChildren = true;
      world.addChild(unitsLayer);
      unitsLayerRef.current = unitsLayer;

      // Fits the map into whatever screen size is currently valid. Called
      // both when terrain arrives and on every resize, since either one can
      // happen before the other is ready (a fixed regression: the first
      // version ran this once, right after building the terrain sprite,
      // trusting app.screen to already reflect the flex container's final
      // size -- when it didn't, a zero/invalid scale collapsed the whole
      // world container to nothing, and only the unrelated 2D-canvas
      // minimap kept rendering).
      fitCameraRef.current = () => {
        const terrain = terrainRef.current;
        const currentApp = appRef.current;
        if (!terrain || !currentApp || hasFitCameraRef.current) return;
        const screenW = currentApp.screen.width;
        const screenH = currentApp.screen.height;
        if (!(screenW > 0 && screenH > 0)) return;
        const rawScale = Math.min(screenW / terrain.width, screenH / terrain.height) * 0.92;
        if (!Number.isFinite(rawScale) || rawScale <= 0) return;
        const scale = Math.max(rawScale, 0.05);
        world.scale.set(scale);
        world.x = (screenW - terrain.width * scale) / 2;
        world.y = (screenH - terrain.height * scale) / 2;
        hasFitCameraRef.current = true;
      };

      const resizeObserver = new ResizeObserver(() => fitCameraRef.current());
      if (canvas.parentElement) resizeObserver.observe(canvas.parentElement);

      // Pan (drag) and zoom (wheel). Plain DOM listeners on the canvas --
      // simpler than wiring Pixi's stage-wide interaction for a two-gesture
      // need, and coexists fine with Pixi's own per-sprite hit testing for
      // unit picking (both are ordinary listeners on the same element).
      // Handlers are named so the cleanup below can actually remove them --
      // an earlier version didn't, which stacked duplicate window-level
      // listeners across Vite hot-reloads and caused erratic drag behavior.
      let dragging = false;
      let lastX = 0;
      let lastY = 0;

      const onPointerDown = (e: PointerEvent) => {
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
      };
      const onPointerMove = (e: PointerEvent) => {
        if (dragging) {
          world.x += e.clientX - lastX;
          world.y += e.clientY - lastY;
          lastX = e.clientX;
          lastY = e.clientY;
        }
        const rect = canvas.getBoundingClientRect();
        lastPointerCanvasPosRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        updateHoverRef.current();
      };
      const onPointerLeave = () => {
        lastPointerCanvasPosRef.current = null;
        updateHoverRef.current();
      };
      const onPointerUp = () => {
        dragging = false;
      };
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const cursorX = e.clientX - rect.left;
        const cursorY = e.clientY - rect.top;
        const worldXBefore = (cursorX - world.x) / world.scale.x;
        const worldYBefore = (cursorY - world.y) / world.scale.y;
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        // Markers are drawn at their real (small) world-unit radius, so
        // zooming further in is exactly what makes them, and their owner
        // ring, bigger and legible -- raised well past the old cap of 8 for
        // that reason.
        const nextScale = Math.min(60, Math.max(0.2, world.scale.x * factor));
        world.scale.set(nextScale);
        world.x = cursorX - worldXBefore * nextScale;
        world.y = cursorY - worldYBefore * nextScale;
        updateHoverRef.current();
      };

      canvas.addEventListener("pointerdown", onPointerDown);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointerleave", onPointerLeave);
      canvas.addEventListener("wheel", onWheel, { passive: false });

      mapHandleRef.current = {
        recenterOn(worldX, worldY) {
          if (!appRef.current) return;
          const screenW = appRef.current.screen.width;
          const screenH = appRef.current.screen.height;
          world.x = screenW / 2 - worldX * world.scale.x;
          world.y = screenH / 2 - worldY * world.scale.y;
        },
      };

      cleanupListenersRef.current = () => {
        canvas.removeEventListener("pointerdown", onPointerDown);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        canvas.removeEventListener("pointerleave", onPointerLeave);
        canvas.removeEventListener("wheel", onWheel);
        resizeObserver.disconnect();
      };

      setPixiReady(true);
    })();

    return () => {
      destroyed = true;
      cleanupListenersRef.current?.();
      cleanupListenersRef.current = null;
      appRef.current?.destroy(true, { children: true });
      appRef.current = null;
      hasFitCameraRef.current = false;
      setPixiReady(false);
    };
  }, []);

  // Terrain texture: rebuilt only when a new recording's terrain arrives.
  useEffect(() => {
    const world = worldRef.current;
    const app = appRef.current;
    if (!world || !app || !terrain) return;

    terrainRef.current = terrain;
    hasFitCameraRef.current = false;

    const canvas = buildTerrainCanvas(terrain);
    const texture = PIXI.Texture.from(canvas);
    // Nearest-neighbor, not the default linear/bilinear filtering -- each
    // texture pixel is exactly one world-unit cell, and linear filtering
    // blurs those cell boundaries into smooth gradients when the map is
    // scaled up for display ("washed out"), making it hard to judge scale
    // (e.g. a unit's real footprint next to a ramp) at a glance.
    texture.source.scaleMode = "nearest";
    const sprite = new PIXI.Sprite(texture);
    terrainSpriteRef.current?.destroy();
    world.addChildAt(sprite, 0);
    terrainSpriteRef.current = sprite;

    fitCameraRef.current();
  }, [terrain, pixiReady]);

  // Extra *invisible* hit-test padding (world units) so tiny real objects
  // (a 0.375-radius Drone, a 0.125-radius mineral chunk) stay clickable
  // without inflating what's actually drawn -- an earlier version used a
  // 1-unit *visual* floor instead, which rendered every small unit at up
  // to ~2.7x its real size (a Drone at radius 1 instead of 0.375) and was
  // exactly why the map's sense of scale felt wrong (e.g. a ramp looking
  // like only one worker could fit down it, when several real-sized ones
  // do). Size on screen is now the game's real radius, full stop.
  const HIT_PADDING = 0.3;
  // A real, but small, visual floor -- Egg/Larva are 0.125 in-game, the
  // smallest radius in the data, and were barely a pixel even at moderate
  // zoom. The reference tool applies no floor at all (confirmed by reading
  // its source), so this is a deliberate, modest departure for visibility,
  // not a scale-fidelity bug like the old 1.0 floor was.
  const MIN_VISUAL_RADIUS = 0.35;

  // Units: redrawn each time the current loop's frame changes. Markers are
  // full Graphics rebuilds every tick during playback, which drops Pixi's
  // own per-object hover tracking (an object hovered a moment ago no longer
  // exists) -- hover is instead computed centrally in updateHoverRef, driven
  // by the last known pointer position, and re-run after every rebuild so it
  // survives moving through loops without the mouse itself moving.
  useEffect(() => {
    const layer = unitsLayerRef.current;
    if (!layer || !terrain) return;

    const pool = unitVisualsRef.current;
    const seenTags = new Set<number>();

    for (const unit of frame?.units ?? []) {
      if (!unit.pos) continue;
      seenTags.add(unit.tag);

      const isSelected = unit.tag === selectedTag;
      const info = unitTypeInfo[unit.unitType];
      const radius = Math.max(unit.radius, MIN_VISUAL_RADIUS);
      const ownerColor = colorForOwner(unit.owner);

      // Real icon art (see public/icons/SOURCE.md) when we have it for this
      // unit type; the existing category-color shape as a fallback for the
      // ~40% of real-game unit types with no matching icon (all resources,
      // destructibles, Egg, etc. -- checked against the committed fixture).
      // loadIconTexture caches by name, so calling it again on a later tick
      // while still pending is a no-op, not a re-fetch.
      if (info?.name && !iconTexturesRef.current.has(unit.unitType)) {
        const typeId = unit.unitType;
        loadIconTexture(info.name).then((texture) => {
          iconTexturesRef.current.set(typeId, texture);
          if (texture) setIconVersion((v) => v + 1);
        });
      }
      const texture = iconTexturesRef.current.get(unit.unitType) ?? null;

      let visual = pool.get(unit.tag);
      if (!visual) {
        const container = new PIXI.Container();
        const shape = new PIXI.Graphics();
        const icon = new PIXI.Sprite();
        icon.anchor.set(0.5);
        const underConstruction = new PIXI.Graphics();
        const selection = new PIXI.Graphics();
        container.addChild(shape, icon, underConstruction, selection);
        container.eventMode = "static";
        container.cursor = "pointer";
        visual = { container, shape, icon, underConstruction, selection };
        pool.set(unit.tag, visual);
        layer.addChild(container);
      }

      visual.shape.clear();

      if (texture) {
        // A light tint (blended most of the way to white first, since tint
        // is multiplicative and the full owner color would darken/muddy
        // this full-color art) nudges the icon's hue toward the owner's
        // without hiding the artwork -- distinguishability comes from the
        // icon itself plus this tint, no separate frame/border needed.
        visual.icon.texture = texture;
        visual.icon.tint = lightenTint(ownerColor, 0.35);
        visual.icon.width = radius * 2;
        visual.icon.height = radius * 2;
        visual.icon.visible = true;
      } else {
        visual.icon.visible = false;
        const fillColor = colorForCategory(info?.category);
        // Fill encodes category (unit/building/mineral/gas); a translucent
        // owner-colored wash tints the same shape on top -- a "tinge," not
        // a ring, so it never changes the marker's outer footprint (unlike
        // a stroke, which either pads outward or, at best, eats into the
        // fill). Buildings get a rounded square instead of a circle so
        // category reads at a glance even before color registers. `radius`
        // already matches roughly half a building's real tile footprint
        // (verified against known buildings: Hatchery 2.75 for a 5-tile
        // building, SpawningPool 1.8125 for a 3-tile one), so the full
        // footprint width is radius*2, not some smaller fraction of it.
        if (info?.category === "building") {
          const side = radius * 2;
          const cornerRadius = radius * 0.35;
          visual.shape.roundRect(-side / 2, -side / 2, side, side, cornerRadius).fill(fillColor);
          visual.shape.roundRect(-side / 2, -side / 2, side, side, cornerRadius).fill({ color: ownerColor, alpha: 0.45 });
        } else {
          visual.shape.circle(0, 0, radius).fill(fillColor);
          visual.shape.circle(0, 0, radius).fill({ color: ownerColor, alpha: 0.45 });
        }
      }

      // Building still under construction: cover the not-yet-built top
      // portion so the finished icon/shape doesn't show before it's earned,
      // revealing it bottom-up as build_progress climbs toward 1 -- same
      // metaphor the reference tool uses.
      visual.underConstruction.clear();
      if (unit.buildProgress < 1) {
        const side = radius * 2;
        const uncoveredHeight = side * (1 - unit.buildProgress);
        visual.underConstruction.rect(-side / 2, -side / 2, side, uncoveredHeight).fill({ color: 0x0c0e11, alpha: 0.65 });
      }

      // Units render above buildings above neutral resources, regardless of
      // frame.units' own (unsorted) order.
      visual.container.zIndex = info?.category === "unit" ? 2 : info?.category === "building" ? 1 : 0;

      visual.selection.clear();
      if (isSelected) {
        visual.selection.circle(0, 0, radius).stroke({ width: Math.max(radius * 0.12, 0.12), color: 0xffffff, alignment: 0 });
      }

      visual.container.x = unit.pos.x;
      visual.container.y = terrain.height - unit.pos.y;
      // Hit area a bit larger than the visible marker -- easier to click
      // small units precisely, especially before zooming in. Padding only,
      // not a visual floor -- see the HIT_PADDING comment above.
      visual.container.hitArea = new PIXI.Circle(0, 0, radius + HIT_PADDING);
      visual.container.removeAllListeners("pointertap");
      visual.container.on("pointertap", () => onSelectUnit(unit));
    }

    for (const [tag, visual] of pool) {
      if (!seenTags.has(tag)) {
        visual.container.destroy({ children: true });
        pool.delete(tag);
      }
    }

    updateHoverRef.current = () => {
      const world = worldRef.current;
      const pointer = lastPointerCanvasPosRef.current;
      if (!world || !pointer) {
        setHover((h) => (h === null ? h : null));
        return;
      }
      const worldX = (pointer.x - world.x) / world.scale.x;
      const worldY = (pointer.y - world.y) / world.scale.y;
      let closest: { unit: UnitSummaryIpc; dist: number } | null = null;
      for (const unit of frame?.units ?? []) {
        if (!unit.pos) continue;
        const ux = unit.pos.x;
        const uy = terrain.height - unit.pos.y;
        const hitRadius = unit.radius + HIT_PADDING;
        const dist = Math.hypot(worldX - ux, worldY - uy);
        if (dist <= hitRadius && (!closest || dist < closest.dist)) closest = { unit, dist };
      }
      if (!closest) {
        setHover((h) => (h === null ? h : null));
        return;
      }
      const info = unitTypeInfo[closest.unit.unitType];
      const label = info?.name ?? `Unit type ${closest.unit.unitType}`;
      setHover({ x: pointer.x, y: pointer.y, label });
    };
    updateHoverRef.current();
  }, [frame, selectedTag, terrain, pixiReady, unitTypeInfo, iconVersion]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
      {hover && (
        <div
          style={{
            position: "absolute",
            left: hover.x + 12,
            top: hover.y + 12,
            background: "#1b1f26",
            border: "1px solid #2b323d",
            borderRadius: 4,
            padding: "3px 7px",
            fontSize: 12,
            color: "#e7e9ec",
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          {hover.label}
        </div>
      )}
    </div>
  );
}
