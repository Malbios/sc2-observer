import * as PIXI from "pixi.js";

const cache = new Map<string, Promise<PIXI.Texture | null>>();

/** These are simple lossy WebP files (VP8, not VP8L/VP8X) -- a format with
 * no alpha channel at all, so their black background is baked into the
 * pixel data rather than being real transparency. Keyed out here at load
 * time: fully opaque above BRIGHT, fully transparent below DARK, with a
 * linear ramp between them to avoid a hard, jagged cutout edge. */
const DARK = 16;
const BRIGHT = 40;

/** Source icons run up to ~1250px square, but ever render on screen at a
 * few dozen px at most -- a 50x+ minification ratio. Checked the raw pixel
 * data of minerals.png/vespene.png directly: fully-transparent regions are
 * already RGB (0,0,0), so the black boxes weren't a source-data or
 * premultiply problem (premultiplying didn't change these pixels at all,
 * which matches it having made no visible difference). That ratio is
 * squarely GPU minification/mipmap territory instead. Pre-shrinking here
 * with the canvas's own high-quality resampling brings the ratio down to
 * something ordinary bilinear filtering handles cleanly, sidestepping the
 * GPU-side issue entirely rather than fighting its exact mechanism. */
const MAX_TEXTURE_SIZE = 256;

function toCanvas(img: HTMLImageElement): HTMLCanvasElement {
  const scale = Math.min(1, MAX_TEXTURE_SIZE / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, width, height);
  return canvas;
}

/** `keyOutBlackBg`: also runs the black-background keying above (for the
 * .webp portraits). Either way, every pixel's RGB is premultiplied by its
 * own alpha before the texture is created, and the texture is marked as
 * already premultiplied (see below). Canvas ImageData is straight (not
 * premultiplied) alpha; left that way, GPU mipmap generation for a
 * minified texture averages RGB and alpha independently, which can drag
 * a "dead" background color back in at edges even though the pixel is
 * nominally transparent -- exactly the black/gray boxes that only showed
 * up on small, heavily-downscaled instances of an icon and not on a
 * larger one of the same texture. Premultiplying first makes the RGB of a
 * fully transparent pixel genuinely 0, so averaging it with a neighbor
 * can't reintroduce its original color. */
