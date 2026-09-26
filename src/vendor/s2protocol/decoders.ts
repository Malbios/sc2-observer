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

import type { TypeInfo, StructField, ChoiceFields, IntBounds } from './types.js';
import { type IntValue, normalizeInt, toNumber, addInt, toBigInt } from './int.js';

/**
 * Error thrown when data is truncated
 */
export class TruncatedError extends Error {
  constructor(message?: string) {
    super(message ?? 'Data truncated');
    this.name = 'TruncatedError';
  }
}

/**
 * Error thrown when data is corrupted
 */
export class CorruptedError extends Error {
  constructor(message?: string) {
    super(message ?? 'Data corrupted');
    this.name = 'CorruptedError';
  }
}

/**
 * Buffer for reading bit-packed binary data
 */
export class BitPackedBuffer {
  private _data: Uint8Array;
  private _used: number = 0;
  private _next: number = 0;
  private _nextbits: number = 0;
  private _bigendian: boolean;

  constructor(contents: Uint8Array | null, endian: 'big' | 'little' = 'big') {
    this._data = contents ?? new Uint8Array(0);
    this._bigendian = endian === 'big';
  }

  toString(): string {
    const s = this._used < this._data.length
      ? this._data[this._used].toString(16).padStart(2, '0')
      : '--';
    return `buffer(${(this._nextbits && this._next || 0).toString(16).padStart(2, '0')}/${this._nextbits},[${this._used}]=${s})`;
  }

  done(): boolean {
    return this._nextbits === 0 && this._used >= this._data.length;
  }

  usedBits(): number {
    return this._used * 8 - this._nextbits;
  }

  byteAlign(): void {
    this._nextbits = 0;
  }

  readAlignedBytes(bytes: number): Uint8Array {
    this.byteAlign();
    const data = this._data.slice(this._used, this._used + bytes);
    this._used += bytes;
    if (data.length !== bytes) {
      throw new TruncatedError(this.toString());
    }
    return data;
  }

  /**
   * Read bits from the buffer
   * Returns IntValue - number for <= 31 bits, potentially bigint for > 31 bits
   */
  readBits(bits: number): IntValue {
    // Use bigint for large bit counts to avoid precision loss
    const useBigInt = bits > 31;

    let result = 0;
    let resultBig = 0n;
    let resultbits = 0;

    while (resultbits !== bits) {
      if (this._nextbits === 0) {
        if (this.done()) {
          throw new TruncatedError(this.toString());
        }
        this._next = this._data[this._used];
        this._used += 1;
        this._nextbits = 8;
      }
      const copybits = Math.min(bits - resultbits, this._nextbits);
      const copy = this._next & ((1 << copybits) - 1);

      if (useBigInt) {
        const shift = this._bigendian ? bits - resultbits - copybits : resultbits;
        resultBig |= BigInt(copy) << BigInt(shift);
      } else {
        if (this._bigendian) {
          result |= copy << (bits - resultbits - copybits);
        } else {
          result |= copy << resultbits;
        }
      }

      this._next >>= copybits;
      this._nextbits -= copybits;
      resultbits += copybits;
    }

    return useBigInt ? normalizeInt(resultBig) : result;
  }

  readUnalignedBytes(bytes: number): Uint8Array {
    const result = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) {
      result[i] = toNumber(this.readBits(8));
    }
    return result;
  }
}

/**
 * Decoder for bit-packed protocol data
 */
export class BitPackedDecoder {
  protected _buffer: BitPackedBuffer;
  protected _typeinfos: TypeInfo[];

  constructor(contents: Uint8Array, typeinfos: TypeInfo[]) {
    this._buffer = new BitPackedBuffer(contents);
    this._typeinfos = typeinfos;
  }

  toString(): string {
    return this._buffer.toString();
  }

  instance(typeid: number): unknown {
    if (typeid >= this._typeinfos.length) {
      throw new CorruptedError(this.toString());
    }
    const typeinfo = this._typeinfos[typeid];
    const methodName = typeinfo[0] as keyof this;
    const method = this[methodName];
    if (typeof method !== 'function') {
      throw new CorruptedError(`Unknown type method: ${typeinfo[0]}`);
    }
    return (method as (...args: unknown[]) => unknown).apply(this, typeinfo[1]);
  }

  byteAlign(): void {
    this._buffer.byteAlign();
  }

  done(): boolean {
    return this._buffer.done();
  }

  usedBits(): number {
    return this._buffer.usedBits();
  }

