/**
 * Hyperliquid L1 action signing - spec §15.6, verified byte-for-byte against
 * the reference algorithm in `@nktkas/hyperliquid` `src/signing/_l1.ts`.
 *
 * Hyperliquid L1 actions use a **phantom-agent** EIP-712 signature over a
 * hash of the msgpacked action — not standard typed-data signing of the
 * action struct itself:
 *
 *   actionHash = keccak256(
 *       msgpack(action)            // insertion-order keys; undefined dropped;
 *                                 //   out-of-int32 ints widened to bigint
 *     ‖ uint64BE(nonce)            // 8 bytes, big-endian
 *     ‖ (vault ? [0x01] ‖ addr20 : [0x00])
 *     ‖ (expiresAfter ≠ undefined ? [0x00] ‖ uint64BE(expiresAfter) : [])
 *   )
 *
 *   signature = EIP-712 sign over {
 *     domain: { name:"Exchange", version:"1", chainId:1337,
 *               verifyingContract: 0x000…000 },
 *     types: { Agent: [ {source:string}, {connectionId:bytes32} ] },
 *     message: { source: isTestnet ? "b" : "a", connectionId: actionHash },
 *   }
 *
 * `chainId` is **1337** (never Arbitrum's 42161/421614). Msgpack preserves
 * insertion key order — the action hash depends on it.
 *
 * @module HyperliquidSigning
 */
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils";
import { secp256k1 } from "@noble/curves/secp256k1";

import { encodeMsgpack, type MsgpackValue } from "./Msgpack.ts";

/** EIP-712 domain constants (verified against the reference SDK). */
export const HYPERLIQUID_EIP712_DOMAIN = {
  name: "Exchange",
  version: "1",
  chainId: 1337,
  verifyingContract: "0x0000000000000000000000000000000000000000",
} as const;

/** The Agent struct the phantom-agent signature covers. */
export const HYPERLIQUID_AGENT_TYPE = [
  { name: "source", type: "string" },
  { name: "connectionId", type: "bytes32" },
] as const;

/** A 65-byte ECDSA signature packed as r ‖ s ‖ v. */
export interface HyperliquidSignature {
  /** 32-byte r. */
  readonly r: Uint8Array;
  /** 32-byte s. */
  readonly s: Uint8Array;
  /** Recovery id (0 or 1), not biased by 27. */
  readonly v: number;
}

/** Inputs to the action-hash construction. */
export interface ActionHashInput {
  /** The action to be hashed. Hash depends on key order. */
  readonly action: MsgpackValue;
  /** The current timestamp in ms. */
  readonly nonce: number;
  /** Optional vault address used in the action. */
  readonly vaultAddress?: `0x${string}`;
  /** Optional expiration time in ms since the epoch. */
  readonly expiresAfter?: number;
}

function uint64Be(n: number | bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(n));
  return bytes;
}

/**
 * Create the keccak256 hash of an L1 action. This is the `connectionId` the
 * phantom-agent signature covers.
 *
 * `action` is normalised inside (undefined dropped, int32-overflow widened)
 * before msgpack encoding, exactly as the reference SDK does.
 */
export function createL1ActionHash(input: ActionHashInput): `0x${string}` {
  const { action, nonce, vaultAddress, expiresAfter } = input;

  const actionBytes = encodeMsgpack(action);
  const nonceBytes = uint64Be(nonce);
  const vaultMarker = vaultAddress ? new Uint8Array([1]) : new Uint8Array([0]);
  const vaultBytes = vaultAddress ? hexToBytes(vaultAddress.slice(2)) : new Uint8Array();
  // NB: the reference SDK emits marker [0x00] for a present expiresAfter and
  // no marker/bytes at all when absent. Match that exactly.
  const expiresMarker = expiresAfter !== undefined ? new Uint8Array([0]) : new Uint8Array();
  const expiresBytes = expiresAfter !== undefined ? uint64Be(expiresAfter) : new Uint8Array();

  const bytes = concatBytes(
    actionBytes,
    nonceBytes,
    vaultMarker,
    vaultBytes,
    expiresMarker,
    expiresBytes,
  );
  return `0x${bytesToHex(keccak_256(bytes))}` as `0x${string}`;
}

// --- EIP-712 typed-data hashing -------------------------------------------

/**
 * The EIP-712 type-hash for the Agent struct:
 * `keccak256("Agent(string source,bytes32 connectionId)")`.
 */
