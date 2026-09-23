import { useEffect, useRef, useState, type JSX } from "react";
import * as PIXI from "pixi.js";
import type { FrameAtLoopIpc, TerrainDataIpc, UnitSummaryIpc, UnitTypeInfoIpc } from "../../../shared/ipc-types";
import type { GridShape, TelemetryStateIpc, TextShape } from "../../../shared/telemetry-types";
import { colorForCategory, colorForOwner, lightenTint } from "../colors";
import { loadIconTexture } from "../icons";
import { buildGridTexture, contextFor, drawShapes, gridBounds, makeText, TEXT_ANCHOR_OFFSET } from "../overlayShapes";

/** One telemetry overlay channel's display objects, pooled by channel name so
 * scrubbing reuses them instead of rebuilding GPU geometry every loop -- the
 * same reason the unit markers are pooled. */
interface OverlayVisual {
  container: PIXI.Container;
  graphics: PIXI.Graphics;
  extras: PIXI.Container;
  /** The loop whose content is currently drawn, so scrubbing across loops
   * that did not change a channel skips the redraw entirely. Retention gives
   * one overlay message per channel, so the same loop means the same shapes. */
  drawnLoop: number;
}

/**
 * Text and grid children own generated textures. Pixi does not free a
 * sprite's texture on destroy() unless asked, and a grid channel produces a
 * new texture every time it is redrawn, so omitting this leaks GPU memory
 * until the WebGL context dies -- the same failure the unit pool exists to
 * avoid.
 */
const DESTROY_WITH_TEXTURE = { children: true, texture: true, textureSource: true } as const;

interface UnitVisual {
  container: PIXI.Container;
  shape: PIXI.Graphics;
  icon: PIXI.Sprite;
  underConstruction: PIXI.Graphics;
  selection: PIXI.Graphics;
  /** Entity-channel label, created only for units a bot actually annotated,
   * which is usually a small fraction of the frame. */
  label: PIXI.Text | null;
}

/** Label text height in world units, and the font size it is rendered at
 * before scaling -- same trick as overlay text, since a Pixi Text cannot be
 * sized in world units directly. */
const LABEL_WORLD_HEIGHT = 1.4;
const LABEL_FONT_SIZE = 28;

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
  telemetry: TelemetryStateIpc | null;
  /** Channel names the tree currently has switched on. */
  visibleChannels: ReadonlySet<string>;
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