  _array(bounds: [number, number], typeid: number): unknown[] {
    const length = toNumber(this._int(bounds));
    const result: unknown[] = [];
    for (let i = 0; i < length; i++) {
      result.push(this.instance(typeid));
    }
    return result;
  }

  _bitarray(bounds: [number, number]): [number, IntValue] {
    const length = toNumber(this._int(bounds));
    return [length, this._buffer.readBits(length)];
  }

  _blob(bounds: [number, number]): Uint8Array {
    const length = toNumber(this._int(bounds));
    return this._buffer.readAlignedBytes(length);
  }

  _bool(): boolean {
    return toNumber(this._int([0, 1])) !== 0;
  }

  _choice(bounds: [number, number], fields: ChoiceFields): Record<string, unknown> {
    const tag = toNumber(this._int(bounds));
    if (!(tag in fields)) {
      throw new CorruptedError(this.toString());
    }
    const field = fields[tag];
    return { [field[0]]: this.instance(field[1]) };
  }

  _fourcc(): string {
    const bytes = this._buffer.readUnalignedBytes(4);
    return String.fromCharCode(...bytes);
  }

  /**
   * Decode an integer with the given bounds
   * Returns IntValue to handle 64-bit integers correctly
   */
  _int(bounds: IntBounds): IntValue {
    const [offset, bits] = bounds;
    const value = this._buffer.readBits(bits);
    return addInt(offset, value);
  }

  _null(): null {
    return null;
  }

  _optional(typeid: number): unknown {
    const exists = this._bool();
    return exists ? this.instance(typeid) : null;
  }

  _real32(): number {
    const bytes = this._buffer.readUnalignedBytes(4);
    const buffer = new ArrayBuffer(4);
    const view = new DataView(buffer);
    for (let i = 0; i < 4; i++) {
      view.setUint8(i, bytes[i]);
    }
    return view.getFloat32(0, false); // big-endian
  }

  _real64(): number {
    const bytes = this._buffer.readUnalignedBytes(8);
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    for (let i = 0; i < 8; i++) {
      view.setUint8(i, bytes[i]);
    }
    return view.getFloat64(0, false); // big-endian
  }

  _struct(fields: StructField[]): Record<string, unknown> {
    let result: Record<string, unknown> = {};
    for (const field of fields) {
      if (field[0] === '__parent') {
        const parent = this.instance(field[1]);
        if (parent !== null && typeof parent === 'object' && !Array.isArray(parent)) {
          result = { ...result, ...(parent as Record<string, unknown>) };
        } else if (fields.length === 1) {
          return parent as Record<string, unknown>;
        } else {
          result[field[0]] = parent;
        }
      } else {
        result[field[0]] = this.instance(field[1]);
      }
    }
    return result;
  }
}

/**
 * Decoder for versioned protocol data (with skip markers for forward compatibility)
 */
export class VersionedDecoder {
  protected _buffer: BitPackedBuffer;
  protected _typeinfos: TypeInfo[];

  constructor(contents: Uint8Array, typeinfos: TypeInfo[]) {
    this._buffer = new BitPackedBuffer(contents);
    this._typeinfos = typeinfos;
  }

  toString(): string {
    return this._buffer.toString();
  }

  instance(typeid: number): unknown {
    if (typeid >= this._typeinfos.length) {
      throw new CorruptedError(this.toString());
    }
    const typeinfo = this._typeinfos[typeid];
    const methodName = typeinfo[0] as keyof this;
    const method = this[methodName];
    if (typeof method !== 'function') {
      throw new CorruptedError(`Unknown type method: ${typeinfo[0]}`);
    }
    return (method as (...args: unknown[]) => unknown).apply(this, typeinfo[1]);
  }

  byteAlign(): void {
    this._buffer.byteAlign();
  }

  done(): boolean {
    return this._buffer.done();
  }

  usedBits(): number {
    return this._buffer.usedBits();
  }

  private _expectSkip(expected: number): void {
    if (toNumber(this._buffer.readBits(8)) !== expected) {
      throw new CorruptedError(this.toString());
    }
  }

  /**
   * Decode a variable-length integer
   * Uses bigint internally to handle large values correctly
   */
  private _vint(): IntValue {
    let b = toNumber(this._buffer.readBits(8));
    const negative = (b & 1) !== 0;
    let result = BigInt((b >> 1) & 0x3f);
    let bits = 6;
    while ((b & 0x80) !== 0) {
      b = toNumber(this._buffer.readBits(8));
      result |= BigInt(b & 0x7f) << BigInt(bits);
      bits += 7;
    }
    const value = negative ? -result : result;
    return normalizeInt(value);
  }

