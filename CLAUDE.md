# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

**Spectator**: a standalone Electron desktop tool that runs a headless StarCraft II client in Docker, proxies a bot's connection to it, visualizes live games and replays, ingests bot telemetry over a separate NDJSON-file channel, and stores every game for later review. It is prior art to `vscode-starcraft` but ships its own Dockerfile/image instead of relying on `stephanzlatarev/starcraft`'s opaque proxy.

`SC2 Bot Dev Tool — Implementation Plan.md` is the design spec. **Read it before implementing anything**: it contains decisions, rejected alternatives, and open unknowns that are not repeated here, and section numbers (§3.3, §6.3, §7.1) are referenced throughout the code comments.

## Commands

```
npm run build          # tsc -> dist/ (the CLIs run from dist, so build first)
npm run typecheck      # both tsconfigs; tsconfig.web.json is NOT covered by `build`
npm run verify         # build + the deterministic check suites (see Testing)
npm run dev            # electron-vite dev, the app with HMR
npm run build:app      # electron-vite production build into out/
```

CLIs, all of which need `npm run build` first. **Call them through `node`, not
`npm run`**: npm 12 validates flags even after `--`, so `npm run testbot --
--end surrender` fails with `EUNKNOWNCONFIG`. The npm scripts still work if a
second `--` is added (`npm run testbot -- -- --end surrender`), which is more
trouble than it is worth.

```
node dist/cli/session.js --map TorchesAIE_v4.SC2Map [--mode A|B|BvB] [--ai Zerg/Hard/Rush,Protoss/Medium] [--watch 1|2] [--games-dir DIR]
node dist/cli/record.js --map TorchesAIE_v4.SC2Map --out game.sqlite [--sc2-port 5001]
node dist/cli/dump.js game.sqlite --loop 5000
node dist/cli/import-telemetry.js game.sqlite --file run.ndjson [--seat 1|2]
node dist/cli/testbot.js --end surrender --loops 1000 --telemetry telemetry [--command] [--debug-draw] [--race Protoss --hallucinate]
node dist/cli/replay.js --file game.SC2Replay [--file ...] [--games-dir DIR] [--out game.sqlite] [--watch N] [--player N] [--step 8]
node dist/cli/probe-replay.js --file game.SC2Replay
node dist/cli/probe-twoplayer.js --map TorchesAIE_v4.SC2Map [--api-ports 5001,5002] [--start-port 5100] [--loops 2000] [--games 2]
```

`testbot` also joins ladder-style, as AI Arena starts a bot, with
`--LadderServer 127.0.0.1 --GamePort <port> --StartPort <port>`, which is how
`probe-twoplayer` gets two bots into one game.

`session` is the headless equivalent of the app's live session: it owns the
container, records a file per game, saves replays and creates the next game.
`record` is the minimal single-game recorder and expects a container to be
running already; it is what fixtures are made with. `replay` converts
`.SC2Replay` files the way the app's queue does, one game file each with every
viewpoint: `--watch N` converts only that one (0 is the observer slot, which
sees everything) and `--player` is whose result the game file calls its own.

Python emitter (no dependencies, not part of the npm build):

```
python -m unittest discover -s emitter/python
python emitter/python/sample_emitter.py --data-dir . --loops 800
```

Container, which listens on host port 5001:

```
./run-spike.ps1              # build the image and run it, tailing logs
docker run -d --name sc2-observer-spike -p 127.0.0.1:5001:5001 \
  -v "C:\dev\sc2-observer\maps:/root/StarCraftII/Maps" sc2-observer-spike
```

SC2 is pinned to **4.10 (Build 75689)**, the last Linux headless build Blizzard published. Do not upgrade it: no newer Linux build exists, and bot-vs-bot games desync past ~5.0.

## Non-negotiable design rules

These are load-bearing constraints from the plan, not stylistic preferences. Violating them breaks the tool's core premise:

- **Bot-ignorance rule**: the app must never encode knowledge of any bot's architecture, race, layer names, or module names. It only understands channel strings (the `ch` field) and the five telemetry kinds (§3). If an implementation detail requires knowing what a bot's code looks like, that is a design error. This extends to the test bot: no app code may reference it or behave differently when it is the peer.
- **Zero pause coordination**: the proxy forwards every frame unchanged, in order, without delaying, reordering, or dropping bot traffic, and never sends `step` or `action` on the bot's behalf while a bot is connected. A halted bot (a breakpoint) freezes the lockstep game on its own; the app only displays the frozen state. There is no timeout-based state change.
- **Loop number, not wall-clock, is the only time axis**, for both game state and telemetry.
- **Stop and ask on ambiguity**: if a design question is not answered by the plan, or two options tie, ask rather than guess.

## Architecture

One Electron main process owns the Docker manager, game proxy, session controller, telemetry tailer, and the SQLite store. One renderer draws the viewer and never touches sockets or the filesystem: IPC only, through the typed `contextBridge` in `src/preload/index.ts`. Everything flows through one in-process `EventBus`, so live view, history view, and persistence consume the same stream. Plan §4 tabulates each component's explicit "must not do" constraints; read it before touching proxy, session controller, or telemetry code.

```
src/bus/          EventBus: frame, gameEnded, telemetry
src/proxy/        GameProxy (Mode A: the proxy sends createGame itself)
src/replay/       ReplayDriver (plays a .SC2Replay), ReplaySession (records it), ReplayQueue (every viewpoint, one replay at a time),
                  replayFile (reads a replay's build and players straight from the file, no client)
src/protocol/     protobufjs loader for the vendored .proto files
src/state/        decode helpers: frames (units, request/response classification), terrain, unitTypes;
                  and the overlays derived from the game itself: intent, debugDraw, GameOverlays
src/history/      HistoryStore, one SQLite file per game
src/telemetry/    parse, TelemetryModel (retention), TelemetryResolver, ingest, TelemetryTailer
src/shared/       IPC and telemetry types, shared by main and renderer
src/main/         Electron entry and all IPC handlers
src/renderer/     React + PixiJS viewer
src/cli/          record, dump, import-telemetry, testbot, verify-*
emitter/python/   the emitter bots vendor, plus its sample and tests
vendor/           s2clientprotocol .proto files, pinned
src/vendor/       Blizzard's s2protocol decoder, build 75689 only (see its SOURCE.md)
```

### Traps that have already cost time

- **protobufjs and proto2 enum defaults.** An unset optional enum field decodes as its first value, which for `ResponseJoinGame.error` is `MissingParticipation = 1`. Testing `if (response.join_game.error)` reports every successful join as a failure. Check presence with `Object.prototype.hasOwnProperty.call(...)`, never truthiness. The schema loader needs `keepCase: true`, or `oneof` request fields are silently never set. The same goes for a `oneof`: an unset `target_unit_tag` reads as `0` beside a real `target_world_space_pos`, so which target a command has is also a presence check.
- **protobufjs decodes enums as numbers, and only `toJSON` renders names.** `JSON.stringify(decoded)` shows `"result": "Defeat"` while reading the same field gives `2`, so a value that looked right in a log was written to a game file as `2.0`. It cost time twice (a game's result, then a replay's races and player types). Anything stored or displayed goes through `enumName()` in `src/protocol/schema.ts`.
- **Any handler on a socket must be attached before yielding.** Attaching a `message` listener after an `await` loses frames that arrive during the gap: `ws` neither buffers them nor errors, and both sides hang forever with no diagnostic.
- **`tsconfig.web.json` is not covered by `npm run build`.** Run `npm run typecheck`, or renderer type errors accumulate unnoticed.
- **`npm run dev` hot-reloads the renderer only.** A change under `src/main`, `src/preload`, or anything they import (`src/state`, `src/session`, ...) needs the dev server restarted, or the window keeps running the previous build and the fix appears not to work. Restarting also kills any live session, which is a hard kill, so the container it owned is left behind: `docker rm -f sc2-observer`.
- **PixiJS v8 does not free a sprite's texture on `destroy()`** unless asked: pass `{children: true, texture: true, textureSource: true}`.

## Persistence

One SQLite file per game (better-sqlite3, WAL) plus a global catalog file that holds settings and nothing else (`src/history/CatalogStore.ts`; the games themselves are read from the folder on demand, see `src/history/peek.ts`). Observations are Brotli-compressed raw protobuf bytes, not JSON (sizing rationale in §6.1). A single global database and flat-file-only storage were both considered and rejected (§6.2).

