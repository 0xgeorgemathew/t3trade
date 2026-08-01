import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { describe, expect, it } from "vite-plus/test";

import { encodeMsgpack } from "./Msgpack.ts";
import {
  addressFromPrivateKey,
  createL1ActionHash,
  packSignature,
  signL1Action,
} from "./Signing.ts";

/**
 * The canonical Ethereum test vector: private key = 32 bytes of 0x01 yields
 * address 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf. This is universally
 * published and validates that secp256k1 + keccak256 are wired correctly
 * without requiring the owner's interim key.
 */
const TEST_PRIVATE_KEY_HEX = "0x0000000000000000000000000000000000000000000000000000000000000001";
const TEST_PRIVATE_KEY = hexToBytes(TEST_PRIVATE_KEY_HEX.slice(2));
const EXPECTED_TEST_ADDRESS = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";

describe("addressFromPrivateKey", () => {
  it("derives the canonical address for the all-0x01 test key", () => {
    expect(addressFromPrivateKey(TEST_PRIVATE_KEY)).toBe(EXPECTED_TEST_ADDRESS);
  });
});

describe("encodeMsgpack", () => {
  it("encodes a small object in insertion order with fixmap/fixstr markers", () => {
    // { type: "noop" } → fixmap(1) ‖ "type"(fixstr) ‖ "noop"(fixstr)
    const bytes = encodeMsgpack({ type: "noop" });
    // 0x81 = fixmap len 1; 0xa4 = fixstr len 4; 0xa4 = fixstr len 4
    expect(Array.from(bytes)).toEqual([
      0x81, 0xa4, 0x74, 0x79, 0x70, 0x65, 0xa4, 0x6e, 0x6f, 0x6f, 0x70,
    ]);
  });

  it("drops undefined entries before encoding", () => {
    const withUndef = encodeMsgpack({ type: "noop", vault: undefined });
    const without = encodeMsgpack({ type: "noop" });
    expect(withUndef).toEqual(without);
  });

  it("widens out-of-int32 integers to uint64", () => {
    // nonce > 2^31 must encode as uint64 (0xcf), not float64.
    const bytes = encodeMsgpack({ n: 5_000_000_000 });
    // fixmap(1) ‖ "n"(fixstr) ‖ 0xcf ‖ 8 big-endian bytes
    expect(bytes[0]).toBe(0x81);
    expect(bytes[3]).toBe(0xcf);
    // 5e9 = 0x 00 00 00 01 2A 05 F2 00
    const tail = Array.from(bytes.subarray(4));
    expect(tail).toEqual([0, 0, 0, 1, 0x2a, 0x05, 0xf2, 0x00]);
  });
});

