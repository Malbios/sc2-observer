/**
 * Checks the proxy's per-game bookkeeping against synthetic frames, with no
 * container and no bot.
 *
 * Two of these guard bugs that only appear in the *second* game of a session,
 * which is the expensive place to find them: `storedOnceKinds` and the loop
 * tracker were instance fields that nothing ever reset, so game two would have
 * published no `gameInfo`/`data` (leaving the viewer with no terrain and no
 * unit names) and tagged its early frames with game one's final loop.
 *
 * Run with: node dist/cli/verify-proxy.js
 */
import { EventBus, type ClientStatusEvent, type FrameEvent, type GameEndedEvent } from "../bus/EventBus";
import { encodeResponse } from "../protocol/schema";
import { SC2_STATUS } from "../protocol/status";
import { GameProxy } from "../proxy/GameProxy";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "ok  " : "FAIL"} ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  if (!pass) failures++;
}

interface Recorder {
  frames: FrameEvent[];
  ends: GameEndedEvent[];
  statuses: ClientStatusEvent[];
  proxy: GameProxy;
}

/** A proxy wired to a fresh bus, never started, so nothing touches a socket. */
function harness(): Recorder {
  const bus = new EventBus();
  const frames: FrameEvent[] = [];
  const ends: GameEndedEvent[] = [];
  const statuses: ClientStatusEvent[] = [];
  bus.on("frame", (event) => frames.push(event));
  bus.on("gameEnded", (event) => ends.push(event));
  bus.on("clientStatus", (event) => statuses.push(event));
  const proxy = new GameProxy({ sessionId: "test", bus, mapPath: "Test.SC2Map" });
  return { frames, ends, statuses, proxy };
}

const observation = (loop: number, status: number, ended = false): Uint8Array =>
  encodeResponse({
    status,
    observation: {
      observation: { game_loop: loop },
      // A real game reports every player, which is why the result has to be
      // resolved against the id the bot joined as rather than read off the
      // front of the list.
      ...(ended
        ? {
            player_result: [
              { player_id: 1, result: 2 /* Defeat */ },
              { player_id: 2, result: 1 /* Victory */ },
            ],
          }
        : {}),
    },
  });

const gameInfo = (status: number): Uint8Array => encodeResponse({ status, game_info: { map_name: "Test" } });
const gameData = (status: number): Uint8Array => encodeResponse({ status, data: {} });