function cleanTransparency(canvas: HTMLCanvasElement, keyOutBlackBg: boolean): HTMLCanvasElement {
  const ctx = canvas.getContext("2d")!;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    if (keyOutBlackBg) {
      const brightness = Math.max(data[i], data[i + 1], data[i + 2]);
      if (brightness <= DARK) {
        data[i + 3] = 0;
      } else if (brightness < BRIGHT) {
        data[i + 3] = Math.round(((brightness - DARK) / (BRIGHT - DARK)) * 255);
      }
    }
    const a = data[i + 3] / 255;
    data[i] = Math.round(data[i] * a);
    data[i + 1] = Math.round(data[i + 1] * a);
    data[i + 2] = Math.round(data[i + 2] * a);
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

async function loadProcessedTexture(url: string, keyOutBlackBg: boolean): Promise<PIXI.Texture> {
  const img = new Image();
  img.src = url;
  await img.decode(); // rejects on a missing/invalid image -- caller falls back
  const texture = PIXI.Texture.from(cleanTransparency(toCanvas(img), keyOutBlackBg));
  // The pixels are already premultiplied above; tell Pixi not to redo it
  // (or worse, treat straight-alpha math as premultiplied) on upload.
  texture.source.alphaMode = "premultiplied-alpha";
  return texture;
}

/** Mineral field variants (MineralField, MineralField750, RichMineralField,
 * RichMineralField750, ...) all share one real depiction of the actual
 * in-game crystal cluster object, and geyser variants share one real
 * geyser depiction -- unlike the earlier vscode-starcraft
 * `minerals.png`/`vespene.png`, which turned out to be generic
 * resource-counter icons for a HUD panel, not the map object itself. These
 * are user-supplied, real RGBA with proper alpha already, so they skip the
 * black-keying step but still go through the same bleed cleanup.
 */
const GENERIC_ICON_PATTERNS: [RegExp, string][] = [
  [/mineralfield/i, "minerals.png"],
  [/geyser|vespene/i, "vespene.png"],
];

/** Unit types with user-supplied .png art (see public/icons/SOURCE.md),
 * named exactly as the API's `data` response names them, which is also
 * where python-sc2's UnitTypeId names come from. Like minerals.png these
 * have real alpha and skip the black-keying step. Anything not listed here
 * falls back to the .webp portraits. */
const PNG_ICONS = new Set([
  "BanelingNest", "CreepTumor", "EvolutionChamber", "Extractor", "GreaterSpire", "Hatchery", "Hive",
  "HydraliskDen", "InfestationPit", "Lair", "LurkerDenMP", "NydusNetwork", "NydusCanal", "RoachWarren",
  "SpawningPool", "SpineCrawler", "Spire", "SporeCrawler", "UltraliskCavern",
  "Baneling", "Changeling", "Corruptor", "Drone", "Egg", "Hydralisk", "Infestor", "Larva", "LocustMP",
  "LocustMPFlying", "LurkerMP", "Mutalisk", "Overlord", "OverlordTransport", "Overseer", "Queen",
  "Ravager", "Roach", "SwarmHostMP", "Viper", "Zergling", "Ultralisk", "BroodLord", "Broodling",
]);

/** Unit types that are another form of one we have art for: burrowed,
 * uprooted, morphing or disguised. The API gives each its own name, so
 * without this they would draw as plain shapes. */
const ICON_ALIASES: Record<string, string> = {
  BanelingBurrowed: "Baneling",
  DroneBurrowed: "Drone",
  HydraliskBurrowed: "Hydralisk",
  RoachBurrowed: "Roach",
  ZerglingBurrowed: "Zergling",
  QueenBurrowed: "Queen",
  InfestorBurrowed: "Infestor",
  RavagerBurrowed: "Ravager",
  UltraliskBurrowed: "Ultralisk",
  LurkerMPBurrowed: "LurkerMP",
  SwarmHostBurrowedMP: "SwarmHostMP",
  CreepTumorBurrowed: "CreepTumor",
  CreepTumorQueen: "CreepTumor",
  SpineCrawlerUprooted: "SpineCrawler",
  SporeCrawlerUprooted: "SporeCrawler",
  OverseerSiegeMode: "Overseer",
  ExtractorRich: "Extractor",
  ChangelingZealot: "Changeling",
  ChangelingMarine: "Changeling",
  ChangelingMarineShield: "Changeling",
  ChangelingZergling: "Changeling",
  ChangelingZerglingWings: "Changeling",
  // Morph cocoons have no art of their own; the egg is the closest.
  BanelingCocoon: "Egg",
  RavagerCocoon: "Egg",
  BroodLordCocoon: "Egg",
  OverlordCocoon: "Egg",
  TransportOverlordCocoon: "Egg",
  LurkerMPEgg: "Egg",
};

function resolveIconUrl(requested: string): string {
  const name = ICON_ALIASES[requested] ?? requested;
  for (const [pattern, file] of GENERIC_ICON_PATTERNS) {
    if (pattern.test(name)) return `/icons/${file}`;
  }
  return PNG_ICONS.has(name) ? `/icons/${name}.png` : `/icons/${name}.webp`;
}

/** Loads the icon for a unit type name (see public/icons/SOURCE.md for
 * provenance of the portraits), caching both hits and misses by name
 * so a type without an icon is only ever attempted once, not retried per
 * unit instance. */
export function loadIconTexture(name: string): Promise<PIXI.Texture | null> {
  let promise = cache.get(name);
  if (!promise) {
    const url = resolveIconUrl(name);
    promise = loadProcessedTexture(url, url.endsWith(".webp")).catch(() => null);
    cache.set(name, promise);
  }
  return promise;
}