describe("createL1ActionHash", () => {
  it("is deterministic for identical inputs (insertion order matters)", () => {
    const base = {
      action: { type: "cancel", cancels: [{ a: 0, o: 12345 }] },
      nonce: 1_700_000_000_000,
    };
    expect(createL1ActionHash(base)).toBe(createL1ActionHash(base));
  });

  it("changes when the nonce changes", () => {
    const action = { type: "noop" };
    const a = createL1ActionHash({ action, nonce: 1_000 });
    const b = createL1ActionHash({ action, nonce: 1_001 });
    expect(a).not.toBe(b);
  });

  it("changes when key order changes (insertion-order dependence)", () => {
    const ab = createL1ActionHash({ action: { a: 1, b: 2 }, nonce: 1 });
    const ba = createL1ActionHash({ action: { b: 2, a: 1 }, nonce: 1 });
    expect(ab).not.toBe(ba);
  });

  it("produces a 0x-prefixed 32-byte keccak hash", () => {
    const hash = createL1ActionHash({ action: { type: "noop" }, nonce: 1 });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("binds the vault address into the hash when present", () => {
    const action = { type: "noop" };
    const noVault = createL1ActionHash({ action, nonce: 1 });
    const withVault = createL1ActionHash({
      action,
      nonce: 1,
      vaultAddress: "0x1111111111111111111111111111111111111111",
    });
    expect(noVault).not.toBe(withVault);
  });
});

describe("signL1Action", () => {
  it("produces a 65-byte signature that recovers to the signer address", () => {
    // The action hash is the connectionId the phantom-agent digest covers.
    // Recovering the signer from the signature proves the EIP-712 digest is
    // constructed correctly end-to-end.
    const action = { type: "noop" };
    const sig = signL1Action({
      action,
      nonce: 1_700_000_000_000,
      privateKey: TEST_PRIVATE_KEY,
      isTestnet: true,
    });

    expect(sig.r.length).toBe(32);
    expect(sig.s.length).toBe(32);
    expect(sig.v).toBeGreaterThanOrEqual(0);
    expect(sig.v).toBeLessThanOrEqual(1);

    // Reconstruct the digest and recover the public key, then the address.
    const actionHash = createL1ActionHash({ action, nonce: 1_700_000_000_000 });
    const digest = eip712DigestForRecovery(actionHash, true);
    const pub = recoverPublicKey(digest, sig);
    expect(addressFromRecoveredPubkey(pub)).toBe(EXPECTED_TEST_ADDRESS);
  });

  it("packs to exactly 65 bytes (r ‖ s ‖ v)", () => {
    const sig = signL1Action({ action: { type: "noop" }, nonce: 1, privateKey: TEST_PRIVATE_KEY });
    expect(packSignature(sig).length).toBe(65);
  });
});

// --- local recovery helpers (mirror the signing construction) -------------
// These duplicate the EIP-712 digest + recovery so the test can verify the
// signed digest without exporting internals from Signing.ts.
import { keccak_256 } from "@noble/hashes/sha3";
import { concatBytes } from "@noble/hashes/utils";
import { secp256k1 } from "@noble/curves/secp256k1";

const AGENT_TYPE_HASH = keccak_256(
  new TextEncoder().encode("Agent(string source,bytes32 connectionId)"),
);
const DOMAIN_TYPE_HASH = keccak_256(
  new TextEncoder().encode(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
  ),
);
/** uint256 chainId (1337) as 32 big-endian bytes. */
const chainId256 = (() => {
  const b = new Uint8Array(32);
  new DataView(b.buffer).setUint32(28, 1337);
  return b;
})();
/** 20-byte zero address left-padded to 32 bytes (EIP-712 address encoding). */
const zeroAddress32 = new Uint8Array(32);
const DOMAIN_SEPARATOR = keccak_256(
  concatBytes(
    DOMAIN_TYPE_HASH,
    keccak_256(new TextEncoder().encode("Exchange")),
    keccak_256(new TextEncoder().encode("1")),
    chainId256,
    zeroAddress32,
  ),
);

function eip712DigestForRecovery(connectionId: string, isTestnet: boolean): Uint8Array {
  const source = isTestnet ? "b" : "a";
  const structHash = keccak_256(
    concatBytes(
      AGENT_TYPE_HASH,
      keccak_256(new TextEncoder().encode(source)),
      hexToBytes(connectionId.slice(2)),
    ),
  );
  return keccak_256(concatBytes(new Uint8Array([0x19, 0x01]), DOMAIN_SEPARATOR, structHash));
}

function recoverPublicKey(
  digest: Uint8Array,
  sig: { r: Uint8Array; s: Uint8Array; v: number },
): Uint8Array {
  const r = bytesToBigInt(sig.r);
  const s = bytesToBigInt(sig.s);
  return secp256k1.Signature.fromCompact(concatBytes(sig.r, sig.s))
    .addRecoveryBit(sig.v)
    .recoverPublicKey(digest)
    .toRawBytes(false);
}

function addressFromRecoveredPubkey(pub: Uint8Array): string {
  const hash = keccak_256(pub.subarray(1, 65));
  return `0x${bytesToHex(hash.subarray(12, 32))}`;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = 0; i < bytes.length; i++) n = (n << 8n) | BigInt(bytes[i]!);
  return n;
}
