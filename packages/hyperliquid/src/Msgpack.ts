/**
 * Minimal msgpack encoder for Hyperliquid L1 actions.
 *
 * Hyperliquid's action hash msgpacks the action with a fixed set of rules
 * (verified against `@nktkas/hyperliquid` `src/signing/_l1.ts`):
 *
 *   - objects encode in **insertion key order** (the hash depends on it);
 *   - `undefined` fields are dropped before encoding;
 *   - integers outside the int32 range are widened to bigint (else msgpack
 *     would encode them as float64 and the hash would diverge);
 *   - arrays, strings, booleans, null, floats, and bigints are supported.
 *
 * This is deliberately not a general msgpack implementation - it covers only
 * the value shapes Hyperliquid actions use. A full library would pull in far
 * more surface area than the signing path needs.
 *
 * @module HyperliquidMsgpack
 */

/** The msgpack value space Hyperliquid actions inhabit. */
export type MsgpackValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | Uint8Array
  | MsgpackValue[]
  | { [key: string]: MsgpackValue | undefined };

/**
 * Normalise a value into the shape the wire encoder expects: drop `undefined`
 * object entries and widen out-of-int32 integers to bigint. Mirrors `adjust`
 * in the reference SDK exactly.
 */
function adjust(value: MsgpackValue): MsgpackValue {
  if (Array.isArray(value)) return value.map(adjust);
  if (typeof value === "object" && value !== null && !(value instanceof Uint8Array)) {
    const out: { [key: string]: MsgpackValue } = {};
    for (const key in value) {
      const entry = value[key];
      if (entry !== undefined) out[key] = adjust(entry);
    }
    return out;
  }
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    (value >= 0x100000000 || value < -0x80000000)
  ) {
    return BigInt(value);
  }
  return value;
}

// --- low-level writers -----------------------------------------------------

function writeUint8(out: number[], byte: number): void {
  out.push(byte & 0xff);
}

function writeUint16(out: number[], value: number): void {
  out.push((value >>> 8) & 0xff, value & 0xff);
}

function writeUint32(out: number[], value: number): void {
  out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function writeUint64(out: number[], value: bigint): void {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, value);
  for (let i = 0; i < 8; i++) out.push(view.getUint8(i));
}

function writeBytes(out: number[], bytes: Uint8Array): void {
  // @std/msgpack emits bin8/bin16/bin32 for Uint8Array. Match that here.
  const len = bytes.length;
  if (len <= 0xff) {
    out.push(0xc4, len);
  } else if (len <= 0xffff) {
    out.push(0xc5);
    writeUint16(out, len);
  } else {
    out.push(0xc6);
    writeUint32(out, len);
  }
  for (let i = 0; i < len; i++) out.push(bytes[i]!);
}

function writeStr(out: number[], text: string): void {
  // Hyperliquid actions carry ASCII/UTF-8 field values; encode as UTF-8 and
  // emit a msgpack str8/str16/str32 (or fixstr when short enough).
  const bytes = new TextEncoder().encode(text);
  const len = bytes.length;
  if (len <= 31) {
    writeUint8(out, 0xa0 | len);
  } else if (len <= 0xff) {
    out.push(0xd9, len);
  } else if (len <= 0xffff) {
    out.push(0xda);
    writeUint16(out, len);
  } else {
    out.push(0xdb);
    writeUint32(out, len);
  }
  for (let i = 0; i < len; i++) out.push(bytes[i]!);
}

// --- the encoder -----------------------------------------------------------

function encodeInto(out: number[], value: MsgpackValue): void {
  const normalised = adjust(value);

  if (normalised === null) {
    writeUint8(out, 0xc0);
    return;
  }
  switch (typeof normalised) {
    case "boolean":
      writeUint8(out, normalised ? 0xc3 : 0xc2);
      return;
    case "number": {
      if (Number.isInteger(normalised)) {
        if (normalised >= 0 && normalised <= 0x7f) {
          writeUint8(out, normalised); // positive fixint
        } else if (normalised >= -32 && normalised < 0) {
          writeUint8(out, normalised); // negative fixint (sign-extends)
        } else if (normalised >= 0 && normalised <= 0xff) {
          out.push(0xcc, normalised);
        } else if (normalised >= 0 && normalised <= 0xffff) {
          out.push(0xcd);
          writeUint16(out, normalised);
        } else if (normalised >= -0x8000 && normalised <= 0x7fff) {
          out.push(0xd1);
          writeUint16(out, normalised & 0xffff);
        } else if (normalised >= 0 && normalised <= 0xffffffff) {
          out.push(0xce);
          writeUint32(out, normalised);
        } else {
          // int32 fallback (already checked it fits int32 here).
          out.push(0xd2);
          writeUint32(out, normalised);
        }
      } else {
        // float64.
        const view = new DataView(new ArrayBuffer(8));
        view.setFloat64(0, normalised);
        out.push(0xcb);
        for (let i = 0; i < 8; i++) out.push(view.getUint8(i));
      }
      return;
    }
    case "bigint": {
      if (normalised >= 0n) {
        out.push(0xcf); // uint64
        writeUint64(out, normalised);
      } else {
        out.push(0xd3); // int64
        writeUint64(out, normalised);
      }
      return;
    }
    case "string": {
      writeStr(out, normalised);
      return;
    }
  }
  if (normalised instanceof Uint8Array) {
    writeBytes(out, normalised);
    return;
  }
  if (Array.isArray(normalised)) {
    const len = normalised.length;
    if (len <= 15)
      writeUint8(out, 0x90 | len); // fixarray
    else if (len <= 0xffff) {
      out.push(0xdc);
      writeUint16(out, len);
    } else {
      out.push(0xdd);
      writeUint32(out, len);
    }
    for (const item of normalised) encodeInto(out, item);
    return;
  }
  // object — insertion order matters; iterate own keys in order.
  const keys = Object.keys(normalised);
  const len = keys.length;
  if (len <= 15)
    writeUint8(out, 0x80 | len); // fixmap
  else if (len <= 0xffff) {
    out.push(0xde);
    writeUint16(out, len);
  } else {
    out.push(0xdf);
    writeUint32(out, len);
  }
  for (const key of keys) {
    writeStr(out, key);
    encodeInto(out, (normalised as Record<string, MsgpackValue>)[key]!);
  }
}

/** Encode a Hyperliquid action value to msgpack bytes. */
export function encodeMsgpack(value: MsgpackValue): Uint8Array {
  const out: number[] = [];
  encodeInto(out, value);
  return new Uint8Array(out);
}
