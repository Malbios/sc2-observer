/**
 * Copyright (c) 2013-2017 Blizzard Entertainment
 * TypeScript port
 *
 * Integer handling utilities for safe bigint/number operations
 */

/**
 * Integer value that can be either a number (for safe integers) or bigint (for large values)
 */
export type IntValue = number | bigint;

/**
 * Normalize a bigint to a number if it's within safe integer range
 */
export function normalizeInt(value: bigint): IntValue {
  if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  return value;
}

/**
 * Convert an IntValue to bigint
 */
export function toBigInt(value: IntValue): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

/**
 * Safely convert an IntValue to number, throwing if out of safe range
 */
export function toNumber(value: IntValue): number {
  if (typeof value === 'bigint') {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError(`Value ${value} exceeds safe integer range`);
    }
    return Number(value);
  }
  return value;
}

/**
 * Add two IntValues, using bigint if either is bigint
 */
export function addInt(a: IntValue, b: IntValue): IntValue {
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    const result = toBigInt(a) + toBigInt(b);
    return normalizeInt(result);
  }
  return a + b;
}

/**
 * Subtract two IntValues, using bigint if either is bigint
 */
export function subInt(a: IntValue, b: IntValue): IntValue {
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    const result = toBigInt(a) - toBigInt(b);
    return normalizeInt(result);
  }
  return a - b;
}

/**
 * Compare two IntValues
 * Returns -1 if a < b, 0 if a === b, 1 if a > b
 */
export function compareInt(a: IntValue, b: IntValue): number {
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    const left = toBigInt(a);
    const right = toBigInt(b);
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
