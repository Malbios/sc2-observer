import { MPQArchive } from "mpyqjs2/mpyq.js";
import { VersionedDecoder } from "../vendor/s2protocol/decoders.js";
import { game_details_typeid, replay_header_typeid, typeinfos } from "../vendor/s2protocol/protocol75689.js";
import type { GameDetails, ReplayHeader } from "../vendor/s2protocol/types.js";

/**
 * What a `.SC2Replay` says about itself, read straight from the file.
 *
 * The SC2 client can say the same through `replay_info`, but it serves one
 * request at a time and may be busy converting another replay, while the view
 * picker needs the players the moment a file is dropped.
 */
export interface ReplayFileInfo {
  build: number;
  durationLoops: number;
  mapName: string;
  players: ReplayFilePlayer[];
}

export interface ReplayFilePlayer {
  playerId: number;
  name: string;
  race: string;
}

export const SUPPORTED_BUILD = 75689;

const text = (bytes: Uint8Array | null | undefined): string => (bytes ? new TextDecoder().decode(bytes) : "");

export function readReplayFile(source: string | Buffer): ReplayFileInfo {
  let archive: MPQArchive;
  try {
    archive = new MPQArchive(source, false);
  } catch {
    throw new Error("not a StarCraft II replay");
  }
  const headerBytes = archive.header.userDataHeader?.content;
  if (!headerBytes) throw new Error("not a StarCraft II replay");

  const header = new VersionedDecoder(headerBytes, typeinfos).instance(replay_header_typeid) as ReplayHeader;
  const build = Number(header.m_version.m_baseBuild);
  const durationLoops = Number(header.m_elapsedGameLoops);
  if (build !== SUPPORTED_BUILD) return { build, durationLoops, mapName: "", players: [] };

  const detailsBytes = archive.readFile("replay.details");
  if (!detailsBytes) throw new Error("the replay has no player list");
  const details = new VersionedDecoder(detailsBytes, typeinfos).instance(game_details_typeid) as GameDetails;

  const players = (details.m_playerList ?? [])
    .filter((player) => Number(player.m_observe) === 0)
    .map((player, index) => ({ playerId: index + 1, name: text(player.m_name), race: text(player.m_race) }));
  return { build, durationLoops, mapName: text(details.m_title), players };
}