  _array(_bounds: [number, number], typeid: number): unknown[] {
    this._expectSkip(0);
    const length = toNumber(this._vint());
    const result: unknown[] = [];
    for (let i = 0; i < length; i++) {
      result.push(this.instance(typeid));
    }
    return result;
  }

  _bitarray(_bounds: [number, number]): [number, Uint8Array] {
    this._expectSkip(1);
    const length = toNumber(this._vint());
    return [length, this._buffer.readAlignedBytes(Math.floor((length + 7) / 8))];
  }

  _blob(_bounds: [number, number]): Uint8Array {
    this._expectSkip(2);
    const length = toNumber(this._vint());
    return this._buffer.readAlignedBytes(length);
  }

  _bool(): boolean {
    this._expectSkip(6);
    return toNumber(this._buffer.readBits(8)) !== 0;
  }

  _choice(_bounds: [number, number], fields: ChoiceFields): Record<string, unknown> {
    this._expectSkip(3);
    const tag = toNumber(this._vint());
    if (!(tag in fields)) {
      this._skipInstance();
      return {};
    }
    const field = fields[tag];
    return { [field[0]]: this.instance(field[1]) };
  }

  _fourcc(): Uint8Array {
    this._expectSkip(7);
    return this._buffer.readAlignedBytes(4);
  }

  /**
   * Decode an integer - returns IntValue to handle 64-bit integers
   */
  _int(_bounds: IntBounds): IntValue {
    this._expectSkip(9);
    return this._vint();
  }

  _null(): null {
    return null;
  }

  _optional(typeid: number): unknown {
    this._expectSkip(4);
    const exists = toNumber(this._buffer.readBits(8)) !== 0;
    return exists ? this.instance(typeid) : null;
  }

  _real32(): number {
    this._expectSkip(7);
    const bytes = this._buffer.readAlignedBytes(4);
    const buffer = new ArrayBuffer(4);
    const view = new DataView(buffer);
    for (let i = 0; i < 4; i++) {
      view.setUint8(i, bytes[i]);
    }
    return view.getFloat32(0, false);
  }

  _real64(): number {
    this._expectSkip(8);
    const bytes = this._buffer.readAlignedBytes(8);
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    for (let i = 0; i < 8; i++) {
      view.setUint8(i, bytes[i]);
    }
    return view.getFloat64(0, false);
  }

  _struct(fields: StructField[]): Record<string, unknown> {
    this._expectSkip(5);
    let result: Record<string, unknown> = {};
    const length = toNumber(this._vint());
    for (let i = 0; i < length; i++) {
      const tag = toNumber(this._vint());
      const field = fields.find(f => f[2] === tag);
      if (field) {
        if (field[0] === '__parent') {
          const parent = this.instance(field[1]);
          if (parent !== null && typeof parent === 'object' && !Array.isArray(parent)) {
            result = { ...result, ...(parent as Record<string, unknown>) };
          } else if (fields.length === 1) {
            return parent as Record<string, unknown>;
          } else {
            result[field[0]] = parent;
          }
        } else {
          result[field[0]] = this.instance(field[1]);
        }
      } else {
        this._skipInstance();
      }
    }
    return result;
  }

  private _skipInstance(): void {
    const skip = toNumber(this._buffer.readBits(8));
    if (skip === 0) {
      // array
      const length = toNumber(this._vint());
      for (let i = 0; i < length; i++) {
        this._skipInstance();
      }
    } else if (skip === 1) {
      // bitblob
      const length = toNumber(this._vint());
      this._buffer.readAlignedBytes(Math.floor((length + 7) / 8));
    } else if (skip === 2) {
      // blob
      const length = toNumber(this._vint());
      this._buffer.readAlignedBytes(length);
    } else if (skip === 3) {
      // choice
      this._vint(); // tag
      this._skipInstance();
    } else if (skip === 4) {
      // optional
      const exists = toNumber(this._buffer.readBits(8)) !== 0;
      if (exists) {
        this._skipInstance();
      }
    } else if (skip === 5) {
      // struct
      const length = toNumber(this._vint());
      for (let i = 0; i < length; i++) {
        this._vint(); // tag
        this._skipInstance();
      }
    } else if (skip === 6) {
      // u8
      this._buffer.readAlignedBytes(1);
    } else if (skip === 7) {
      // u32
      this._buffer.readAlignedBytes(4);
    } else if (skip === 8) {
      // u64
      this._buffer.readAlignedBytes(8);
    } else if (skip === 9) {
      // vint
      this._vint();
    }
  }
}
