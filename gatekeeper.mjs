// gowther.ai — local Proof Gatekeeper decision logic (deterministic, no model).
// Mirrors the trap encyclopedia on https://agentgames.zkverify.io/events/proof-gatekeeper
// and the security checklist on https://agentgames.zkverify.io/build.
// Same input -> same decision, always. Fail closed: any doubt -> REJECT.
//
// Rule (from the tournament): APPROVE only when EVERY check passes.
//   1. VK_SUBSTITUTION   proofVkHash (mod BN254 field prime) == registeredVkHash
//   2. THRESHOLD_MISMATCH publicBalance >= minimum
//   3. PROOF_REUSED       proofTx not in the seen-reference set (platform registry;
//                          the circuit itself has no "seen" input — replay protection
//                          comes from the (taskId, salt) binding in the proof)
//   4. EXPIRED_CONDITION currentBlock <= expiryBlock
//   5. RECIPIENT_MISMATCH recipient == conditionRecipient
//   6. AMOUNT_OVERFLOW    amount <= maxTransfer
// Otherwise the decision is REJECT with the first failing reason code.
// The circuit (GatekeeperEvaluation) enforces the same rule: it asserts
// decision == (all checks pass), so a wrong APPROVE cannot be proven.
import { readFileSync } from "fs";

export const FIELD_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const modP = (x) => ((BigInt(x) % FIELD_PRIME) + FIELD_PRIME) % FIELD_PRIME;

export function decide(task, seenProofRefs = new Set()) {
  const input = task.input ?? task;
  const vkReg = modP(input.registered_vk ?? input.registeredVkHash);
  const vkProof = modP(input.proof_vk ?? input.proofVkHash);
  if (vkReg !== vkProof) return { decision: 0, reason_code: "VK_SUBSTITUTION" };
  if (BigInt(input.public_balance ?? input.publicBalance) < BigInt(input.minimum))
    return { decision: 0, reason_code: "THRESHOLD_MISMATCH" };
  const ref = input.proof_tx ?? input.proofTx;
  if (ref && seenProofRefs.has(ref)) return { decision: 0, reason_code: "PROOF_REUSED" };
  if (BigInt(input.current_block ?? input.currentBlock) > BigInt(input.expiry_block ?? input.expiryBlock))
    return { decision: 0, reason_code: "EXPIRED_CONDITION" };
  const rcpt = modP(input.recipient);
  const condRcpt = modP(input.condition_recipient ?? input.conditionRecipient);
  if (rcpt !== condRcpt) return { decision: 0, reason_code: "RECIPIENT_MISMATCH" };
  if (BigInt(input.amount) > BigInt(input.max_transfer ?? input.maxTransfer))
    return { decision: 0, reason_code: "AMOUNT_OVERFLOW" };
  return { decision: 1, reason_code: "VALID_CONDITION" };
}

// Build the 13 circuit inputs from a task + a decision + a salt.
// taskId: numeric task identifier (sample tasks use e.g. 24 from "gk_24_9d1").
// salt: private per-task blinding value; it never appears in the public signals
// but changes public signal [0] (the binding commitment), so a proof cannot be
// replayed for another task.
export function buildCircuitInput(task, decision, salt, taskId) {
  const input = task.input ?? task;
  return {
    decision,
    registeredVkHash: modP(input.registered_vk ?? input.registeredVkHash).toString(),
    proofVkHash: modP(input.proof_vk ?? input.proofVkHash).toString(),
    minimum: Number(input.minimum),
    publicBalance: Number(input.public_balance ?? input.publicBalance),
    expiryBlock: Number(input.expiry_block ?? input.expiryBlock),
    currentBlock: Number(input.current_block ?? input.currentBlock),
    recipient: modP(input.recipient).toString(),
    conditionRecipient: modP(input.condition_recipient ?? input.conditionRecipient).toString(),
    amount: Number(input.amount),
    maxTransfer: Number(input.max_transfer ?? input.maxTransfer),
    taskId: Number(taskId ?? input.task_id ?? 0),
    salt: Number(salt),
  };
}

// CLI: node gatekeeper.mjs <task.json> [salt] [taskId]
// Prints the decision; writes input-<taskid>.json for snarkjs fullProve.
if (process.argv[1]?.endsWith("gatekeeper.mjs")) {
  const task = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const salt = Number(process.argv[3] ?? 12345);
  const taskId = Number(process.argv[4] ?? task.task_id_numeric ?? 24);
  let seen = new Set();
  try { seen = new Set(JSON.parse(readFileSync("seen.json", "utf8"))); } catch { /* no seen registry yet */ }
  const { decision, reason_code } = decide(task, seen);
  console.log(JSON.stringify({ decision: decision ? "APPROVE" : "REJECT", reason_code }, null, 2));
  const circ = buildCircuitInput(task, decision, salt, taskId);
  const out = `input-${task.task_id ?? "task"}.json`;
  const { writeFileSync } = await import("fs");
  writeFileSync(out, JSON.stringify(circ, null, 2));
  console.log(`circuit input written to ${out}`);
}
