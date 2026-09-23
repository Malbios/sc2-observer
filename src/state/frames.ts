import type { FrameKind } from "../bus/EventBus";
import type { Request, Response } from "../protocol/schema";

/**
 * Only ResponseObservation carries `game_loop` directly (see sc2api.proto's
 * Observation message). Every other frame kind we store is tagged with the
 * most recently observed loop, matching §6.3 of the plan: "gameInfo and data
 * appear once... Observation is self-contained."
 */
export class LoopTracker {
  private currentLoop = 0;

  observe(response: Response): number {
    const loop = response.observation?.observation?.game_loop;
    if (typeof loop === "number") {
      this.currentLoop = loop;
    }
    return this.currentLoop;
  }

  get loop(): number {
    return this.currentLoop;
  }

  /** Back to zero for a new game on the same proxy. Without this the next
   * game's pre-observation frames would be tagged with the previous game's
   * final loop, which reads as a recording that starts near its own end. */
  reset(): void {
    this.currentLoop = 0;
  }
}

export function classifyResponse(response: Response): FrameKind | null {
  if (response.game_info) return "gameInfo";
  if (response.data) return "data";
  if (response.observation) return "observation";
  return null;
}

export function classifyRequest(request: Request): FrameKind | null {
  if (request.action) return "action";
  return null;
}

export interface UnitSummary {
  tag: number;
  unitType: number;
  owner: number;
  radius: number;
  /** [0, 1]; 1 (the default when absent, e.g. for non-buildings) means
   * fully built. */
  buildProgress: number;
  pos: { x: number; y: number; z: number } | null;
}

/**
 * `tag` is a uint64 (raw.proto), which protobufjs decodes as a `Long`
 * instance (the optional `long` package is installed here) rather than a
 * plain number. That's invisible in string contexts -- Long's toString()
 * happens to print the right decimal value, which is how this went unnoticed
 * in the CLI's template-string dump output -- but breaks silently anywhere
 * that needs a real number: Electron IPC's structured clone strips Long's
 * prototype down to a bare {low,high,unsigned} object, and `===` comparisons
 * (e.g. matching the selected unit) never match across two separately
 * decoded instances even for the same logical tag. SC2 tags fit well within
 * Number.MAX_SAFE_INTEGER, so a plain conversion loses nothing.
 */
export function toSafeNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (value && typeof (value as { toNumber?: () => number }).toNumber === "function") {
    return (value as { toNumber: () => number }).toNumber();
  }
  return Number(value);
}

/** Scoped-down "game state model": exactly what the Phase 1 dump CLI needs
 * to verify a recorded observation against what the bot itself saw. Full
 * delta tracking / normalization for the live viewer is Phase 2 work. */
export function extractUnits(observationResponse: Response): UnitSummary[] {
  const units = observationResponse?.observation?.observation?.raw_data?.units ?? [];
  return units.map((u: any) => ({
    tag: toSafeNumber(u.tag),
    unitType: u.unit_type,
    owner: u.owner,
    radius: typeof u.radius === "number" ? u.radius : 0.5,
    buildProgress: typeof u.build_progress === "number" ? u.build_progress : 1,
    pos: u.pos ? { x: u.pos.x, y: u.pos.y, z: u.pos.z } : null,
  }));
}
