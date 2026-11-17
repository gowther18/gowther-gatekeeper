// Field helpers for the BN128 circuits used by Agent Games.
// js-sha3 is CommonJS; use the default import (module.exports) so the
// Vercel file tracer can follow the dependency statically. (createRequire
// + require() was invisible to the tracer and js-sha3 was dropped from
// the serverless bundle, causing 500 Cannot find module 'js-sha3'.)
import sha3 from "js-sha3";
const { keccak_256 } = sha3;

export const FIELD_PRIME = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617"
);

export function toField(x) {
  let b;
  if (typeof x === "bigint") b = x;
  else if (typeof x === "number") b = BigInt(x);
  else b = BigInt(x); // decimal or 0x-hex string
  const r = b % FIELD_PRIME;
  return r < 0n ? r + FIELD_PRIME : r;
}

export function keccak256ModP(buffers) {
  const hex = "0x" + keccak_256(Buffer.concat(buffers));
  return toField(BigInt(hex));
}

// Map a string task_id (e.g. "gk_24_9d1") to a field element.
// Default "keccak": keccak256(utf8(task_id)) mod p (EVM-standard hash).
// Alternatives (GATEKEEPER_TASK_ID_MODE): "numeric" (digits of the id),
// "hex" (hex chars of the id). The correct mode is unconfirmed in the public
// docs — practice tasks are the oracle; switch if the platform rejects proofs.
export function taskIdToField(taskId, mode = "keccak") {
  const id = String(taskId || "");
  if (mode === "numeric") {
    const digits = id.replace(/\D/g, "");
    return digits ? toField(BigInt(digits)) : 0n;
  }
  if (mode === "hex") {
    const hex = id.replace(/[^0-9a-fA-F]/g, "");
    return hex ? toField(BigInt("0x" + hex)) : 0n;
  }
  return keccak256ModP([Buffer.from(id, "utf8")]);
}
