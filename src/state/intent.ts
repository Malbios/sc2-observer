import type { Request, Response } from "../protocol/schema";
import type { LineShape, OverlayStateIpc, Point2, TelemetryStyle } from "../shared/telemetry-types";
import { toSafeNumber } from "./frames";

/**
 * Command-intent lines: where a bot told its units to go, read from the
 * `Request.action` frames every recording already holds.
 *
 * Nothing here knows any bot. Channels are named by SC2's own ability data
 * (`friendly_name` from the data frame), which is the game's vocabulary, not a
 * bot's, so the bot-ignorance rule holds.
 */

/** §3.6 reserves `_game/` for what the game itself draws. */
export const INTENT_PREFIX = "_game/intent/";

/** Thinner than the telemetry default: one line per commanded unit adds up. */
export const INTENT_STYLE: TelemetryStyle = { width: 0.2, opacity: 0.8 };

export type CommandTarget = { kind: "point"; pos: Point2 } | { kind: "unit"; tag: number };

export interface UnitCommand {
  loop: number;
  abilityId: number;
  /** Null for a command with no target ("Train Drone"), which draws nothing
   * but still occupies a slot in the unit's order queue. */
  target: CommandTarget | null;
  queued: boolean;
}

export interface IssuedCommand {
  tags: number[];
  command: UnitCommand;
}

const has = (value: unknown, field: string): boolean =>
  typeof value === "object" && value !== null && Object.prototype.hasOwnProperty.call(value, field);

/**
 * Every raw unit command in one action request. The target is a oneof, and an
 * unset `target_unit_tag` decodes as 0 off the prototype, so presence is
 * checked on the message itself rather than by reading the value.
 */
export function readUnitCommands(request: Request, loop: number): IssuedCommand[] {
  const out: IssuedCommand[] = [];
  for (const action of request.action?.actions ?? []) {
    const raw = has(action, "action_raw") ? action.action_raw : null;
    if (!raw || !has(raw, "unit_command")) continue;
    const command = raw.unit_command;
    let target: CommandTarget | null = null;
    if (has(command, "target_world_space_pos")) {
      const pos = command.target_world_space_pos;
      target = { kind: "point", pos: [pos.x ?? 0, pos.y ?? 0] };
    } else if (has(command, "target_unit_tag")) {
      target = { kind: "unit", tag: toSafeNumber(command.target_unit_tag) };
    }
    out.push({
      tags: (command.unit_tags ?? []).map(toSafeNumber),
      command: {
        loop,
        abilityId: command.ability_id ?? 0,
        target,
        queued: command.queue_command === true,
      },
    });
  }
  return out;
}

/**
 * The channel each ability draws on, from the data frame. A specific ability
 * is folded into the general one it remaps to (Attack Attack -> Attack), so
 * one toggle covers every unit's version of the same order.
 */
export function abilityChannels(data: Response): Map<number, string> {
  const abilities = new Map<number, Record<string, any>>();
  for (const ability of data.data?.abilities ?? []) {
    abilities.set(ability.ability_id, ability);
  }
  const channels = new Map<number, string>();
  for (const [id, ability] of abilities) {
    const general = ability.remaps_to_ability_id ? abilities.get(ability.remaps_to_ability_id) : undefined;
    const named = general ?? ability;
    const name = named.friendly_name || named.button_name || named.link_name || `Ability ${named.ability_id}`;
    // A slash would read as a deeper level of the channel tree.
    channels.set(id, INTENT_PREFIX + String(name).replaceAll("/", "-"));
  }
  return channels;
}

interface ObservedUnit {
  pos: Point2 | null;
  orderCount: number;
}

function observedUnits(observation: Response): Map<number, ObservedUnit> {
  const units = new Map<number, ObservedUnit>();
  for (const unit of observation.observation?.observation?.raw_data?.units ?? []) {
    units.set(toSafeNumber(unit.tag), {
      pos: unit.pos ? [unit.pos.x, unit.pos.y] : null,
      orderCount: Array.isArray(unit.orders) ? unit.orders.length : 0,
    });
  }
  return units;
}