A frame carries the viewpoint it was seen through (`frames.viewpoint`, schema v4): 0 is the observer slot, else a player id, and meta `viewpoints` lists the views a file holds in full. NULL means the file's only viewpoint, which is every live game and every file from before v4, so those read exactly as they always did. The store reads one viewpoint at a time (`readViewpoint`, the first listed by default).

The schema is versioned in `meta.schema_version` with ordered additive migrations in `HistoryStore.MIGRATIONS`. Opening a file migrates it, and the store refuses a file newer than the build understands. **Adding a migration means adding to that array, never editing an existing one.**

Telemetry state at loop L is the nearest checkpoint at or before L (every 500 loops) plus a forward replay of stored messages. That is what makes the history browser identical to the live view by construction rather than by discipline.

## Telemetry contract (§3)

Bots write NDJSON to `<data dir>/telemetry/<timestamp>-<name>.ndjson`; the app tails it locally and imports it for AI Arena matches. Five kinds only, plus `hello`/`end`: `overlay`, `series`, `event`, `snapshot`, `entity`. Each has a specific retention rule in §3.3 (overlay and snapshot replace per channel, entity replaces per `(ch, tag)`, series and events append, overlays with a `ttl` expire). Getting these right is what lets history and live share rendering code.

Field spellings live in `src/shared/telemetry-types.ts`, which both the viewer and the test-bot emitter compile against, so the two cannot drift. Bad lines are rejected individually with a reason and are never fatal.

## Testing

Everything below the viewer is tested against recorded frames and bytes, never against a live game, so tests stay deterministic:

- `npm run verify` builds and runs nine suites: `verify-extraction` (decode/terrain/unit categorization against a temp copy of `fixtures/phase1-sample-game.sqlite`, so the committed 20 MB fixture is never dirtied), `verify-overlays` (command-intent lines against the same fixture copy, plus synthetic chains, unit targets and debug draws), `verify-telemetry` (checkpointing across multiple streams, and detach), `verify-catalog` (peeking real files in a temp folder, tags, export), `verify-replay` (the driver against a scripted client, the game file a replay becomes, and the queue: every viewpoint, stopping, refusals, waiting for the client), `verify-tailer` (partial lines, a UTF-8 character split across reads, rejections, one file per game and the ignore list, driving `poll()` directly rather than racing its timer), `verify-docker`, `verify-proxy` and `verify-session`.
- `fixtures/testbot-vs-ai.SC2Replay` is a replay of the test bot against the built-in AI; `verify-replay` checks the file reader against what the SC2 client reported for it.
- `fixtures/testbot-smoke.sqlite` plus `fixtures/testbot-smoke.ndjson` are a paired recording and telemetry file on the same loops, for viewer work.
- **Never let a build write to a committed fixture.** Opening one migrates it and leaves the repo dirty; copy it to a temp dir first.

The live path (proxy, session controller, tailer) cannot be covered that way, so `src/cli/testbot.ts` is a scripted SC2 API client: it joins like a real bot, steps for a set number of loops, optionally writes a conformant telemetry file, gives raw unit orders (`--command`), draws with the debug API (`--debug-draw`), casts Sentry hallucinations (`--race Protoss --hallucinate`), and ends the game on command (`surrender`, `leave`, `disconnect`, `hang`, `play`) so failure modes reproduce in seconds instead of a full game. It is a dev tool only. The real python-sc2 bot at `C:\dev\sc2-ai` stays the realism oracle and **must not be modified** for this project's needs.

