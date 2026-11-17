// End-to-end tests for the live Proof Gatekeeper responder.
// Spawns `node server.js` on a test port with a THROWAWAY test secret
// (never the real dashboard secret), then exercises the real HTTP surface:
//   - GET /health (self-test PASS)
//   - preflight (exact body, valid signature; bad/missing signature -> 401)
//   - the 6 demo tasks as signed envelopes (1 APPROVE + 5 REJECTs, correct
//     reason codes, proofs attached, proofs verified locally, public
//     signals checked field-by-field against the task)
//   - replay of the same task_id -> byte-identical response
//   - PROOF_REUSED (same proof_tx, new task_id) -> REJECT, no proof
//   - past-deadline task -> REJECT EXPIRED_CONDITION, no proof
//   - malformed task -> fail-closed REJECT, no crash
//   - bad JSON / unknown type -> 400, signed
//   - unknown route -> 404, signed
//   - proof-failure path (in-process handler with a throwing prover):
//     decision still returned, no proof field
//   - wrong-approve control: proving decision=1 on a trap task must throw
//   - timing: first (cold) and warm task responses, both << 60 s
// Usage: npm test   (exit code 0 = all pass)
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// snarkjs is CommonJS with no ESM default export; load it via require.
const require = createRequire(import.meta.url);
const snarkjs = require("snarkjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const TEST_SECRET = "test-secret-for-local-tests-only-not-the-real-secret";
const PORT = 18081;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}

function sign(body) {
  return crypto.createHmac("sha256", TEST_SECRET).update(body).digest("hex");
}

async function post(pathname, obj, { rawBody = null, signature = "valid" } = {}) {
  const body = rawBody ?? JSON.stringify(obj);
  const headers = { "content-type": "application/json" };
  if (signature === "valid") headers["x-agent-games-signature"] = sign(body);
  else if (signature === "bad") headers["x-agent-games-signature"] = "00".repeat(32);
  const res = await fetch(BASE + pathname, { method: "POST", headers, body });
  const text = await res.text();
  return { status: res.status, text, sig: res.headers.get("x-agent-games-signature") };
}

function verifyRespSig(text, sig) {
  return sig === sign(text);
}

function envelope(task, overrides = {}) {
  const now = Date.now();
  return {
    type: "agent-games.proof-gatekeeper.v1",
    task_id: task.task_id,
    mode: "competition",
    issued_at: new Date(now - 1000).toISOString(),
    deadline_at: new Date(now + 55000).toISOString(),
    input: task.input,
    ...overrides,
  };
}