const AGENT_TYPE_HASH = keccak_256(
  new TextEncoder().encode("Agent(string source,bytes32 connectionId)"),
);

/**
 * EIP-712 domain separator:
 * `keccak256(typeHash ‖ keccak256(name) ‖ keccak256(version) ‖ chainId ‖ verifyingContract)`.
 */
const DOMAIN_SEPARATOR = (() => {
  const out: number[] = [];
  const typeHash = AGENT_TYPE_HASH;
  const nameHash = keccak_256(new TextEncoder().encode(HYPERLIQUID_EIP712_DOMAIN.name));
  const versionHash = keccak_256(new TextEncoder().encode(HYPERLIQUID_EIP712_DOMAIN.version));
  const chainId = uint64Be(HYPERLIQUID_EIP712_DOMAIN.chainId);
  const verifyingContract = hexToBytes(HYPERLIQUID_EIP712_DOMAIN.verifyingContract.slice(2));
  for (const part of [typeHash, nameHash, versionHash, chainId, verifyingContract]) {
    for (let i = 0; i < part.length; i++) out.push(part[i]!);
  }
  return keccak_256(new Uint8Array(out));
})();

/**
 * The EIP-712 struct hash for the Agent message:
 * `keccak256(typeHash ‖ keccak256(source) ‖ connectionId)`.
 */
function agentStructHash(source: string, connectionId: `0x${string}`): Uint8Array {
  const out: number[] = [];
  const typeHash = AGENT_TYPE_HASH;
  const sourceHash = keccak_256(new TextEncoder().encode(source));
  const connectionIdBytes = hexToBytes(connectionId.slice(2));
  for (const part of [typeHash, sourceHash, connectionIdBytes]) {
    for (let i = 0; i < part.length; i++) out.push(part[i]!);
  }
  return keccak_256(new Uint8Array(out));
}

/**
 * The final EIP-712 digest to sign:
 * `keccak256(0x1901 ‖ domainSeparator ‖ structHash)`.
 */
function eip712Digest(structHash: Uint8Array): Uint8Array {
  return keccak_256(concatBytes(new Uint8Array([0x19, 0x01]), DOMAIN_SEPARATOR, structHash));
}

/**
 * Sign an L1 action with the execution wallet's private key.
 *
 * Returns the 65-byte ECDSA signature (r ‖ s ‖ v) the exchange expects in
 * the `signature` field of a POST `/exchange` body. `isTestnet` selects the
 * phantom-agent source byte (`"b"` testnet, `"a"` mainnet).
 *
 * @param privateKey 32-byte secp256k1 private key (from the interim signer).
 */
export function signL1Action(
  input: ActionHashInput & {
    privateKey: Uint8Array;
    isTestnet?: boolean;
  },
): HyperliquidSignature {
  const { privateKey, isTestnet = false } = input;
  const actionHash = createL1ActionHash(input);
  const source = isTestnet ? "b" : "a";
  const digest = eip712Digest(agentStructHash(source, actionHash));

  const sig = secp256k1.sign(digest, privateKey);
  // noble's `r`/`s` are bigints; the exchange wants 32-byte big-endian fields.
  const compact = sig.toCompactHex();
  return {
    r: hexToBytes(compact.slice(0, 64)),
    s: hexToBytes(compact.slice(64, 128)),
    v: sig.recovery,
  };
}

// --- address derivation ----------------------------------------------------

/**
 * Derive the EVM address for a 32-byte private key. The execution-wallet
 * address is recorded on every execution as the signer of record, and used
 * to verify the interim key matches the approved API wallet.
 */
export function addressFromPrivateKey(privateKey: Uint8Array): `0x${string}` {
  const publicKey = secp256k1.getPublicKey(privateKey, false); // uncompressed, 65 bytes
  // Drop the 0x04 prefix; the address is the last 20 bytes of keccak(pubkey).
  const pubXY = publicKey.subarray(1, 65);
  const hash = keccak_256(pubXY);
  return `0x${bytesToHex(hash.subarray(12, 32))}` as `0x${string}`;
}

/**
 * Pack a signature into the 65-byte `r ‖ s ‖ v` concatenation the exchange
 * expects (with v as the raw recovery id 0/1 — Hyperliquid does not add 27).
 */
export function packSignature(sig: HyperliquidSignature): Uint8Array {
  return concatBytes(sig.r, sig.s, new Uint8Array([sig.v]));
}