Replay facts, measured by `node dist/cli/probe-replay.js` rather than read off the proto: `replay_info` and `start_replay` both accept the replay as **bytes** (`replay_data`), so nothing is copied into the container; a replay ends by the client leaving `in_replay`, which is what the driver stops on; `replay_info` carries the map, the length in loops, the build and every player with race and result, so a converted replay is filed with its outcome before a loop is stepped; and **`disable_fog` does not mean "see everything"**. Watching as player 1 with fog off showed 27 units at loop 200 of a test game (that player's own vision); the same replay from the observer slot (`observed_player_id = 0`) with fog off showed 229 (both players and every neutral). Full-map review is the observer slot; watching as a player is the other, equally useful thing.

A hallucination is its real unit's type plus `is_hallucination`, and that flag already answers "does this viewpoint know". Measured with `testbot --race Protoss --hallucinate`: the creator's live view, the observer slot and a replay watched as the creator flagged all three hallucinations, and the opponent's replay saw one unflagged. The case where the opponent detects one is not measured yet.

Live-path facts already established, so they do not need re-deriving: `surrender` (via `debug.end_game`) is the only fast end that yields a real `player_result`; `leave` transitions `in_game -> launched` cleanly but produces no `player_result`, so `record` hangs; a bot that **disconnects leaves SC2 in `in_game` forever with no status transition**, so a finished session must be detected from the bot socket closing, not from game status; recovery is `leave_game` on a fresh connection, after which `create_game` works with no container restart.

Two-player facts (2026-09-24, `node dist/cli/probe-twoplayer.js` with two test bots joining ladder-style), for bot-vs-bot:
- **The two clients must share localhost.** Bots never set `host_ip`, and even with it set, two containers on a Docker network hung in `join_game` for good. What works is one container running two SC2 processes (A), or two containers where the second joins the first's network namespace (B). A and B ran at the same speed, about 11 to 15 s per 2000 loops at step 8, and the same total memory, about 2.2 GiB.
- **Both clients have to `leave_game` after every game.** Without it, the next game's `create_game` crashed the host client with a segfault. With it, three games in a row worked on both layouts.
- **A dead client hangs the other side forever.** The survivor's bot never sees an error. The survivor itself recovers with `leave_game`, which takes it from `ended` to `launched`, and the dead client needs its container restarted.
- **Each layout can hide a dead client.** In A, only the process started last is the container's main process: when the other one crashed, the container still said `Up`. In B, restarting the first container leaves the second `running` but unreachable until it is restarted too. So in both, the working recovery is to restart everything. That makes **A the recommendation**, provided its entrypoint stops the whole container as soon as either client exits, so a dead client shows up as a stopped container.

## Build order and current phase

Six phases (§7), each depending on the prior and ending with something runnable: Phase 0 (Dockerfile + proxy spike) → Phase 1 (decode + record) → Phase 2 (viewer on recordings) → Phase 3 (telemetry file) → Phase 4 (live session + Docker UI) → Phase 5 (history browser) → Phase 6 (replays + debug draws).

**Phases 0 through 5 are complete**, each verified against live games rather than only fixtures.

**Phase 6 is done for local bot development.** The replay path works: `.SC2Replay` files are queued (drag-and-drop, several at once, or "Open Replays..."), converted in the background into ordinary games holding every viewpoint, and the telemetry file from that match attaches to the result, which is §7's exit criterion for it. Command-intent lines and native debug draws are done too, seen live and in the reopened recording.

**Deferred on purpose (2026-09-24), not unfinished:** keyboard shortcuts, settings (ports, folders, retention) and the installer. The project owner judged them unnecessary for now, so do not pick them up unasked. Until then the app runs from the repo (`npm run dev`), and games go to `<userData>/games`. §7's installer exit criterion stays unmet.

Unit icons are owner-supplied PNGs in `src/renderer/public/icons/`, named after the unit type names the API's `data` response reports (`LurkerMP`, `SwarmHostMP`, `TemplarArchive`), not display names. `src/renderer/src/icons.ts` lists them and aliases variants (burrowed, sieged, add-ons, cocoons) to a base image. A hallucination uses `<Unit>Hallucination.png`, chosen by the recorded `is_hallucination` flag. Where each file came from is in `SOURCE.md` there.

Decisions already taken that should not be re-litigated:

- **Before a replay is queued, the user picks which views to convert (2026-09-26), all ticked by default.** The import dialog reads each file's players with `replayFile` (no client needed), and for several files offers one set of choices for all or a choice per file. A replay from another build is refused there, before anything is queued.
- **A replay is converted in the background, every chosen viewpoint, into one game file, and opened once it is all there (2026-09-25).** SC2 cannot seek a replay backwards, and it plays a replay from one `observed_player_id`, fixed at `start_replay`; one view's fog cannot be derived from another's. So `ReplayQueue` plays each replay once from the observer slot, then once as each player, at full speed, every pass into the same file under its own viewpoint. The owner chose waiting once (about 50 s per view for an 11-minute game) over waiting again for each extra view, and one file over one per view. Replays are queued, one converts at a time, and the Games list shows each with its progress; the viewer's header offers a viewpoint switch that keeps the loop. Watching while converting was tried and dropped (`c77ad8d`, reverted by this). Stopping keeps the views already finished and drops the partial one, except that a first view is kept rather than leaving nothing.
- **Whose eyes and whose result are separate.** The viewpoint decides how much of the map a frame holds; the subject player (the first participant) decides whose result the row reports. A ladder replay is filed under the bot's result whichever view is on screen.
- **The client is one seat.** Conversions wait while a live session runs and resume when it ends; a session is refused while a replay is converting, enforced in `src/main/ipc.ts`, because SC2 accepts one connection at a time and a session's `ensureClientReady({replaceRunning: true})` would destroy a container a conversion was using. A conversion's frames never reach the live view, and its pass endings are not the live game's `gameEnded`.
- **Retention, when it is built, reports and never deletes on its own**: the folder's size plus a manual "delete games older than X" behind the same confirmation as a single delete.
- `CatalogStore` (`<userData>/catalog.sqlite`) holds settings and nothing else. That is where the settings step belongs. There is deliberately **no `games` table**: under WAL a cache of the game files has no workable staleness key, so `listGames` peeks the folder on every call (the reasoning is in `src/history/peek.ts`).
- Game files are named in UTC while the catalog shows local time, deliberately: names stay sortable and unambiguous, and the row's tooltip carries the path.
- **Intent lines and debug draws are derived when asked, never stored.** `GameOverlays` is fed frames one at a time, from the bus while a game is live and from the stored frames when a recording opens, and `src/main/ipc.ts` merges its overlays and channels into the telemetry answers on the way out. Nothing lands in the telemetry tables, so checkpoints, detach and streams never see them. Every recording already held its action frames, so old games get intent lines; debug frames are only stored from this build on.
- Intent: one channel per ability, `_game/intent/<friendly_name>`, specific abilities folded into their general form. A line lasts while the unit exists and its `orders` still hold it; the orders are the tail of what it was told, which is also how a queued chain drops its finished links. Commands with no target draw nothing and make no channel.
- Debug draws follow SC2: each draw request replaces the last, one overlay per color on `_game/debug`. Screen-space text is skipped, and JSON in debug text is not read as shapes; the telemetry file is for that. `MapView` pools overlays by channel and position for this.
- **Bot vs bot (mode `BvB`).** The user starts both bots ladder-style; the app never launches one. It runs one container with two SC2 clients (`SC2_CLIENTS=2`, API ports 5001 and 5002; the container stops as soon as either client exits), and one `GameProxy` per seat:
  - Seat 1's proxy creates the game with two bot slots.
  - Each bot joins with `--LadderServer 127.0.0.1 --StartPort 5100` and `--GamePort` 5000 (player 1) or 5010 (player 2). The session status carries these as `seats`.
  - Only the watched seat's frames are recorded and shown live, because each proxy sees its own bot's fogged view. A change of watched seat applies from the next game.
  - After a game, the replay is saved and **both clients `leave_game`** before the next `create_game`.
  - A stopped container fails the session instead of waiting on a hung game.
  - Each file's `players` meta says which bot was which.
  - Full-map review is not recorded live: it is "Convert Replay" on the game, which queues its `.SC2Replay` into a new game with every viewpoint.
- **Built-in AIs (Mode A): one to three**, each with race, difficulty and build (`src/shared/ai-options.ts`; the stored form is the proto's names). **A map with too few start locations drops the extra AIs without any error** (measured on 4.10), so the session compares the game's `game_info` player count with what it asked for, and warns in the status and in the game file's `warning` meta. The AI Arena ladder maps are all two-player; `maps/Flat48`, `Flat64`, `Flat96` and `Flat128` (Blizzard's Melee pack, committed, see `maps/SOURCE.md`) take four.
- **Telemetry is one file per player.** In a bot-vs-bot game each player has their own folder and stream (`streams.seat`, schema v3), and **every channel is filed under `P1/` or `P2/` at ingest**, so two bots writing the same channel names cannot overwrite each other. Such a game refuses a file whose player is not given. One-bot games have no seat and no prefix.
- A game file is **four files** (`.sqlite`, `-wal`, `-shm`, `.SC2Replay`). Anything that copies, moves or deletes one has to account for all of them; `src/history/gameFiles.ts` is the one place that says so.
