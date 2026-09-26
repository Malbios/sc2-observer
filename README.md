# Spectator

A desktop tool for developing StarCraft II bots. It runs a headless SC2 client in Docker, sits between your bot and the game, and shows you what is happening: live while your bot plays, and afterwards in every recorded game. Your bot can also report what it is thinking (plans, estimates, per-unit tasks), and Spectator draws that on the same map and timeline as the game itself.

It is built for bots that use the SC2 API, such as python-sc2 bots, and knows nothing about how your bot is written.

## What it does

- **Play your bot** against one to three built-in AIs (each with race, difficulty and build), let your bot create its own game, or run two bots against each other the way the AI Arena ladder does.
- **Record every game**, with SC2's own replay saved beside it.
- **Show the game on a map**:
  - a cell grid with ramps and cliffs;
  - unit icons and health bars;
  - lines for the commands your bot gave;
  - anything your bot drew with SC2's debug API;
  - a minimap, a unit inspector that names each unit's owner, and a timeline with play, pause and 1x to 8x.
- **Import `.SC2Replay` files**, for example your bot's AI Arena matches. Pick which views to convert: the observer, who sees everything, and each player's own fogged view. Switch between them while watching.
- **Take your bot's telemetry** (numbers over time, events, overlays, per-unit data) from a file it writes, live or after the fact.
- **Keep a list of games** that names who won, and lets you tag, export and delete them (deleted games go to the Recycle Bin).

## Requirements

| | |
|---|---|
| OS | Windows (the only system it has been used on so far) |
| Docker | Docker Desktop, running |
| Node.js | 24 |
| Disk | about 8 GB for the SC2 image |
| Memory | about 1 GB per SC2 client (one per game, two for bot against bot) |

SC2 itself does not need to be installed: the app builds a Docker image with Blizzard's Linux build 4.10 (75689), the last one Blizzard released for Linux.

## Getting started

```
npm install
npm run dev
```

1. **Maps.** No maps come with the repo. Put the `.SC2Map` files you want to play on into `maps/` (the folder is git-ignored). The AI Arena ladder maps are two-player maps; for a game against two or three AIs, use a map with that many more start locations.
2. **The first game builds the Docker image.** That downloads SC2 4.10 from Blizzard (a few GB) and takes a while. Downloading it means accepting Blizzard's AI and Machine Learning License, which is what the password in `docker/Dockerfile` stands for. After that, starting SC2 takes 10 to 20 seconds.

## Playing a game with your bot

On the **Games** screen, click **New Game...**, choose the kind of game and the map, and click **Start Game**.

| Kind of game | What happens | How your bot connects |
|---|---|---|
| Your bot vs built-in AIs | Spectator creates the game with the AIs you chose and waits | Your bot joins at `ws://127.0.0.1:5000/sc2api` |
| Your bot creates the game | Spectator waits for your bot | Your bot connects to `ws://127.0.0.1:5000/sc2api` and creates the game itself |
| Bot vs Bot | Spectator creates a game for two bots | Start each bot ladder-style, with the `--LadderServer`, `--GamePort` and `--StartPort` shown in the header for its player |

Start your bot once the header says the game is waiting for it. The map goes live as soon as it joins. When a game ends, Spectator saves it and creates the next one, so you can simply start your bot again. **Stop Session** ends it all and removes the SC2 container.

Spectator never pauses or changes what your bot sends. If you stop your bot at a breakpoint, the game waits with it, and the view shows the frozen state.

## Watching games and replays

Every game appears in the list on the **Games** screen. Click one to open it, and use the timeline to play, pause, change speed or jump. **Games** takes you back to the list.

To watch a replay, drop `.SC2Replay` files on the window or click **Open Replays...**. A dialog shows each replay's map, length and players, and lets you choose which views to convert:
- **Everything (observer)** sees the whole map.
- **Each player** sees exactly what that player could see.

With several files you can use one set of choices for all of them, or choose per file. Each view is one pass through the replay at full speed, about 50 seconds for an 11-minute game. Conversions run in the background, one at a time, and the Games list shows their progress. A replay opens like any other game once its views are done, with a switch in the header to change views.

A game your bot played live can be seen through the other eyes too: **Convert Replay** on its row imports its replay.

Only replays from SC2 build 75689 can be played; others are refused with a reason.

## Telemetry from your bot

Your bot can write what it is thinking to a file, and Spectator shows it next to the game:
- lines and shapes on the map,
- charts over time,
- a log of events,
- data attached to individual units.

For Python bots, copy `emitter/python/spectator_telemetry.py` into your bot; it has no dependencies. [emitter/python/README.md](emitter/python/README.md) explains the five kinds of message and how to use them.

- **Live:** during a game, Spectator reads the `telemetry/` folder in this repo and picks up the file your bot starts writing. **Watch Folder...** points it at another folder.
- **Afterwards:** drop an `.ndjson` file on an open game, or use **Attach Telemetry...** in the channel panel. This is how an AI Arena match's telemetry is paired with its replay.

## Where things are stored

Games are kept in `%APPDATA%\sc2-observer\games`. Each game is up to four files with the same name:
- `.sqlite` (the recording),
- its `-wal` and `-shm` companions,
- the `.SC2Replay`.

If you copy or move a game by hand, take all of them together. **Export** in the list folds the companions into the `.sqlite` and copies it with its replay, and **Delete** moves all four to the Recycle Bin. Spectator never deletes a game unless you ask it to.

## Command-line tools

The same machinery runs without the window. Build first with `npm run build`, then call them with `node`:

| Tool | What it does |
|---|---|
| `node dist/cli/session.js --map <map>` | A live session without the app: records every game, saves replays |
| `node dist/cli/replay.js --file <replay>` | Converts replays into games, every view or the one given with `--watch` |
| `node dist/cli/record.js --map <map> --out <file>` | Records a single game (expects SC2 to be running already) |
| `node dist/cli/dump.js <game> --loop <n>` | Prints what a recording holds at a loop |
| `node dist/cli/import-telemetry.js <game> --file <ndjson>` | Attaches a telemetry file to a recorded game |
| `node dist/cli/testbot.js` | A scripted test bot that joins a game and ends it on command |

The full options are in [CLAUDE.md](CLAUDE.md).

## Development

```
npm run typecheck   # both the Electron main side and the window
npm run verify      # builds and runs the test suites
npm run build:app   # production build of the app into out/
```

The tests run against recorded games and scripted SC2 clients, not live games, so they need neither Docker nor SC2.

- [CLAUDE.md](CLAUDE.md) describes the architecture, the design rules, and the facts about SC2 that were measured rather than assumed.
- [SC2 Bot Dev Tool — Implementation Plan.md](<SC2 Bot Dev Tool — Implementation Plan.md>) is the design this was built from.

## Limits

- **SC2 is pinned to 4.10.** No newer Linux build exists, so replays from other versions cannot be played.
- **One SC2 client at a time.** A live session and a replay conversion take turns: conversions wait while a session runs, and a session cannot start while a replay is converting.
- **No installer, settings screen or keyboard shortcuts yet.** The app runs from the repo with `npm run dev`.

## Third-party material

- **StarCraft II**, downloaded by the Docker build, is Blizzard's, under their AI and Machine Learning License. No maps are included.
- **Blizzard's `s2protocol` decoder** (MIT) is vendored in `src/vendor/s2protocol`, reduced to build 75689; see its `SOURCE.md` and `LICENSE`.
- **Unit icons** in `src/renderer/public/icons` were supplied by the project owner; see `SOURCE.md` there.
