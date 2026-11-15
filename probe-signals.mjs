// Probe the gatekeeper wasm (Circom 2) for input signal names via fnv-1a hash.
// getInputSignalSize(hMSB,hLSB) returns >=0 when the signal exists, <0 otherwise.
import { readFileSync } from "fs";
import { WitnessCalculatorBuilder } from "circom_runtime";

const wasm = readFileSync("./circuits/gatekeeper.wasm");
const wc = await WitnessCalculatorBuilder(wasm, { sanityCheck: false });
const inst = wc.instance.exports;

console.log("circom version:", inst.getVersion());
console.log("total input signals (getInputSize):", inst.getInputSize());
console.log("witness size:", inst.getWitnessSize());

function fnvHash(str) {
  const uint64_max = BigInt(2) ** BigInt(64);
  let hash = BigInt("0xCBF29CE484222325");
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash *= BigInt(0x100000001B3);
    hash %= uint64_max;
  }
  const shash = hash.toString(16);
  return "0".repeat(16 - shash.length) + shash;
}

const candidates = [
  "decision", "approve", "isApproved", "approved",
  "registeredVk", "registered_vk", "registeredVkHash", "registered_vk_hash",
  "proofVk", "proof_vk", "proofVkHash", "proof_vk_hash",
  "vkHash", "vk_hash", "vk", "registeredVkHashHex",
  "minimum", "min", "publicBalance", "public_balance", "balance",
  "threshold", "publicThreshold",
  "expiryBlock", "expiry_block", "expiry", "currentBlock", "current_block",
  "currentBlockNumber", "blockNumber",
  "recipient", "conditionRecipient", "condition_recipient",
  "conditionAddress", "payer", "sender",
  "amount", "maxTransfer", "max_transfer", "maxAmount", "max_amount", "cap",
  "proofTx", "proof_tx", "proofTxHash", "proof_tx_hash", "proofRef", "proof_ref",
  "proofReference", "txHash", "reused", "isReused", "proofReused", "is_reused",
  "alreadyUsed", "seen",
  "valid", "isValid", "reasonCode", "taskId", "nonce", "salt",
  // array-style / indexed variants
  "vkHash[0]", "recipient[0]",
];

const found = [];
for (const name of candidates) {
  const h = fnvHash(name);
  const hMSB = parseInt(h.slice(0, 8), 16);
  const hLSB = parseInt(h.slice(8, 16), 16);
  let size;
  try {
    size = inst.getInputSignalSize(hMSB, hLSB);
  } catch (e) {
    size = -1;
  }
  if (size >= 0) {
    found.push([name, size]);
    console.log(`FOUND  ${name}  size=${size}`);
  }
}
console.log(`\n${found.length} signal names found of ${candidates.length} tried (circuit has ${inst.getInputSize()} inputs)`);
