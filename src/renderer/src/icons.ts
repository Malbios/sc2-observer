import * as PIXI from "pixi.js";

const cache = new Map<string, Promise<PIXI.Texture | null>>();

/** Icons render at a few dozen px, and GPU minification from 512px drew
 * black boxes around them. Pre-shrinking with the canvas's resampling
 * avoids that. */
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

/** Mipmapping straight alpha averages in the color of transparent pixels,
 * which showed as gray edges on small icons. Premultiplied, that color is 0. */
function cleanTransparency(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = canvas.getContext("2d")!;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    data[i] = Math.round(data[i] * a);
    data[i + 1] = Math.round(data[i + 1] * a);
    data[i + 2] = Math.round(data[i + 2] * a);
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

async function loadProcessedTexture(url: string): Promise<PIXI.Texture> {
  const img = new Image();
  img.src = url;
  await img.decode(); // rejects on a missing/invalid image -- caller falls back
  const texture = PIXI.Texture.from(cleanTransparency(toCanvas(img)));
  // The pixels are already premultiplied above; tell Pixi not to redo it
  // (or worse, treat straight-alpha math as premultiplied) on upload.
  texture.source.alphaMode = "premultiplied-alpha";
  return texture;
}

/** Mineral field variants (MineralField, MineralField750, LabMineralField,
 * ...) all share one real depiction of the actual in-game crystal cluster
 * object, rich ones (RichMineralField, PurifierRichMineralField750, ...)
 * another, and geyser variants share one real geyser depiction -- unlike the
 * earlier vscode-starcraft `minerals.png`/`vespene.png`, which turned out to
 * be generic resource-counter icons for a HUD panel, not the map object
 * itself. The first pattern that matches wins, so rich comes before plain.
 */
const GENERIC_ICON_PATTERNS: [RegExp, string][] = [
  [/richmineralfield/i, "richminerals.png"],
  [/mineralfield/i, "minerals.png"],
  [/richvespenegeyser/i, "richvespene.png"],
  [/geyser|vespene/i, "vespene.png"],
  [/^DestructibleRock/i, "rocks.png"],
];

/** Unit types with user-supplied .png art (see public/icons/SOURCE.md),
 * named exactly as the API's `data` response names them, which is also
 * where python-sc2's UnitTypeId names come from. A type that is not listed
 * here, not aliased and not a resource has no icon and draws as a shape,
 * without a request for a file that does not exist. */
const PNG_ICONS = new Set([
  "BanelingNest", "CreepTumor", "EvolutionChamber", "Extractor", "ExtractorRich", "GreaterSpire", "Hatchery",
  "Hive", "HydraliskDen", "InfestationPit", "Lair", "LurkerDenMP", "NydusNetwork", "NydusCanal", "RoachWarren",
  "SpawningPool", "SpineCrawler", "Spire", "SporeCrawler", "UltraliskCavern",
  "Baneling", "Changeling", "Corruptor", "Drone", "Egg", "Hydralisk", "Infestor", "Larva", "LocustMP",
  "LocustMPFlying", "LurkerMP", "Mutalisk", "Overlord", "OverlordTransport", "Overseer", "Queen",
  "Ravager", "Roach", "SwarmHostMP", "Viper", "Zergling", "Ultralisk", "BroodLord", "Broodling",
  "BanelingBurrowed", "DroneBurrowed", "HydraliskBurrowed", "InfestorBurrowed", "LurkerMPBurrowed",
  "QueenBurrowed", "RavagerBurrowed", "RoachBurrowed", "SwarmHostBurrowedMP", "UltraliskBurrowed",
  "ZerglingBurrowed", "BanelingCocoon", "BroodLordCocoon", "LurkerMPEgg", "OverlordCocoon", "RavagerCocoon",
  "InfestorTerran", "InfestedTerransEgg",
  "Armory", "AutoTurret", "Barracks", "BarracksFlying", "Bunker", "CommandCenter", "CommandCenterFlying",
  "EngineeringBay", "Factory", "FactoryFlying", "FusionCore", "GhostAcademy", "MissileTurret",
  "OrbitalCommand", "OrbitalCommandFlying", "PlanetaryFortress", "Reactor", "Refinery", "RefineryRich",
  "SensorTower",
  "Starport", "StarportFlying", "SupplyDepot", "SupplyDepotLowered", "TechLab",
  "Banshee", "Battlecruiser", "Cyclone", "Ghost", "Hellion", "HellionTank", "Liberator", "LiberatorAG",
  "Marauder", "Marine", "Medivac", "MULE", "Raven", "Reaper", "SCV", "SiegeTank", "SiegeTankSieged", "Thor",
  "ThorAP", "VikingAssault", "VikingFighter", "WidowMine", "WidowMineBurrowed",
  "Assimilator", "AssimilatorRich", "CyberneticsCore", "DarkShrine", "FleetBeacon", "Forge", "Gateway", "Nexus", "PhotonCannon",
  "Pylon", "RoboticsFacility", "RoboticsBay", "ShieldBattery", "Stargate", "OracleStasisTrap", "TemplarArchive",
  "TwilightCouncil", "WarpGate",
  "Adept", "AdeptPhaseShift", "Archon", "Carrier", "Colossus", "DarkTemplar", "Disruptor", "DisruptorPhased",
  "HighTemplar", "Immortal", "Interceptor", "Mothership", "Observer", "Oracle", "Phoenix", "Probe", "Sentry",
  "Stalker", "Tempest", "VoidRay", "WarpPrism", "WarpPrismPhasing", "Zealot", "ForceField",
  "XelNagaTower", "InhibitorZoneSmall",
  // What a Sentry can hallucinate, drawn with the eye badge. See
  // resolveIconUrl below; the plain Hallucination.png is the badge
  // alone, for the unit inspector, not a unit type.
  "AdeptHallucination", "ArchonHallucination", "ColossusHallucination", "DisruptorHallucination",
  "HighTemplarHallucination", "ImmortalHallucination", "OracleHallucination", "PhoenixHallucination",
  "ProbeHallucination", "StalkerHallucination", "VoidRayHallucination", "WarpPrismHallucination",
  "WarpPrismPhasingHallucination", "ZealotHallucination",
]);

/** Unit types that are another form of one we have art for: burrowed,
 * uprooted, morphing or disguised. The API gives each its own name, so
 * without this they would draw as plain shapes. */
const ICON_ALIASES: Record<string, string> = {
  InfestorTerranBurrowed: "InfestorTerran",
  CreepTumorBurrowed: "CreepTumor",
  CreepTumorQueen: "CreepTumor",
  SpineCrawlerUprooted: "SpineCrawler",
  SporeCrawlerUprooted: "SporeCrawler",
  OverseerSiegeMode: "Overseer",
  ChangelingZealot: "Changeling",
  ChangelingMarine: "Changeling",
  ChangelingMarineShield: "Changeling",
  ChangelingZergling: "Changeling",
  ChangelingZerglingWings: "Changeling",
  TransportOverlordCocoon: "OverlordCocoon",
  InhibitorZoneMedium: "InhibitorZoneSmall",
  InhibitorZoneLarge: "InhibitorZoneSmall",
  // Add-ons are named after the building they are attached to.
  BarracksTechLab: "TechLab",
  FactoryTechLab: "TechLab",
  StarportTechLab: "TechLab",
  BarracksReactor: "Reactor",
  FactoryReactor: "Reactor",
  StarportReactor: "Reactor",
  BroodlingEscort: "Broodling",
  LocustMPPrecursor: "LocustMP",
  ObserverSiegeMode: "Observer",
  PylonOvercharged: "Pylon",
};

/** Relative, not `/icons/`: the built app loads index.html from disk, where
 * a leading slash means the drive root, and every icon silently failed. */
function resolveIconUrl(requested: string, hallucination: boolean): string | null {
  const name = ICON_ALIASES[requested] ?? requested;
  for (const [pattern, file] of GENERIC_ICON_PATTERNS) {
    if (pattern.test(name)) return `icons/${file}`;
  }
  // A hallucination is its real unit's type plus a flag, so its art is
  // chosen here rather than by type. A type with no hallucination art of its
  // own keeps its normal icon rather than dropping to a shape.
  const hallucinated = `${name}Hallucination`;
  if (hallucination && PNG_ICONS.has(hallucinated)) return `icons/${hallucinated}.png`;
  return PNG_ICONS.has(name) ? `icons/${name}.png` : null;
}

export interface UnitBadge {
  url: string;
  label: string;
}

const HALLUCINATION_BADGE: UnitBadge = { url: "icons/Hallucination.png", label: "Hallucination" };
const LIFTED_BADGE: UnitBadge = { url: "icons/Flying.png", label: "Lifted off" };
const SHADE_BADGE: UnitBadge = { url: "icons/Shade.png", label: "Adept shade" };

const LIFTED_BUILDINGS = new Set([
  "BarracksFlying", "CommandCenterFlying", "FactoryFlying", "OrbitalCommandFlying", "StarportFlying",
]);

/** The badges drawn into a unit's map icon, on their own, for marking the
 * unit outside the map. */
export function unitBadges(typeName: string | undefined, hallucination: boolean): UnitBadge[] {
  const badges: UnitBadge[] = [];
  if (hallucination) badges.push(HALLUCINATION_BADGE);
  if (typeName && LIFTED_BUILDINGS.has(typeName)) badges.push(LIFTED_BADGE);
  if (typeName === "AdeptPhaseShift") badges.push(SHADE_BADGE);
  return badges;
}

/** Loads the icon for a unit type name (see public/icons/SOURCE.md for
 * provenance of the portraits), caching both hits and misses by name
 * so a type without an icon is only ever attempted once, not retried per
 * unit instance. */
export function loadIconTexture(name: string, hallucination = false): Promise<PIXI.Texture | null> {
  const key = hallucination ? `${name}|hallucination` : name;
  let promise = cache.get(key);
  if (!promise) {
    const url = resolveIconUrl(name, hallucination);
    promise = url ? loadProcessedTexture(url).catch(() => null) : Promise.resolve(null);
    cache.set(key, promise);
  }
  return promise;
}
