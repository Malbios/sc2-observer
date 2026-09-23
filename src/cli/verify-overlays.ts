/**
 * Checks the overlays the app derives from the game's own frames (command
 * intent from `Request.action`) against the real bot's recording and against
 * synthetic frames for the cases that recording does not contain.
 *
 * Run with: node dist/cli/verify-overlays.js
 */
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HistoryStore } from "../history/HistoryStore";
import { decodeRequest, decodeResponse, encodeRequest, encodeResponse, type Response } from "../protocol/schema";
import { abilityChannels, IntentModel, INTENT_PREFIX, readUnitCommands } from "../state/intent";
import type { LineShape, OverlayStateIpc } from "../shared/telemetry-types";

const FIXTURE = "fixtures/phase1-sample-game.sqlite";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "ok  " : "FAIL"} ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  if (!pass) failures++;
}

function main(): void {
  // A throwaway copy, as in verify-extraction: opening the fixture migrates
  // it, which must never dirty the committed file.
  const scratch = mkdtempSync(path.join(tmpdir(), "spectator-verify-"));
  const fixture = path.join(scratch, path.basename(FIXTURE));
  copyFileSync(FIXTURE, fixture);
  try {
    checkFixtureIntent(fixture);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  checkSyntheticIntent();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

const lines = (overlays: OverlayStateIpc[], ch: string): LineShape[] =>
  (overlays.find((overlay) => overlay.ch === ch)?.shapes ?? []) as LineShape[];

// -- the real bot's recording ---------------------------------------------

/** The drone that became the Spawning Pool, measured from the fixture. */
const POOL_DRONE = 4356833281;
const POOL_TARGET: [number, number] = [122.5, 163.5];

function checkFixtureIntent(fixturePath: string): void {
  const store = new HistoryStore(fixturePath);
  const dataBytes = store.readFrameAtOrBefore("data", 0);
  if (!dataBytes) throw new Error("no data frame in fixture");
  const channels = abilityChannels(decodeResponse(dataBytes));
  const channelOf = (id: number): string => channels.get(id) ?? `${INTENT_PREFIX}Ability ${id}`;

  const model = new IntentModel();
  for (const frame of store.readFrames("action", "request")) {
    model.add(readUnitCommands(decodeRequest(frame.bytes), frame.loop));
  }
  const observationAt = (loop: number): Response => {
    const bytes = store.readFrameAtOrBefore("observation", loop);
    if (!bytes) throw new Error(`no observation at ${loop}`);
    return decodeResponse(bytes);
  };

  const names = model.abilities().map(channelOf).sort();
  check("channels are the abilities ordered with a target", names, [
    `${INTENT_PREFIX}Attack`,
    `${INTENT_PREFIX}Build SpawningPool`,
  ]);
  check("a no-target Train command makes no channel", names.some((name) => name.includes("Train")), false);

  const drone = (loop: number): { from: [number, number]; to: [number, number] } | undefined => {
    const observation = observationAt(loop);
    const unit = (observation.observation.observation.raw_data.units as any[]).find(
      (u) => Number(u.tag) === POOL_DRONE,
    );
    const line = lines(model.overlaysAt(loop, observation, channelOf), `${INTENT_PREFIX}Build SpawningPool`)[0];
    return unit && line ? { from: [unit.pos.x, unit.pos.y], to: line.to } : undefined;
  };

  check("nothing is drawn before the command", lines(model.overlaysAt(576, observationAt(576), channelOf), `${INTENT_PREFIX}Build SpawningPool`).length, 0);
  const at600 = drone(600);
  check("the build command draws to its target at 600", at600?.to, POOL_TARGET);
  const line600 = lines(model.overlaysAt(600, observationAt(600), channelOf), `${INTENT_PREFIX}Build SpawningPool`)[0];
  check("from where the drone is at 600", line600?.from, at600?.from);
  check(
    "and is gone at 700, when the drone has become the pool",
    lines(model.overlaysAt(700, observationAt(700), channelOf), `${INTENT_PREFIX}Build SpawningPool`).length,
    0,
  );
  // Scrubbing back has to restart the resolution, not keep what 700 applied.
  check("rewinding to 600 draws it again", drone(600)?.to, POOL_TARGET);

  const attack = lines(model.overlaysAt(3240, observationAt(3240), channelOf), `${INTENT_PREFIX}Attack`);
  check("the attack command draws a line per unit that is still under way", attack.length > 0, true);
  check("to the attack's target", attack[0]?.to, [124.5, 48.5]);

  store.close();
}

// -- synthetic frames --------------------------------------------------------

const MOVE = 16;
const ATTACK = 3674;
const SMART = 1;

/** Built and decoded rather than written as objects, so tags go through the
 * same Long decoding a real frame does. */
function action(commands: Record<string, unknown>[]): ReturnType<typeof decodeRequest> {
  return decodeRequest(
    encodeRequest({ action: { actions: commands.map((command) => ({ action_raw: { unit_command: command } })) } }),
  );
}

interface FakeUnit {
  tag: number;
  x: number;
  y: number;
  orders?: number;
}

function observation(loop: number, units: FakeUnit[]): Response {
  return decodeResponse(
    encodeResponse({
      observation: {
        observation: {
          game_loop: loop,
          raw_data: {
            units: units.map((unit) => ({
              tag: unit.tag,
              unit_type: 1,
              owner: 1,
              pos: { x: unit.x, y: unit.y, z: 0 },
              orders: Array.from({ length: unit.orders ?? 0 }, () => ({ ability_id: MOVE })),
            })),
          },
        },
      },
    }),
  );
}

function checkSyntheticIntent(): void {
  const data = decodeResponse(
    encodeResponse({
      data: {
        abilities: [
          { ability_id: MOVE, friendly_name: "Move" },
          { ability_id: 23, friendly_name: "Attack Attack", remaps_to_ability_id: ATTACK },
          { ability_id: ATTACK, friendly_name: "Attack" },
          { ability_id: SMART, friendly_name: "Smart" },
        ],
      },
    }),
  );
  const channels = abilityChannels(data);
  const channelOf = (id: number): string => channels.get(id)!;
  check("a specific ability is named after its general form", channelOf(23), `${INTENT_PREFIX}Attack`);

  // Queued commands chain from one target to the next.
  {
    const model = new IntentModel();
    model.add(readUnitCommands(action([{ ability_id: MOVE, unit_tags: [1], target_world_space_pos: { x: 10, y: 10 } }]), 8));
    model.add(
      readUnitCommands(
        action([{ ability_id: 23, unit_tags: [1], target_world_space_pos: { x: 20, y: 10 }, queue_command: true }]),
        8,
      ),
    );
    const overlays = model.overlaysAt(16, observation(16, [{ tag: 1, x: 0, y: 0, orders: 2 }]), channelOf);
    check("the first link runs from the unit", lines(overlays, `${INTENT_PREFIX}Move`), [
      { type: "line", from: [0, 0], to: [10, 10] },
    ]);
    check("the queued link continues from the first target", lines(overlays, `${INTENT_PREFIX}Attack`), [
      { type: "line", from: [10, 10], to: [20, 10] },
    ]);

    const later = model.overlaysAt(40, observation(40, [{ tag: 1, x: 10, y: 10, orders: 1 }]), channelOf);
    check("a finished link drops out of the chain", lines(later, `${INTENT_PREFIX}Move`).length, 0);
    check("and the rest now starts at the unit", lines(later, `${INTENT_PREFIX}Attack`), [
      { type: "line", from: [10, 10], to: [20, 10] },
    ]);

    // An unqueued command replaces the chain.
    model.add(readUnitCommands(action([{ ability_id: MOVE, unit_tags: [1], target_world_space_pos: { x: 5, y: 5 } }]), 48));
    const replaced = model.overlaysAt(56, observation(56, [{ tag: 1, x: 10, y: 10, orders: 1 }]), channelOf);
    check("an unqueued command replaces the chain", lines(replaced, `${INTENT_PREFIX}Move`), [
      { type: "line", from: [10, 10], to: [5, 5] },
    ]);
    check("leaving nothing of the old one", lines(replaced, `${INTENT_PREFIX}Attack`).length, 0);
  }

  // A unit-target command follows its target, and dies with its unit.
  {
    const model = new IntentModel();
    model.add(readUnitCommands(action([{ ability_id: SMART, unit_tags: [1], target_unit_tag: 2 }]), 8));
    const first = model.overlaysAt(16, observation(16, [{ tag: 1, x: 0, y: 0, orders: 1 }, { tag: 2, x: 30, y: 30 }]), channelOf);
    check("a unit target is drawn to", lines(first, `${INTENT_PREFIX}Smart`), [{ type: "line", from: [0, 0], to: [30, 30] }]);
    const moved = model.overlaysAt(24, observation(24, [{ tag: 1, x: 1, y: 1, orders: 1 }, { tag: 2, x: 35, y: 30 }]), channelOf);
    check("and followed where it goes", lines(moved, `${INTENT_PREFIX}Smart`), [{ type: "line", from: [1, 1], to: [35, 30] }]);
    const dead = model.overlaysAt(32, observation(32, [{ tag: 2, x: 35, y: 30 }]), channelOf);
    check("a dead unit's line is gone", dead.length, 0);
  }

  // A command given at the observation's own loop cannot show in its orders
  // yet, and is drawn anyway; an idle unit after that is done.
  {
    const model = new IntentModel();
    model.add(readUnitCommands(action([{ ability_id: MOVE, unit_tags: [1], target_world_space_pos: { x: 9, y: 9 } }]), 16));
    const same = model.overlaysAt(16, observation(16, [{ tag: 1, x: 0, y: 0, orders: 0 }]), channelOf);
    check("a command at the observation's loop is drawn before its order shows", lines(same, `${INTENT_PREFIX}Move`).length, 1);
    const idle = model.overlaysAt(24, observation(24, [{ tag: 1, x: 9, y: 9, orders: 0 }]), channelOf);
    check("an idle unit draws nothing", idle.length, 0);
  }

  // No target, no line, no channel.
  {
    const model = new IntentModel();
    const fresh = model.add(readUnitCommands(action([{ ability_id: 1342, unit_tags: [1] }]), 8));
    check("a no-target command introduces no channel", fresh, false);
    check("and leaves the model empty", model.isEmpty, true);
  }
}

main();
