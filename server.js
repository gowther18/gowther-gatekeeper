// gowther.ai — Proof Gatekeeper live responder (plain Node, no framework).
// Endpoints:
//   GET  /health     -> status incl. startup proof self-test result
//   POST /agent      -> signed task envelope in, signed decision + proof out
//   POST /gatekeeper -> alias of /agent (accepted for convenience)
//
// Behaviour:
// - Inbound HMAC is verified over the RAW body before JSON parsing.
//   Bad/missing signature -> 401 (signed when the secret is configured).
// - Every response is signed with x-agent-games-signature over its raw body.
// - Preflight envelopes {"type":"agent-games.preflight.v1"} are answered
//   {ok:true, protocolVersion:"v1"} (exactly — one extra field fails).
// - PROOF_REUSED answers carry no proof. If proof generation ever fails,
//   the decision is still returned without a proof rather than crashing.
// - Fail closed everywhere: errors / uncertainty -> REJECT, never APPROVE.
// - The server REFUSES to start without AGENT_GAMES_HMAC_SECRET: an
//   unsigned responder would accept forged tasks. For local tests, set a
//   throwaway test secret in the environment (see test/test-server.mjs).
// - Startup self-test: prove the valid demo task and verify locally. A
//   FAIL is logged loudly but does not block startup — decisions without
//   proofs still score far better than silence; the operator must notice
//   it in /health and fix the deployment.
import http from "node:http";
import { createHandler } from "./lib/handler.mjs";
import { signatureFor } from "./lib/hmac.mjs";
import { Store } from "./lib/store.mjs";
import { assertCircuitsPresent, buildProofInput, generateProof, verifyProof } from "./lib/prove.mjs";
import { decide } from "./gatekeeper.mjs";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const HMAC_SECRET = process.env.AGENT_GAMES_HMAC_SECRET || "";
const HMAC_FORMAT = process.env.AGENT_GAMES_HMAC_FORMAT || "hex";
const TASK_ID_MODE = process.env.GATEKEEPER_TASK_ID_MODE || "keccak";
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB; task envelopes are < 10 KB

if (!HMAC_SECRET) {
  console.error(
    "[gatekeeper] FATAL: AGENT_GAMES_HMAC_SECRET is not set. " +
      "Copy it from the Agent Games dashboard (Rotate Secret) and set it in the environment. " +
      "Refusing to start unsigned."
  );
  process.exit(1);
}

try {
  assertCircuitsPresent();
} catch (e) {
  console.error("[gatekeeper] FATAL:", e.message);
  process.exit(1);
}

const store = new Store();
const { handleAgent, handleHealth, setSelfTest } = createHandler({
  secret: HMAC_SECRET,
  hmacFormat: HMAC_FORMAT,
  taskIdMode: TASK_ID_MODE,
  store,
  softBudgetMs: Number(process.env.SOFT_BUDGET_MS || 8000),
  maxFutureSkewMs: Number(process.env.MAX_FUTURE_SKEW_MS || 300000),
});

// Startup self-test: prove the valid demo task, verify locally.
async function runSelfTest() {
  const task = JSON.parse(readFileSync(new URL("./tasks/valid.json", import.meta.url), "utf8"));
  const flatTask = { ...task.input, task_id: task.task_id };
  try {
    const { decision } = decide(flatTask, new Set());
    if (decision !== 1) throw new Error(`self-test task decided ${decision}, expected APPROVE`);
    const input = buildProofInput(flatTask, decision, TASK_ID_MODE);
    const { proof, publicSignals } = await generateProof(input, 30000);
    const ok = await verifyProof(proof, publicSignals);
    setSelfTest(ok ? "PASS" : "FAIL (proof did not verify)");
  } catch (e) {
    setSelfTest(`FAIL (${String(e.message).slice(0, 120)})`);
  }
  console.log("[selftest] gatekeeper proof self-test:", selfTestValue());
}

function selfTestValue() {
  // handleHealth exposes the current value; read it back for the log line.
  return JSON.parse(handleHealth().body).selfTest;
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    const result = handleHealth();
    res.writeHead(result.status, result.headers);
    res.end(result.body);
    return;
  }

  if (req.method === "POST" && (req.url === "/agent" || req.url === "/gatekeeper")) {
    const chunks = [];
    let tooLarge = false;
    req.on("data", (c) => {
      chunks.push(c);
      if (Buffer.concat(chunks).length > MAX_BODY_BYTES) tooLarge = true;
    });
    req.on("end", async () => {
      if (tooLarge) {
        const result = { status: 413, body: JSON.stringify({ error: "body_too_large" }), headers: { "content-type": "application/json" } };
        res.writeHead(result.status, result.headers);
        res.end(result.body);
        return;
      }
      const raw = Buffer.concat(chunks);
      const result = await handleAgent(raw, req.headers || {});
      res.writeHead(result.status, result.headers);
      res.end(result.body);
    });
    return;
  }

  // Unknown route: signed 404 (consistent with every other response).
  const body = JSON.stringify({ ok: false, error: "not found" });
  res.writeHead(404, {
    "content-type": "application/json",
    "x-agent-games-signature": signatureFor(HMAC_SECRET, body, HMAC_FORMAT),
  });
  res.end(body);
});

server.listen(PORT, HOST, () => {
  console.log(
    `[gatekeeper] listening on ${HOST}:${PORT} (hmac on, taskIdMode=${TASK_ID_MODE}, store=${store.stats().path})`
  );
  runSelfTest();
});
