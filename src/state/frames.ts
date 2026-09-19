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
  pos: { x: number; y: number; z: number } | null;
}

/** Scoped-down "game state model": exactly what the Phase 1 dump CLI needs
 * to verify a recorded observation against what the bot itself saw. Full
 * delta tracking / normalization for the live viewer is Phase 2 work. */
export function extractUnits(observationResponse: Response): UnitSummary[] {
  const units = observationResponse?.observation?.observation?.raw_data?.units ?? [];
  return units.map((u: any) => ({
    tag: u.tag,
    unitType: u.unit_type,
    owner: u.owner,
    pos: u.pos ? { x: u.pos.x, y: u.pos.y, z: u.pos.z } : null,
  }));
}
