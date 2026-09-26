/**
 * Copyright (c) 2013-2017 Blizzard Entertainment
 * TypeScript port
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 */

import type { IntValue } from './int.js';

// Re-export IntValue for convenience
export type { IntValue };

/**
 * Bounds tuple for integer types: [offset, bits]
 * The offset can be a bigint for 64-bit integer types
 */
export type IntBounds = [offset: IntValue, bits: number];

/**
 * Type information tuple format: [methodName, parameters]
 * The methodName corresponds to decoder methods like '_int', '_bool', '_struct', etc.
 */
export type TypeInfo =
  | ['_int', [bounds: IntBounds]]
  | ['_bool', []]
  | ['_blob', [bounds: [offset: number, bits: number]]]
  | ['_array', [bounds: [offset: number, bits: number], typeid: number]]
  | ['_bitarray', [bounds: [offset: number, bits: number]]]
  | ['_struct', [fields: StructField[]]]
  | ['_choice', [bounds: [offset: number, bits: number], fields: ChoiceFields]]
  | ['_optional', [typeid: number]]
  | ['_fourcc', []]
  | ['_null', []]
  | ['_real32', []]
  | ['_real64', []];

/**
 * Struct field definition: [fieldName, typeid, tag]
 */
export type StructField = [name: string, typeid: number, tag: number];

/**
 * Choice fields mapping: tag -> [fieldName, typeid]
 */
export type ChoiceFields = Record<number, [name: string, typeid: number]>;

/**
 * Event type mapping: eventId -> [typeid, eventName]
 */
export type EventTypes = Record<number, [typeid: number, name: string]>;

/**
 * Decoded event structure
 */
export interface DecodedEvent {
  _event: string;
  _eventid: number;
  _gameloop: number;
  _bits: number;
  _userid?: { m_userId: number };
  [key: string]: unknown;
}

/**
 * Replay header structure
 */
export interface ReplayHeader {
  m_signature: Uint8Array;
  m_version: {
    m_flags: number;
    m_major: number;
    m_minor: number;
    m_revision: number;
    m_build: number;
    m_baseBuild: number;
  };
  m_type: number;
  m_elapsedGameLoops: number;
  m_useScaledTime: boolean;
  m_ngdpRootKey: {
    m_dataDeprecated: number[] | null;
    m_data: Uint8Array;
  };
  m_dataBuildNum: number;
  m_replayCompatibilityHash: {
    m_dataDeprecated: number[] | null;
    m_data: Uint8Array;
  };
  m_ngdpRootKeyIsDevData: boolean;
}

/**
 * Player info in game details
 */
export interface PlayerInfo {
  m_name: Uint8Array;
  m_toon: {
    m_region: number;
    m_programId: string;
    m_realm: number;
    m_name: Uint8Array;
    m_id: bigint;
  };
  m_race: Uint8Array;
  m_color: {
    m_a: number;
    m_r: number;
    m_g: number;
    m_b: number;
  };
  m_control: number;
  m_teamId: number;
  m_handicap: number;
  m_observe: number;
  m_result: number;
  m_workingSetSlotId: number | null;
  m_hero: Uint8Array;
}

/**
 * Game details structure
 */
export interface GameDetails {
  m_playerList: PlayerInfo[] | null;
  m_title: Uint8Array;
  m_difficulty: Uint8Array;
  m_thumbnail: { m_file: Uint8Array };
  m_isBlizzardMap: boolean;
  m_timeUTC: bigint;
  m_timeLocalOffset: bigint;
  m_restartAsTransitionMap: boolean | null;
  m_disableRecoverGame: boolean;
  m_description: Uint8Array;
  m_imageFilePath: Uint8Array;
  m_campaignIndex: number;
  m_mapFileName: Uint8Array;
  m_cacheHandles: Uint8Array[] | null;
  m_miniSave: boolean;
  m_gameSpeed: number;
  m_defaultDifficulty: number;
  m_modPaths: Uint8Array[] | null;
}

/**
 * Attributes event structure
 */
export interface AttributesEvents {
  source: number;
  mapNamespace: number;
  scopes: Record<number, Record<number, AttributeValue[]>>;
}

export interface AttributeValue {
  namespace: number;
  attrid: number;
  value: Uint8Array;
}

/**
 * Protocol module interface
 */
export interface ProtocolModule {
  typeinfos: TypeInfo[];
  game_event_types: EventTypes;
  message_event_types: EventTypes;
  tracker_event_types: EventTypes;
  game_eventid_typeid: number;
  message_eventid_typeid: number;
  tracker_eventid_typeid: number;
  svaruint32_typeid: number;
  replay_userid_typeid: number;
  replay_header_typeid: number;
  game_details_typeid: number;
  replay_initdata_typeid: number;

  decode_replay_header(contents: Uint8Array): ReplayHeader;
  decode_replay_details(contents: Uint8Array): GameDetails;
  decode_replay_initdata(contents: Uint8Array): unknown;
  decode_replay_game_events(contents: Uint8Array): Generator<DecodedEvent>;
  decode_replay_message_events(contents: Uint8Array): Generator<DecodedEvent>;
  decode_replay_tracker_events(contents: Uint8Array): Generator<DecodedEvent>;
  decode_replay_attributes_events(contents: Uint8Array): AttributesEvents;
}
