// Groth16 proof generation for the Gatekeeper circuit (official artifacts).
// Circuit inputs (13): minimum, publicBalance, expiryBlock, currentBlock,
// recipient, conditionRecipient, amount, maxTransfer, registeredVkHash,
// proofVkHash, decision, salt (private), taskId.
// Public signals (13): [0] Poseidon(salt, taskId) binding commitment,
// [1] registeredVkHash [2] proofVkHash [3] minimum [4] publicBalance
// [5] expiryBlock [6] currentBlock [7] recipient [8] conditionRecipient
// [9] amount [10] maxTransfer [11] decision [12] taskId.
// The circuit ASSERTS decision == (all checks pass), so a wrong APPROVE
// cannot be proven — fullProve throws instead.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { buildCircuitInput } from "../gatekeeper.mjs";
import { taskIdToField } from "./field.mjs";

// snarkjs is CommonJS with no ESM default export; load it via require.
const require = createRequire(import.meta.url);
const snarkjs = require("snarkjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function resolveCircuitDir() {
  const candidates = [
    path.join(process.cwd(), "circuits"),
    path.join(__dirname, "..", "circuits"),
    path.join(__dirname, "circuits"),
  ];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, "gatekeeper.wasm"))) return dir;
    } catch {
      /* try next */
    }
  }
  return candidates[0];
}

export const CIRCUIT_DIR = process.env.CIRCUIT_DIR || resolveCircuitDir();
export const WASM_PATH = path.join(CIRCUIT_DIR, "gatekeeper.wasm");
export const ZKEY_PATH = path.join(CIRCUIT_DIR, "gatekeeper_final.zkey");
export const VK_PATH = path.join(CIRCUIT_DIR, "verification_key.json");

export function assertCircuitsPresent() {
  for (const p of [WASM_PATH, ZKEY_PATH, VK_PATH]) {
    if (!fs.existsSync(p)) throw new Error(`missing circuit artifact: ${p}`);
  }
}

export function randomSalt() {
  // 128-bit random value; safely below the field prime. Fresh per proof.
  return BigInt("0x" + crypto.randomBytes(16).toString("hex")).toString();
}

// Build the 13 circuit inputs for a FLAT task (envelope input fields +
// task_id at top level). `decision` is 1 (APPROVE) or 0 (REJECT); it MUST
// equal the AND of the checks or witness generation fails by design.
export function buildProofInput(flatTask, decision, taskIdMode = "keccak") {
  const taskIdField = taskIdToField(flatTask.task_id, taskIdMode);
  return buildCircuitInput(flatTask, decision, randomSalt(), taskIdField);
}

// Generate { proof, publicSignals } with a wall-clock timeout. snarkjs
// itself cannot be cancelled; on timeout the promise rejects so the caller
// can fall back to answering the decision WITHOUT a proof (the scoring
// model allows a correct decision without a proof at -2, no bonus) — far
// better than flipping the decision or timing out.
export async function generateProof(circuitInput, timeoutMs) {
  const prove = snarkjs.groth16.fullProve(circuitInput, WASM_PATH, ZKEY_PATH);
  if (!timeoutMs || timeoutMs <= 0) return prove;
  let timer = null;
  try {
    return await Promise.race([
      prove,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("proof generation timed out")),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let vkCache = null;
export function loadVerificationKey() {
  if (!vkCache) vkCache = JSON.parse(fs.readFileSync(VK_PATH, "utf8"));
  return vkCache;
}

export async function verifyProof(proof, publicSignals) {
  return snarkjs.groth16.verify(loadVerificationKey(), publicSignals, proof);
}
