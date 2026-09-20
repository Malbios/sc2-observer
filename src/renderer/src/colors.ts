const NEUTRAL_OWNER = 16;
// High-contrast against the dark, blue-grey terrain ramp in MapView.
const PLAYER_PALETTE = [0x4fd1e8, 0xff6b5b, 0x8be04f, 0xffc24f, 0xc084fc, 0x5fc9c9];

export function colorForOwner(owner: number): number {
  if (owner === NEUTRAL_OWNER) return 0x9c8f78;
  if (owner <= 0) return 0x555a63;
  return PLAYER_PALETTE[(owner - 1) % PLAYER_PALETTE.length];
}

export function cssColor(hex: number): string {
  return `#${hex.toString(16).padStart(6, "0")}`;
}

/** Blends `color` toward white by `1 - amount` -- used as a Sprite.tint for
 * icon art. Tint is multiplicative, so the full owner color would darken
 * and muddy full-color artwork; blending most of the way to white keeps
 * most of a pixel's original brightness/color while still nudging its hue
 * toward the owner's, since white (0xffffff) multiplies as a no-op. */
export function lightenTint(color: number, amount: number): number {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const mix = (channel: number) => Math.round(255 * (1 - amount) + channel * amount);
  return (mix(r) << 16) | (mix(g) << 8) | mix(b);
}

// Fill color encodes *what* something is; colorForOwner (used for the
// outline ring) still encodes *who* controls it. Mineral/gas colors nod to
// their in-game look (light blue crystal / green geyser).
const CATEGORY_COLORS: Record<string, number> = {
  unit: 0xf2e46b,
  building: 0xff9f45,
  mineral: 0x7fd4ff,
  gas: 0x5cd68a,
};

export function colorForCategory(category: string | undefined): number {
  return CATEGORY_COLORS[category ?? "unit"] ?? CATEGORY_COLORS.unit;
}

/** Deliberately distinct from the owner and category ramps above: telemetry
 * is the bot's annotation of the map, and it should never be mistaken for the
 * game's own colors. */
const CHANNEL_PALETTE = [0x7cd6ff, 0xff9ecb, 0xa0f0a8, 0xffd68a, 0xc5a8ff, 0x8ce0d8, 0xffb08a, 0xa8c4ff];

/**
 * A stable color for a channel that declared no `style.color`. Hashing the
 * name rather than assigning by index means a channel keeps its color when
 * other channels appear or disappear, so nothing shifts hue mid-session just
 * because the bot started writing somewhere new.
 */
export function colorForChannel(ch: string): number {
  let hash = 0;
  for (let i = 0; i < ch.length; i++) {
    hash = (hash * 31 + ch.charCodeAt(i)) | 0;
  }
  return CHANNEL_PALETTE[Math.abs(hash) % CHANNEL_PALETTE.length]!;
}

/** Log levels, for event ticks and the log panel. */
const LEVEL_COLORS: Record<string, number> = {
  debug: 0x6b7482,
  info: 0x7cd6ff,
  warn: 0xffc24f,
  error: 0xff6b5b,
};

export function colorForLevel(level: string | undefined): number {
  return LEVEL_COLORS[level ?? "info"] ?? LEVEL_COLORS.info!;
}
