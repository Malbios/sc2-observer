/**
 * `Status` from sc2api.proto, mirrored in TypeScript because the session
 * controller's state machine (§4) is defined in terms of these transitions and
 * reading them off `Response.status` is how the app learns a game has started
 * or ended without asking the client anything.
 *
 * The observed sequence for a surrendered game, measured by
 * `npm run probe-endgame` rather than assumed:
 *
 *   launched -> init_game -> in_game -> ended -> init_game
 *
 * with `ended` arriving on the observation *after* the stepped surrender, not
 * on the step that causes it, and carrying `player_result` in the same frame.
 */
export const SC2_STATUS = {
  launched: 1,
  initGame: 2,
  inGame: 3,
  inReplay: 4,
  ended: 5,
  quit: 6,
  unknown: 99,
} as const;

export type Sc2Status = (typeof SC2_STATUS)[keyof typeof SC2_STATUS];

const NAMES: Record<number, string> = {
  [SC2_STATUS.launched]: "launched",
  [SC2_STATUS.initGame]: "init_game",
  [SC2_STATUS.inGame]: "in_game",
  [SC2_STATUS.inReplay]: "in_replay",
  [SC2_STATUS.ended]: "ended",
  [SC2_STATUS.quit]: "quit",
  [SC2_STATUS.unknown]: "unknown",
};

export function statusName(status: number | null | undefined): string {
  if (status === null || status === undefined) return "none";
  return NAMES[status] ?? `status ${status}`;
}

/**
 * Whether a status means a game is over. `quit` counts: the client is shutting
 * down, so whatever was being played is not going to finish.
 */
export function isTerminalStatus(status: number | null | undefined): boolean {
  return status === SC2_STATUS.ended || status === SC2_STATUS.quit;
}