const FIELD_PRIME = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617"
);
const modP = (x) => ((BigInt(x) % FIELD_PRIME) + FIELD_PRIME) % FIELD_PRIME;

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gk-test-"));
  const statePath = path.join(tmpDir, "state.json");
  const server = spawn("node", ["server.js"], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: String(PORT),
      AGENT_GAMES_HMAC_SECRET: TEST_SECRET,
      GATEKEEPER_TASK_ID_MODE: "keccak",
      GATEKEEPER_STATE_PATH: statePath,
      SOFT_BUDGET_MS: "30000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));

  const cleanup = () => {
    try {
      server.kill("SIGTERM");
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  };

  try {
    // --- wait for /health with self-test PASS ---
    let health = null;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(BASE + "/health");
        health = await res.json();
        if (health.selfTest === "PASS") break;
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    check("GET /health self-test PASS", health?.selfTest === "PASS", JSON.stringify(health));
    check("GET /health hmacConfigured", health?.hmacConfigured === true);

    // Re-fetch /health raw to verify its signature properly.
    {
      const res = await fetch(BASE + "/health");
      const text = await res.text();
      check("GET /health response signature valid", verifyRespSig(text, res.headers.get("x-agent-games-signature")));
    }

    // --- preflight ---
    const preflight = { type: "agent-games.preflight.v1", agent_id: "agt_test", issued_at: new Date().toISOString(), nonce: "abc123" };
    {
      const r = await post("/agent", preflight);
      check("preflight 200 + exact body", r.status === 200 && r.text === JSON.stringify({ ok: true, protocolVersion: "v1" }), r.text);
      check("preflight response signature valid", verifyRespSig(r.text, r.sig));
    }
    {
      const r = await post("/agent", preflight, { signature: "bad" });
      check("preflight bad signature -> 401", r.status === 401, `status=${r.status}`);
    }
    {
      const r = await post("/agent", preflight, { signature: "none" });
      check("preflight missing signature -> 401", r.status === 401, `status=${r.status}`);
    }

    // --- the 6 demo tasks ---
    const vk = JSON.parse(fs.readFileSync(path.join(REPO, "circuits", "verification_key.json"), "utf8"));
    const expected = {
      valid: ["APPROVE", "VALID_CONDITION"],
      "vk-substitution": ["REJECT", "VK_SUBSTITUTION"],
      "threshold-mismatch": ["REJECT", "THRESHOLD_MISMATCH"],
      expired: ["REJECT", "EXPIRED_CONDITION"],
      "recipient-mismatch": ["REJECT", "RECIPIENT_MISMATCH"],
      "amount-overflow": ["REJECT", "AMOUNT_OVERFLOW"],
    };
    const firstResponses = {};
    const timings = {};
    for (const name of Object.keys(expected)) {
      const task = JSON.parse(fs.readFileSync(path.join(REPO, "tasks", `${name}.json`), "utf8"));
      const t0 = Date.now();
      const r = await post("/agent", envelope(task));
      const ms = Date.now() - t0;
      timings[name] = ms;
      const body = JSON.parse(r.text);
      const [expDecision, expReason] = expected[name];
      const okShape =
        r.status === 200 &&
        body.decision === expDecision &&
        body.reason_code === expReason &&
        body.proof_tx === task.input.proof_tx &&
        Array.isArray(body.proof?.pi_a) &&
        Array.isArray(body.public_signals) &&
        body.public_signals.length === 13;
      check(`task ${name}: ${expDecision}/${expReason} + proof`, okShape, `${r.status} ${body.decision}/${body.reason_code} ${ms}ms`);
      check(`task ${name}: response signature valid`, verifyRespSig(r.text, r.sig));
      if (okShape) {
        const verified = await snarkjs.groth16.verify(vk, body.public_signals, body.proof);
        check(`task ${name}: proof verifies locally`, verified === true);
        // Public signals [1..12] must be the task's own field values.
        const { keccak_256 } = require("js-sha3");
        const taskIdField = (BigInt("0x" + keccak_256(task.task_id)) % FIELD_PRIME).toString();
        const sig = body.public_signals;
        const fieldsOk =
          sig[1] === modP(task.input.registered_vk).toString() &&
          sig[2] === modP(task.input.proof_vk).toString() &&
          sig[3] === String(Number(task.input.minimum)) &&
          sig[4] === String(Number(task.input.public_balance)) &&
          sig[5] === String(Number(task.input.expiry_block)) &&
          sig[6] === String(Number(task.input.current_block)) &&
          sig[7] === modP(task.input.recipient).toString() &&
          sig[8] === modP(task.input.condition_recipient).toString() &&
          sig[9] === String(Number(task.input.amount)) &&
          sig[10] === String(Number(task.input.max_transfer)) &&
          sig[11] === (expDecision === "APPROVE" ? "1" : "0") &&
          sig[12] === taskIdField;
        check(`task ${name}: public signals match task fields`, fieldsOk, `sig[12]=${sig[12]?.slice(0, 20)}... expected=${taskIdField.slice(0, 20)}...`);
      }
      firstResponses[name] = r.text;
    }
    console.log("task timings (ms):", JSON.stringify(timings));

    // --- replay: byte-identical ---
    {
      const task = JSON.parse(fs.readFileSync(path.join(REPO, "tasks", "valid.json"), "utf8"));
      const r = await post("/agent", envelope(task));
      check("replay same task_id -> byte-identical body", r.text === firstResponses.valid, `len ${r.text.length} vs ${firstResponses.valid.length}`);
      check("replay response signature valid", verifyRespSig(r.text, r.sig));
    }

    // --- PROOF_REUSED: same proof_tx, new task_id ---
    {
      const task = JSON.parse(fs.readFileSync(path.join(REPO, "tasks", "valid.json"), "utf8"));
      const reuse = envelope(task, { task_id: "gk_24_9d1-again" });
      const r = await post("/agent", reuse);
      const body = JSON.parse(r.text);
      check(
        "PROOF_REUSED: REJECT, no proof field",
        r.status === 200 && body.decision === "REJECT" && body.reason_code === "PROOF_REUSED" && !("proof" in body) && !("public_signals" in body),
        r.text.slice(0, 160)
      );
    }

    // --- past deadline ---
    {
      const task = JSON.parse(fs.readFileSync(path.join(REPO, "tasks", "valid.json"), "utf8"));
      const late = envelope(task, {
        task_id: "gk_late_1",
        deadline_at: new Date(Date.now() - 5000).toISOString(),
      });
      const r = await post("/agent", late);
      const body = JSON.parse(r.text);
      check(
        "past deadline -> REJECT EXPIRED_CONDITION, no proof",
        r.status === 200 && body.decision === "REJECT" && body.reason_code === "EXPIRED_CONDITION" && !("proof" in body),
        r.text.slice(0, 160)
      );
    }

    // --- malformed task (missing fields) -> fail closed, no crash ---
    {
      const bad = {
        type: "agent-games.proof-gatekeeper.v1",
        task_id: "gk_bad_1",
        mode: "competition",
        issued_at: new Date().toISOString(),
        deadline_at: new Date(Date.now() + 55000).toISOString(),
        input: { registered_vk: "0x1234" },
      };
      const r = await post("/agent", bad);
      const body = JSON.parse(r.text);
      check(
        "malformed task -> fail-closed REJECT",
        r.status === 200 && body.decision === "REJECT" && typeof body.reason_code === "string",
        r.text.slice(0, 160)
      );
    }

    // --- bad JSON / unknown type / unknown route ---
    {
      const r = await post("/agent", null, { rawBody: "{not json" });
      check("invalid JSON -> 400 signed", r.status === 400 && verifyRespSig(r.text, r.sig), `status=${r.status}`);
    }
    {
      const r = await post("/agent", { type: "agent-games.something-else.v1" });
      check("unknown type -> 400 signed", r.status === 400 && verifyRespSig(r.text, r.sig), `status=${r.status}`);
    }
    {
      const r = await post("/nope", { type: "agent-games.preflight.v1" });
      check("unknown route -> 404 signed", r.status === 404 && verifyRespSig(r.text, r.sig), `status=${r.status}`);
    }

    // --- proof-failure path (in-process handler, throwing prover) ---
    {
      const { createHandler } = await import("../lib/handler.mjs");
      const { Store } = await import("../lib/store.mjs");
      const store = new Store(path.join(tmpDir, "state-fail.json"));
      const { handleAgent } = createHandler({
        secret: TEST_SECRET,
        store,
        generateProofFn: async () => {
          throw new Error("simulated prover failure");
        },
      });
      const task = JSON.parse(fs.readFileSync(path.join(REPO, "tasks", "valid.json"), "utf8"));
      const body = JSON.stringify(envelope(task, { task_id: "gk_prooffail_1" }));
      const sig = sign(body);
      const res = await handleAgent(Buffer.from(body), { "x-agent-games-signature": sig });
      const parsed = JSON.parse(res.body);
      check(
        "proof failure -> decision returned, no proof field",
        res.status === 200 && parsed.decision === "APPROVE" && parsed.reason_code === "VALID_CONDITION" && !("proof" in parsed),
        res.body.slice(0, 160)
      );
      check("proof failure -> response signature valid", verifyRespSig(res.body, res.headers["x-agent-games-signature"]));
    }

    // --- wrong-approve control: proving decision=1 on a trap must throw ---
    {
      const { buildProofInput, generateProof } = await import("../lib/prove.mjs");
      const task = JSON.parse(fs.readFileSync(path.join(REPO, "tasks", "vk-substitution.json"), "utf8"));
      const flatTask = { ...task.input, task_id: task.task_id };
      const input = buildProofInput(flatTask, 1, "keccak");
      let threw = false;
      try {
        await generateProof(input, 30000);
      } catch {
        threw = true;
      }
      check("wrong APPROVE on trap task cannot be proven", threw === true);
    }

    // --- timing ---
    const coldMs = timings.valid;
    check("cold first-task response < 60 s", coldMs < 60000, `${coldMs}ms`);
    {
      const task = JSON.parse(fs.readFileSync(path.join(REPO, "tasks", "threshold-mismatch.json"), "utf8"));
      // fresh task_id so it is not a replay; reuse the trap (proof still generated)
      const t0 = Date.now();
      const r = await post("/agent", envelope(task, { task_id: "gk_warm_1" }));
      const ms = Date.now() - t0;
      check("warm task response < 60 s", r.status === 200 && ms < 60000, `${ms}ms`);
    }
  } finally {
    cleanup();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log("FAILED:", failed.map((f) => f.name).join("; "));
  }
  // Explicit exit: the spawned server child + fetch keep-alive sockets can
  // otherwise keep the event loop alive after the summary prints.
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("test harness error:", e);
  process.exit(1);
});