function main(): void {
  // -- a game ends exactly once ------------------------------------------
  {
    const { ends, proxy } = harness();
    proxy.publishResponse(observation(100, SC2_STATUS.inGame));
    check("an ordinary observation does not end the game", ends.length, 0);

    // A surrendered game repeats player_result in every later observation and
    // holds status at `ended`, so both signals fire over and over.
    proxy.publishResponse(observation(200, SC2_STATUS.ended, true));
    proxy.publishResponse(observation(208, SC2_STATUS.ended, true));
    proxy.publishResponse(observation(216, SC2_STATUS.ended, true));
    check("the game ends once, not once per frame", ends.length, 1);
    check("player_result is the reason, not the status it arrived with", ends[0]!.reason, "result");
    check("the end carries the loop it happened at", ends[0]!.loop, 200);
  }

  // -- status alone ends a game (a bot that leaves cleanly) ---------------
  {
    const { ends, statuses, proxy } = harness();
    proxy.publishResponse(observation(50, SC2_STATUS.inGame));
    proxy.publishResponse(encodeResponse({ status: SC2_STATUS.launched, leave_game: {} }));
    check("leaving ends the game with no player_result", ends.length, 1);
    check("the reason is the status transition", ends[0]!.reason, "status");
    check("transitions are published", statuses.map((s) => s.status), [SC2_STATUS.inGame, SC2_STATUS.launched]);
    check("the first transition has no predecessor", statuses[0]!.previous, null);
  }

  // -- status is only published when it changes ---------------------------
  {
    const { statuses, proxy } = harness();
    for (let loop = 0; loop < 5; loop++) proxy.publishResponse(observation(loop * 8, SC2_STATUS.inGame));
    check("an unchanged status is not re-announced", statuses.length, 1);
  }

  // -- gameInfo and data are stored once per game -------------------------
  {
    const { frames, proxy } = harness();
    proxy.publishResponse(gameInfo(SC2_STATUS.inGame));
    proxy.publishResponse(gameData(SC2_STATUS.inGame));
    proxy.publishResponse(gameInfo(SC2_STATUS.inGame));
    proxy.publishResponse(gameData(SC2_STATUS.inGame));
    check("a re-requested gameInfo is not stored twice", frames.filter((f) => f.kind === "gameInfo").length, 1);
    check("nor is data", frames.filter((f) => f.kind === "data").length, 1);

    // ...but observations always are.
    proxy.publishResponse(observation(8, SC2_STATUS.inGame));
    proxy.publishResponse(observation(16, SC2_STATUS.inGame));
    check("observations are all stored", frames.filter((f) => f.kind === "observation").length, 2);
  }

  // -- the second game of a session --------------------------------------
  {
    const { frames, ends, proxy } = harness();
    proxy.publishResponse(gameInfo(SC2_STATUS.inGame));
    proxy.publishResponse(observation(5000, SC2_STATUS.inGame));
    proxy.publishResponse(observation(5008, SC2_STATUS.ended, true));
    check("game one ended", ends.length, 1);

    proxy.resetForNewGame();
    frames.length = 0;
    ends.length = 0;

    proxy.publishResponse(gameInfo(SC2_STATUS.inGame));
    check("game two stores its own gameInfo", frames.filter((f) => f.kind === "gameInfo").length, 1);
    check("game two's pre-observation frames start at loop 0", frames[0]!.loop, 0);
    check("the loop tracker restarted", proxy.currentLoop, 0);

    proxy.publishResponse(observation(24, SC2_STATUS.ended, true));
    check("game two can end on its own account", ends.length, 1);
    check("and at its own loop", ends[0]!.loop, 24);
  }

  // -- the proxy's own socket is refused while a bot holds the relay ------
  {
    const { proxy } = harness();
    check("no bot is attached to a fresh proxy", proxy.botConnected, false);
  }

  // -- the outcome, which the catalog lists games by -----------------------
  {
    const { proxy } = harness();
    check("a fresh proxy knows no result", proxy.lastResult, null);
    check("nor which player the bot is", proxy.botPlayerId, null);

    // The join response is relayed and stored as nothing; the id is read off
    // the decode that happens anyway.
    proxy.publishResponse(encodeResponse({ status: SC2_STATUS.inGame, join_game: { player_id: 2 } }));
    check("the join tells us which player the bot is", proxy.botPlayerId, 2);

    proxy.publishResponse(observation(100, SC2_STATUS.inGame));
    check("an ordinary observation carries no result", proxy.lastResult, null);

    proxy.publishResponse(observation(200, SC2_STATUS.ended, true));
    check("the result is kept once it arrives", proxy.lastResult?.length, 2);
    check("with the player it belongs to", proxy.lastResult?.[0]?.player_id, 1);
    // A live surrender wrote `result = 2.0` into a game file before this
    // check existed: `decode` leaves an enum as its number, and only
    // protobufjs' own `toJSON` renders the name, so the raw array looked
    // right in a log and was a number everywhere it was used.
    check("the result is the enum's name, not its number", proxy.lastResult?.[0]?.result, "Defeat");
    check("and the other player's too", proxy.lastResult?.[1]?.result, "Victory");

    proxy.resetForNewGame();
    // proto2's first enum value is `Victory`, so an entry whose result was
    // never set decodes as a win. Presence, not truthiness.
    proxy.publishResponse(
      encodeResponse({
        status: SC2_STATUS.ended,
        observation: { observation: { game_loop: 300 }, player_result: [{ player_id: 1 }] },
      }),
    );
    check("a result-less entry is not read as a win", proxy.lastResult?.[0]?.result, "unknown");

    proxy.resetForNewGame();
    check("the next game starts with no result", proxy.lastResult, null);
    check("and no player id", proxy.botPlayerId, null);
  }

  // -- a result arriving after the game was already declared over ----------
  {
    // The ordering that made carrying the result on `gameEnded` wrong: the
    // status moves first, the game is declared over, and only the next
    // observation says who won. A debounced event would have frozen an empty
    // payload; a field cannot.
    const { ends, proxy } = harness();
    proxy.publishResponse(observation(50, SC2_STATUS.inGame));
    proxy.publishResponse(encodeResponse({ status: SC2_STATUS.ended }));
    check("the status ended the game", ends.length, 1);
    check("by status, not by result", ends[0]!.reason, "status");

    proxy.publishResponse(observation(58, SC2_STATUS.ended, true));
    check("a late result is still recorded", proxy.lastResult?.length, 2);
    check("and does not end the game a second time", ends.length, 1);
  }

  // -- the relay does not touch what it forwards ---------------------------
  {
    // §4's first rule, and the one this file's subject is now reading fields
    // out of: publishing a frame must not alter the bytes that go on to the
    // bot. Checked against a copy taken before publishing.
    const { proxy } = harness();
    const bytes = observation(1234, SC2_STATUS.inGame, true);
    const before = Array.from(bytes);
    proxy.publishResponse(bytes);
    check("publishing a response leaves its bytes alone", Array.from(bytes), before);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

main();
