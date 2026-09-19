# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

This repository currently contains only the implementation plan (`SC2 Bot Dev Tool — Implementation Plan.md`) and no code, `package.json`, or tooling. There are no build/lint/test commands yet because nothing has been scaffolded. When implementation begins, this file should be updated with the actual commands.

**Read the plan document in full before implementing anything** — it is the design spec and contains decisions, rejected alternatives, and open unknowns that are not repeated below.

## What this project is

**Spectator**: a standalone Node.js/Electron desktop tool that runs a headless StarCraft II client in Docker, proxies a bot's connection to it, visualizes live games and replays, ingests bot telemetry over a separate NDJSON-file channel, and stores every game for later review. It is prior art to `vscode-starcraft` but ships its own Dockerfile/image instead of relying on `stephanzlatarev/starcraft`'s opaque proxy.

## Non-negotiable design rules

These are load-bearing constraints from the plan, not stylistic preferences — violating them breaks the tool's core premise:

- **Bot-ignorance rule**: the app must never encode knowledge of any bot's architecture, race, layer names, or module names. It only understands channel strings (`ch` field) and the five telemetry kinds (§3 of the plan). If an implementation detail requires knowing what a bot's code looks like, that's a design error.
- **Zero pause coordination**: the game proxy forwards every frame unchanged, in order, without delaying, reordering, or dropping bot traffic. It never sends `step` or `action` on the bot's behalf while a bot is connected. A halted bot (e.g. at a breakpoint) freezes the lockstep game on its own; the app only displays the frozen state — there is no timeout-based state change.
- **Loop number, not wall-clock, is the only time axis** for both game state and telemetry.
- **Guardrail for ambiguity**: if a design question isn't answered by the plan, or two options tie, stop and ask — do not guess (this matches the global non-negotiable of surfacing assumptions and stopping on conflicting requirements).

## Architecture (see plan §4 for full detail)

One Electron main process owns: Docker manager, game proxy, session controller, telemetry tailer, and the SQLite-backed store. One renderer process draws the viewer. All data flows through a single in-process event bus keyed by `(sessionId, loop)`, so live view, history view, and persistence consume the same stream — the renderer never touches sockets or the filesystem directly (IPC only, via a typed contextBridge channel).

Key components and their responsibilities/exclusions are tabulated in plan §4; do not reimplement that table here — read it before touching proxy, session controller, or telemetry code, since each component has explicit "must not do" constraints.

### Telemetry contract (plan §3)

Bots write NDJSON to `<data dir>/telemetry/<start timestamp>-<bot-chosen name>.ndjson`; the app tails this file locally and imports it for AI Arena matches. Five message kinds only: `overlay`, `series`, `event`, `snapshot`, `entity` (plus `hello`/`end`). Each kind has a specific retention rule (replace vs. append) defined in §3.3 — get this right, since it's what lets the history browser and live view share rendering code.

### Persistence (plan §6)

One SQLite file per game (via better-sqlite3) plus a small global catalog database. Observations are stored as Brotli-compressed raw protobuf bytes, not JSON (sizing rationale in §6.1). Do not propose a single global database or flat-file-only storage — both were considered and rejected (§6.2).

## Stack (plan §5)

Electron + TypeScript everywhere, PixiJS v8 for the map, React for panels, uPlot for series charts, protobufjs (schema vendored from `s2client-proto` at a pinned commit) for protobuf decoding, better-sqlite3 for storage, Node `ws` for the proxy sockets, Docker controlled via CLI spawn (not dockerode). These were chosen after weighing alternatives listed in the plan's stack table — don't relitigate them without a concrete reason a premise was falsified.

## Build order and current phase

The plan specifies six phases (§7), each depending on the prior and ending with something runnable: Phase 0 (Dockerfile + throwaway proxy spike) → Phase 1 (decode + record to SQLite) → Phase 2 (viewer on recordings) → Phase 3 (telemetry file) → Phase 4 (live session + Docker UI) → Phase 5 (history browser) → Phase 6 (replays + debug draws). Replays are deliberately deferred to last.

As of this writing, **no phase has started**. Phase 0 has open unknowns (§7.1) that must be verified experimentally (e.g. the headless Linux SC2 package source/version, exact launch flags, host-path form for Docker volumes on Windows, whether the client accepts a new `createGame` without a container restart) — do not assume answers to these; they require running the Phase 0 spike.

Testing approach once code exists: everything below the viewer layer is tested against recorded frame fixtures, never against a live game, so tests stay deterministic. Phase 1 must produce a committed fixture recording that later phases reuse.
