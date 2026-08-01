/**
 * Deterministic client order id (cloid) - spec §15.5.
 *
 * `derive16Bytes(missionId, strategyVersion, executionSequence, actionType)`
 * produces a stable 16-byte cloid so a retry of the same action reuses the
 * same cloid and the exchange deduplicates the order. Identical inputs give
 * identical cloids; different inputs must not collide.
 *
 * Algorithm (owner-approved): SHA-256 over the concatenated inputs, taking
 * the first 16 bytes, hex-encoded as a bare 32-character lowercase string
 * (no `0x` prefix, matching the Hyperliquid wire convention for `cloid`).
 *
 * @module HyperliquidCloid
 */
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";

/** Inputs that fix a cloid. Retries reuse every field. */
export interface CloidInput {
  readonly missionId: string;
  readonly strategyVersion: number;
  readonly executionSequence: number;
  readonly actionType: string;
}

/**
 * The separator placed between fields before hashing. A single byte outside
 * the printable-ASCII range so a suffix of one field cannot be confused with
 * a prefix of the next (e.g. missionId "ab" + sequence "12" vs "a" + "b12").
 */
const FIELD_SEPARATOR = new Uint8Array([0x1f]);

function u32Be(n: number): Uint8Array {
  // strategyVersion and executionSequence are non-negative integers; encode
  // as fixed-width unsigned 32-bit big-endian so the hash is stable across
  // runtimes and number widths.
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, n >>> 0);
  return bytes;
}

function appendText(out: number[], text: string): void {
  for (let i = 0; i < text.length; i++) {
    out.push(text.charCodeAt(i) & 0xff);
  }
}

/**
 * Derive a deterministic 16-byte cloid, returned as a bare 32-char lowercase
 * hex string (the Hyperliquid wire shape).
 */
export function deriveCloid(input: CloidInput): string {
  const acc: number[] = [];
  appendText(acc, input.missionId);
  acc.push(...FIELD_SEPARATOR);
  acc.push(...u32Be(input.strategyVersion));
  acc.push(...FIELD_SEPARATOR);
  acc.push(...u32Be(input.executionSequence));
  acc.push(...FIELD_SEPARATOR);
  appendText(acc, input.actionType);

  const bytes = new Uint8Array(acc);
  const full = sha256(bytes);
  // First 16 bytes (128 bits) — collision resistance matches the cloid width.
  return bytesToHex(full.subarray(0, 16));
}
