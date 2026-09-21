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
node dist/cli/session.js --map TorchesAIE.SC2Map [--mode A|B] [--games-dir DIR]
node dist/cli/record.js --map TorchesAIE.SC2Map --out game.sqlite [--sc2-port 5001]
node dist/cli/dump.js game.sqlite --loop 5000
node dist/cli/import-telemetry.js game.sqlite --file run.ndjson
node dist/cli/testbot.js --end surrender --loops 1000 --telemetry telemetry
```

`session` is the headless equivalent of the app's live session: it owns the
container, records a file per game, saves replays and creates the next game.
`record` is the minimal single-game recorder and expects a container to be
running already; it is what fixtures are made with.

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
src/protocol/     protobufjs loader for the vendored .proto files
src/state/        decode helpers: frames (units, request/response classification), terrain, unitTypes
src/history/      HistoryStore, one SQLite file per game
src/telemetry/    parse, TelemetryModel (retention), TelemetryResolver, ingest, TelemetryTailer
src/shared/       IPC and telemetry types, shared by main and renderer
src/main/         Electron entry and all IPC handlers
src/renderer/     React + PixiJS viewer
src/cli/          record, dump, import-telemetry, testbot, verify-*
emitter/python/   the emitter bots vendor, plus its sample and tests
vendor/           s2clientprotocol .proto files, pinned
```

### Traps that have already cost time

- **protobufjs and proto2 enum defaults.** An unset optional enum field decodes as its first value, which for `ResponseJoinGame.error` is `MissingParticipation = 1`. Testing `if (response.join_game.error)` reports every successful join as a failure. Check presence with `Object.prototype.hasOwnProperty.call(...)`, never truthiness. The schema loader needs `keepCase: true`, or `oneof` request fields are silently never set.
- **Any handler on a socket must be attached before yielding.** Attaching a `message` listener after an `await` loses frames that arrive during the gap: `ws` neither buffers them nor errors, and both sides hang forever with no diagnostic.
- **`tsconfig.web.json` is not covered by `npm run build`.** Run `npm run typecheck`, or renderer type errors accumulate unnoticed.
- **`npm run dev` hot-reloads the renderer only.** A change under `src/main`, `src/preload`, or anything they import (`src/state`, `src/session`, ...) needs the dev server restarted, or the window keeps running the previous build and the fix appears not to work. Restarting also kills any live session, which is a hard kill, so the container it owned is left behind: `docker rm -f sc2-observer`.
- **PixiJS v8 does not free a sprite's texture on `destroy()`** unless asked: pass `{children: true, texture: true, textureSource: true}`.

## Persistence

One SQLite file per game (better-sqlite3, WAL) plus a future global catalog. Observations are Brotli-compressed raw protobuf bytes, not JSON (sizing rationale in §6.1). A single global database and flat-file-only storage were both considered and rejected (§6.2).

The schema is versioned in `meta.schema_version` with ordered additive migrations in `HistoryStore.MIGRATIONS`. Opening a file migrates it, and the store refuses a file newer than the build understands. **Adding a migration means adding to that array, never editing an existing one.**

Telemetry state at loop L is the nearest checkpoint at or before L (every 500 loops) plus a forward replay of stored messages. That is what makes the history browser identical to the live view by construction rather than by discipline.

## Telemetry contract (§3)

Bots write NDJSON to `<data dir>/telemetry/<timestamp>-<name>.ndjson`; the app tails it locally and imports it for AI Arena matches. Five kinds only, plus `hello`/`end`: `overlay`, `series`, `event`, `snapshot`, `entity`. Each has a specific retention rule in §3.3 (overlay and snapshot replace per channel, entity replaces per `(ch, tag)`, series and events append, overlays with a `ttl` expire). Getting these right is what lets history and live share rendering code.

Field spellings live in `src/shared/telemetry-types.ts`, which both the viewer and the test-bot emitter compile against, so the two cannot drift. Bad lines are rejected individually with a reason and are never fatal.

## Testing

Everything below the viewer is tested against recorded frames and bytes, never against a live game, so tests stay deterministic:

- `npm run verify` runs `verify-extraction` (decode/terrain/unit categorization against a temp copy of `fixtures/phase1-sample-game.sqlite`, so the committed 20 MB fixture is never dirtied) and `verify-tailer` (partial lines, a UTF-8 character split across reads, rejections, re-watch deduplication), driving the tailer's `poll()` directly rather than racing its timer.
- `fixtures/testbot-smoke.sqlite` plus `fixtures/testbot-smoke.ndjson` are a paired recording and telemetry file on the same loops, for viewer work.
- **Never let a build write to a committed fixture.** Opening one migrates it and leaves the repo dirty; copy it to a temp dir first.

The live path (proxy, session controller, tailer) cannot be covered that way, so `src/cli/testbot.ts` is a scripted SC2 API client: it joins like a real bot, steps for a set number of loops, optionally writes a conformant telemetry file, and ends the game on command (`surrender`, `leave`, `disconnect`, `hang`, `play`) so failure modes reproduce in seconds instead of a full game. It is a dev tool only. The real python-sc2 bot at `C:\dev\sc2-ai` stays the realism oracle and **must not be modified** for this project's needs.

Live-path facts already established, so they do not need re-deriving: `surrender` (via `debug.end_game`) is the only fast end that yields a real `player_result`; `leave` transitions `in_game -> launched` cleanly but produces no `player_result`, so `record` hangs; a bot that **disconnects leaves SC2 in `in_game` forever with no status transition**, so a finished session must be detected from the bot socket closing, not from game status; recovery is `leave_game` on a fresh connection, after which `create_game` works with no container restart.

## Build order and current phase

Six phases (§7), each depending on the prior and ending with something runnable: Phase 0 (Dockerfile + proxy spike) → Phase 1 (decode + record) → Phase 2 (viewer on recordings) → Phase 3 (telemetry file) → Phase 4 (live session + Docker UI) → Phase 5 (history browser) → Phase 6 (replays + debug draws).

**Phases 0 through 3 are complete.** Phase 3 is verified against live games, not only fixtures: the tailer followed two real bot runs (`hang` and `disconnect`) with zero rejections across 3231 messages.

**Phase 4 is next**: Docker manager with build/pull, status panel and logs, mode selector, session controller with auto next game and `status`-driven phases, live view fed from the bus with an idle indicator. It inherits three things worth knowing:

- `saveReplay` after `ended` **works**, confirmed live by `npm run probe-endgame` (8432 bytes returned from `ended`, 8315 from `in_game`). The replay comes back as `ResponseSaveReplay.data` bytes over the wire, so nothing needs mounting into the container: the app writes the file itself. The observed status sequence for a surrendered game is `launched -> init_game -> in_game -> ended -> init_game`, with `ended` and `player_result` arriving together on the observation *after* the stepped surrender, not on the step itself.
- §3.5 auto-attach of a telemetry file to a live game by timing was deferred out of Phase 3 because it needs a session.
- The timeline's range comes from recorded frames, so telemetry past the last frame is stored but not reachable by scrubbing. A live session grows frames, which resolves it.