/**
 * Each unit's outstanding commands at a loop, resolved forward like the
 * telemetry resolver: scrubbing ahead applies the few commands in between,
 * rewinding starts again from the first.
 *
 * Commands are appended in loop order, which both sources guarantee: a
 * recording is read sorted, and live frames arrive in the order they happen.
 */
export class IntentModel {
  private readonly commands: IssuedCommand[] = [];
  private byUnit = new Map<number, UnitCommand[]>();
  private applied = 0;
  private resolvedLoop = -1;
  /** Abilities that have been ordered with a target, which is what makes a
   * channel: a command that draws nothing has nothing to toggle. */
  private readonly targetedAbilities = new Set<number>();

  /** Returns true when this introduced an ability not seen before. */
  add(issued: IssuedCommand[]): boolean {
    let fresh = false;
    for (const entry of issued) {
      this.commands.push(entry);
      if (entry.command.target && !this.targetedAbilities.has(entry.command.abilityId)) {
        this.targetedAbilities.add(entry.command.abilityId);
        fresh = true;
      }
    }
    return fresh;
  }

  get isEmpty(): boolean {
    return this.targetedAbilities.size === 0;
  }

  abilities(): number[] {
    return [...this.targetedAbilities];
  }

  private advanceTo(loop: number): void {
    if (loop < this.resolvedLoop) {
      this.byUnit = new Map();
      this.applied = 0;
    }
    while (this.applied < this.commands.length && this.commands[this.applied]!.command.loop <= loop) {
      const { tags, command } = this.commands[this.applied]!;
      for (const tag of tags) {
        const queue = command.queued ? (this.byUnit.get(tag) ?? []) : [];
        queue.push(command);
        this.byUnit.set(tag, queue);
      }
      this.applied++;
    }
    this.resolvedLoop = loop;
  }

  /**
   * The lines at `loop`, one overlay per ability, drawn against `observation`.
   *
   * A line runs from the unit's current position to its target, a point or
   * the target unit where it is now. Queued commands continue from the
   * previous target as a chain. The unit's own `orders` say how much of that
   * queue is still outstanding: its orders are the tail of what it was told,
   * so a unit with no orders is done and draws nothing, and a unit with one
   * order left has finished every earlier link of the chain. A command issued
   * at or after the observation's own loop is shown whole, since the
   * observation was taken before the unit could have acted on it.
   */
  overlaysAt(loop: number, observation: Response, channelOf: (abilityId: number) => string): OverlayStateIpc[] {
    this.advanceTo(loop);
    if (this.byUnit.size === 0) return [];

    const observedLoop: number = observation.observation?.observation?.game_loop ?? loop;
    const units = observedUnits(observation);
    const shapesByChannel = new Map<string, LineShape[]>();

    for (const [tag, queue] of this.byUnit) {
      const unit = units.get(tag);
      if (!unit?.pos) continue;
      const latest = queue[queue.length - 1]!;
      const outstanding = latest.loop >= observedLoop ? queue.length : Math.min(unit.orderCount, queue.length);
      if (outstanding === 0) continue;

      let from: Point2 = unit.pos;
      for (const command of queue.slice(queue.length - outstanding)) {
        if (!command.target) continue;
        let to: Point2 | null;
        if (command.target.kind === "point") {
          to = command.target.pos;
        } else {
          to = units.get(command.target.tag)?.pos ?? null;
        }
        // A target unit out of sight has nowhere to draw to.
        if (!to) continue;
        const ch = channelOf(command.abilityId);
        const shapes = shapesByChannel.get(ch) ?? [];
        shapes.push({ type: "line", from, to });
        shapesByChannel.set(ch, shapes);
        from = to;
      }
    }

    return [...shapesByChannel].map(([ch, shapes]) => ({ ch, loop, style: INTENT_STYLE, shapes }));
  }
}
