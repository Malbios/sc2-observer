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
