# Where this came from

Blizzard's replay decoder, [`s2protocol`](https://github.com/Blizzard/s2protocol) (MIT, see `LICENSE`), in its TypeScript port [`ccheever/s2protocol`](https://github.com/ccheever/s2protocol/tree/typescript) (MIT), taken from the npm package `s2protocol@1.0.0` on 2026-09-26.

It is vendored rather than installed because the npm package ships only TypeScript source written for Bun: the compiled `dist/` its `package.json` points to is not in the package, so Node cannot import it.

What was taken:

- `decoders.ts`, `int.ts` and `types.ts`, unchanged.
- `protocol75689.ts`, reduced to the type table and the two type ids Spectator reads: the replay header (18) and the game details (40).

Only build 75689 is here because it is the only build the pinned SC2 client plays (CLAUDE.md), so a replay from any other build is refused before its contents matter.

`src/replay/replayFile.ts` reads the `.SC2Replay` archive with `mpyqjs2` and decodes the header and the player list with these files.
