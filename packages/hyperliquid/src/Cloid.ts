/**
 * Deterministic client order id (cloid) - spec §15.5.
 *
 * `derive16Bytes(missionId, strategyVersion, executionSequence, actionType)`
 * produces a stable 16-byte cloid so a retry of the same action carries the
 * same cloid. Identical inputs give identical cloids; different inputs must not
 * collide.
 *
 * **A cloid is a correlation id, not an idempotency key.** Hyperliquid enforces
 * cloid uniqueness only among *resting* orders, and a marketable IOC never
 * rests — resubmitting one is verified live (`executionLive.test.ts`) to open a
 * second order that fills again. What the stable cloid buys is reconciliation:
 * the Info API echoes it back on the order and its fills, so a fill can be
 * joined to the execution record that caused it. Retry safety belongs to the
 * caller — `HyperliquidExecutionService` refuses to resubmit a record that has
 * already reached the exchange.
 *
 * Algorithm (owner-approved): SHA-256 over the concatenated inputs, taking
 * the first 16 bytes, hex-encoded as a `0x`-prefixed 34-character lowercase
 * string — the Hyperliquid wire convention for `cloid` (16 bytes / 128 bits,
 * `0x` + 32 hex chars, validated by the exchange as `len(cloid[2:]) == 32`).
 *
 * Format note (Task 4 finding): a prior version returned a bare 32-char hex
 * string with no `0x` prefix. The live Gate E entry (oid 57307761690) was
 * accepted, but reading it back showed the exchange stored `"cloid": null` —
 * the bare form was silently dropped, so retry-deduplication rested entirely
 * on local idempotency-key convergence, never on exchange-side cloid match.
 * The `0x` prefix is now applied at this single boundary so one
 * representation flows everywhere: the wire order, the DB column, the
 * reconciler's join, and the UI slice.
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
 * Derive a deterministic 16-byte cloid, returned as a `0x`-prefixed
 * 34-char lowercase hex string (the Hyperliquid wire shape).
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
  // `0x`-prefix so the exchange records it rather than silently dropping it.
  return `0x${bytesToHex(full.subarray(0, 16))}`;
}
