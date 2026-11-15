// End-to-end local demo: deterministic decision -> Groth16 proof -> local verify.
// Usage: node run-demo.mjs
// For every task in tasks/*.json: decide with gatekeeper.mjs logic, prove the
// decision with the official gatekeeper circuit, verify with snarkjs.
// Then, for every REJECT task, also try proving decision=1 (wrong approve):
// the circuit MUST refuse (assert) — that is the whole point of the demo.
import { readFileSync, readdirSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { decide, buildCircuitInput } from "./gatekeeper.mjs";

const SNARK = "./node_modules/.bin/snarkjs";
const WASM = "./circuits/gatekeeper.wasm";
const ZKEY = "./circuits/gatekeeper_final.zkey";
const VK = "./circuits/verification_key.json";

function run(cmd, args) {
  const t0 = process.hrtime.bigint();
  try {
    execFileSync(cmd, args, { stdio: "pipe" });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { ok: true, ms };
  } catch (e) {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const msg = (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "");
    return { ok: false, ms, msg };
  }
}

const seen = new Set();
const rows = [];
for (const file of readdirSync("tasks").sort()) {
  const task = JSON.parse(readFileSync(`tasks/${file}`, "utf8"));
  const name = file.replace(".json", "");
  const taskNum = Number(task.task_id.split("_")[1]);
  const { decision, reason_code } = decide(task, seen);
  seen.add(task.input.proof_tx);
  const input = buildCircuitInput(task, decision, 12345, taskNum);
  writeFileSync(`input-demo-${name}.json`, JSON.stringify(input, null, 2));
  const prove = run(SNARK, ["g16f", `input-demo-${name}.json`, WASM, ZKEY, `proof-demo-${name}.json`, `public-demo-${name}.json`]);
  let verify = { ok: false };
  if (prove.ok) verify = run(SNARK, ["g16v", VK, `public-demo-${name}.json`, `proof-demo-${name}.json`]);
  rows.push({ name, decision: decision ? "APPROVE" : "REJECT", reason_code, prove: prove.ok, proveMs: Math.round(prove.ms), verify: verify.ok });

  // Negative control: for every REJECT, a wrong APPROVE must fail to prove.
  if (decision === 0) {
    const bad = buildCircuitInput(task, 1, 12345, taskNum);
    writeFileSync(`input-demo-${name}-wrong-approve.json`, JSON.stringify(bad, null, 2));
    const badProve = run(SNARK, ["g16f", `input-demo-${name}-wrong-approve.json`, WASM, ZKEY, `proof-demo-${name}-wrong.json`, `public-demo-${name}-wrong.json`]);
    rows.push({ name: name + " + decision=1", decision: "APPROVE?", reason_code: "MUST FAIL", prove: badProve.ok, proveMs: Math.round(badProve.ms), verify: false });
  }
}

console.log("task                          | decision | reason             | prove | ms   | verify");
console.log("------------------------------|----------|--------------------|-------|------|-------");
for (const r of rows) {
  console.log(
    `${r.name.padEnd(28)} | ${r.decision.padEnd(8)} | ${r.reason_code.padEnd(18)} | ${String(r.prove).padEnd(5)} | ${String(r.proveMs).padEnd(4)} | ${r.verify}`
  );
}