export function MapView({
  terrain,
  frame,
  selectedTag,
  onSelectUnit,
  unitTypeInfo,
  mapHandleRef,
  telemetry,
  visibleChannels,
}: Props): JSX.Element {
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const appRef = useRef<PIXI.Application | null>(null);
  const worldRef = useRef<PIXI.Container | null>(null);
  const unitsLayerRef = useRef<PIXI.Container | null>(null);
  const overlayLayerRef = useRef<PIXI.Container | null>(null);
  const overlayVisualsRef = useRef<Map<string, OverlayVisual>>(new Map());
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
      // Explicit zIndex rather than insertion order, now that three layers
      // share this container: terrain (0), telemetry overlays (1), units (2).
      // Overlays sit above the ground they annotate but below the units, so a
      // bot's heatmap never hides what it is drawn about.
      world.sortableChildren = true;
      app.stage.addChild(world);
      worldRef.current = world;

      const overlayLayer = new PIXI.Container();
      overlayLayer.zIndex = 1;
      world.addChild(overlayLayer);
      overlayLayerRef.current = overlayLayer;

      const unitsLayer = new PIXI.Container();
      // zIndex-based stacking (units over buildings over neutral resources)
      // instead of insertion order, since frame.units isn't sorted by
      // category -- see where zIndex is set per-marker below.
      unitsLayer.sortableChildren = true;
      unitsLayer.zIndex = 2;
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
    sprite.zIndex = 0;
    terrainSpriteRef.current?.destroy();
    world.addChild(sprite);
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
        visual = { container, shape, icon, underConstruction, selection, label: null };
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

  // Telemetry overlays: one pooled container per overlay, redrawn when the
  // resolved state changes. A bot's channel resolves to one overlay, but a
  // native debug draw has a color per shape and so one overlay per color on
  // the same channel, which is why the pool is keyed by channel and position.
  // Depends on pixiReady for the same reason the effects above do --
  // telemetry can arrive before Pixi has finished its async init, and this
  // would otherwise read a null ref once and never re-run.
  useEffect(() => {
    const layer = overlayLayerRef.current;
    if (!layer || !terrain) return;

    const pool = overlayVisualsRef.current;
    const seen = new Set<string>();
    const perChannel = new Map<string, number>();

    for (const overlay of telemetry?.overlays ?? []) {
      if (!visibleChannels.has(overlay.ch)) continue;
      const index = perChannel.get(overlay.ch) ?? 0;
      perChannel.set(overlay.ch, index + 1);
      const key = `${overlay.ch}#${index}`;
      seen.add(key);

      let visual = pool.get(key);
      if (!visual) {
        const container = new PIXI.Container();
        const graphics = new PIXI.Graphics();
        // Text and grids are display objects rather than paths, so they live
        // in their own child container that is emptied per redraw; the
        // Graphics is simply cleared.
        const extras = new PIXI.Container();
        container.addChild(graphics, extras);
        layer.addChild(container);
        visual = { container, graphics, extras, drawnLoop: -1 };
        pool.set(key, visual);
      }
      visual.container.visible = true;
      // Nothing changed for this channel since it was last drawn; rebuilding a
      // grid texture per scrub tick would be the expensive part of playback.
      if (visual.drawnLoop === overlay.loop) continue;
      visual.drawnLoop = overlay.loop;

      const ctx = contextFor(overlay.ch, overlay.style, terrain.height);
      visual.graphics.clear();
      drawShapes(visual.graphics, overlay.shapes, ctx);

      visual.extras.removeChildren().forEach((child) => child.destroy(DESTROY_WITH_TEXTURE));
      for (const shape of overlay.shapes) {
        if (shape.type === "text") {
          const textShape = shape as TextShape;
          const text = makeText(textShape.text, ctx);
          text.x = textShape.pos[0];
          text.y = terrain.height - textShape.pos[1] - TEXT_ANCHOR_OFFSET;
          visual.extras.addChild(text);
        } else if (shape.type === "grid") {
          const gridShape = shape as GridShape;
          const sprite = new PIXI.Sprite(buildGridTexture(gridShape, ctx.color));
          const bounds = gridBounds(gridShape, terrain.height);
          sprite.x = bounds.x;
          sprite.y = bounds.y;
          sprite.width = bounds.width;
          sprite.height = bounds.height;
          sprite.alpha = ctx.alpha;
          visual.extras.addChild(sprite);
        }
      }
    }

    // A channel that is switched off, or that retention has expired, keeps its
    // container for the next time it appears; only channels gone from the
    // recording entirely are destroyed, which scrubbing never causes.
    for (const [key, visual] of pool) {
      if (!seen.has(key)) {
        visual.graphics.clear();
        visual.extras.removeChildren().forEach((child) => child.destroy(DESTROY_WITH_TEXTURE));
        visual.container.visible = false;
        // Force a redraw if this channel comes back at the same loop it was
        // last drawn at, which switching it off and on again does.
        visual.drawnLoop = -1;
      }
    }
  }, [telemetry, visibleChannels, terrain, pixiReady]);

  // Entity labels (§3.6): a channel whose style.label names a field gets that
  // field rendered next to each annotated unit. Declared after the units
  // effect so the pool it walks is already up to date for this frame; effects
  // run in declaration order.
  //
  // This is also where §3.3's "dropped when the unit disappears from
  // observation" is enforced: a tag with no pooled visual simply has nowhere
  // to draw, so stale annotations cannot linger on the map. The telemetry
  // model itself stays free of any knowledge of game state.
  useEffect(() => {
    const pool = unitVisualsRef.current;
    if (!terrain) return;

    // The label hangs just below the marker, so it needs the same radius the
    // marker was drawn at.
    const radiusByTag = new Map<number, number>();
    for (const unit of frame?.units ?? []) {
      radiusByTag.set(unit.tag, Math.max(unit.radius, MIN_VISUAL_RADIUS));
    }

    const labelByTag = new Map<number, { text: string; color: number }>();
    for (const entity of telemetry?.entities ?? []) {
      if (!visibleChannels.has(entity.ch)) continue;
      const field = typeof entity.style?.label === "string" ? entity.style.label : null;
      if (!field) continue;
      const color = contextFor(entity.ch, entity.style, terrain.height).color;
      for (const [tag, data] of Object.entries(entity.byTag)) {
        const value = (data as Record<string, unknown>)[field];
        if (value === undefined || value === null) continue;
        labelByTag.set(Number(tag), { text: String(value), color });
      }
    }

    for (const [tag, visual] of pool) {
      const entry = labelByTag.get(tag);
      if (!entry) {
        if (visual.label) visual.label.visible = false;
        continue;
      }
      if (!visual.label) {
        const label = new PIXI.Text({
          text: entry.text,
          style: { fontFamily: "system-ui, sans-serif", fontSize: LABEL_FONT_SIZE, fill: entry.color },
        });
        label.anchor.set(0.5, 0);
        label.scale.set(LABEL_WORLD_HEIGHT / LABEL_FONT_SIZE);
        visual.container.addChild(label);
        visual.label = label;
      }
      if (visual.label.text !== entry.text) visual.label.text = entry.text;
      visual.label.style.fill = entry.color;
      // Sits just below the marker, which is drawn centred on the unit.
      visual.label.y = (radiusByTag.get(tag) ?? MIN_VISUAL_RADIUS) + 0.2;
      visual.label.visible = true;
    }
  }, [telemetry, visibleChannels, frame, terrain, pixiReady]);

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
