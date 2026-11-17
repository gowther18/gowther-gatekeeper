// Shared request handling for the Agent Games endpoint.
// Used by server.js (local plain-Node server) and api/agent.js (Vercel).
// Pure-ish: handleAgent(rawBodyBuffer, headers) -> { status, body, headers }.
// FAIL CLOSED throughout: any uncertainty -> REJECT, never APPROVE by default.
//
// Decision flow for a task envelope:
//   1. Idempotency: a retry of the same task_id returns the byte-identical
//      earlier response (signature is deterministic over the body).
//   2. Timestamp checks: past deadline / far-future issued_at -> REJECT
//      EXPIRED_CONDITION, no proof (a late answer is a timeout anyway).
//   3. decide() (deterministic, from gatekeeper.mjs) with the persistent
//      seen-set; APPROVE claims its proof_tx before proving.
//   4. Groth16 proof via snarkjs (bounded budget); on failure the decision
//      is still returned WITHOUT a proof — never flip the decision, never
//      time out. PROOF_REUSED carries no proof by definition.
//   5. The answered proof_tx is recorded as seen (APPROVE and REJECT
//      alike — see lib/store.mjs for the reasoning).
// Malformed envelopes (missing/bad fields) fail closed as REJECT with
// VK_SUBSTITUTION — the first check in trap order — rather than a 500:
// a task the platform sent should be well-formed, and a 500 would score
// as a timeout either way.
import { decide } from "../gatekeeper.mjs";
import { signatureFor, verifySignature } from "./hmac.mjs";
import { buildProofInput, generateProof } from "./prove.mjs";

export const SIGNATURE_HEADER = "x-agent-games-signature";

const REASON = {
  VALID: "VALID_CONDITION",
  VK: "VK_SUBSTITUTION",
  THRESHOLD: "THRESHOLD_MISMATCH",
  REUSED: "PROOF_REUSED",
  EXPIRED: "EXPIRED_CONDITION",
  RECIPIENT: "RECIPIENT_MISMATCH",
  OVERFLOW: "AMOUNT_OVERFLOW",
};

function parseTimestamp(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const ms = Date.parse(value.trim());
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

export function createHandler(options = {}) {
  const secret = options.secret || "";
  const hmacFormat = options.hmacFormat || "hex";
  const taskIdMode = options.taskIdMode || "keccak";
  const store = options.store || null;
  const softBudgetMs = options.softBudgetMs || 8000;
  const maxFutureSkewMs = options.maxFutureSkewMs || 300000;
  const proveFn = options.generateProofFn || generateProof;
  const agentId = options.agentId || "gowther.ai";
  const protocolVersion = options.protocolVersion || "v1";
  let selfTest = options.selfTest || "not-run";

  function setSelfTest(value) {
    selfTest = value;
  }

  function respond(status, obj) {
    const body = JSON.stringify(obj);
    const headers = { "content-type": "application/json" };
    if (secret) headers[SIGNATURE_HEADER] = signatureFor(secret, body, hmacFormat);
    return { status, body, headers };
  }

  function log(...args) {
    console.log("[agent]", ...args);
  }

  async function handleGatekeeperTask(envelope, startedAt) {
    const input = envelope.input && typeof envelope.input === "object" ? envelope.input : {};
    const taskId = typeof envelope.task_id === "string" ? envelope.task_id : "";
    const proofTx = typeof input.proof_tx === "string" ? input.proof_tx : "";

    // Idempotency first: a retry returns the exact earlier response.
    if (taskId && store) {
      const cached = store.getCachedResponse(taskId);
      if (cached) {
        log("idempotent replay task_id=", taskId.slice(0, 24));
        return cached;
      }
    }

    const now = Date.now();
    const deadlineMs = parseTimestamp(envelope.deadline_at);
    const issuedMs = parseTimestamp(envelope.issued_at);
    const expiredEntry = (reason) =>
      respond(200, {
        decision: "REJECT",
        reason_code: reason,
        ...(proofTx ? { proof_tx: proofTx } : {}),
      });

    if (deadlineMs !== null && now > deadlineMs) {
      log("task past deadline task_id=", taskId.slice(0, 24));
      const entry = expiredEntry(REASON.EXPIRED);
      if (taskId && store) store.cacheResponse(taskId, entry);
      return entry;
    }
    if (issuedMs !== null && issuedMs > now + maxFutureSkewMs) {
      log("task issued_at too far in the future task_id=", taskId.slice(0, 24));
      const entry = expiredEntry(REASON.EXPIRED);
      if (taskId && store) store.cacheResponse(taskId, entry);
      return entry;
    }

    // Decide. Malformed fields throw inside decide() -> fail closed.
    const flatTask = { ...input, task_id: taskId };
    let result;
    try {
      const isReused = store ? store.isProofUsed(proofTx) : false;
      const seen = new Set(isReused && proofTx ? [proofTx] : []);
      result = decide(flatTask, seen);
    } catch (e) {
      log("malformed task, fail-closed REJECT task_id=", taskId.slice(0, 24), String(e.message).slice(0, 120));
      const entry = respond(200, {
        decision: "REJECT",
        reason_code: REASON.VK,
        ...(proofTx ? { proof_tx: proofTx } : {}),
      });
      if (taskId && store) store.cacheResponse(taskId, entry);
      return entry;
    }

    const decisionStr = result.decision === 1 ? "APPROVE" : "REJECT";

    // Claim the proof BEFORE generating it: an APPROVE decision claims its
    // proof_tx, and a lost claim flips the decision to PROOF_REUSED.
    if (result.decision === 1 && proofTx && store) {
      const claimed = store.markProofUsed(proofTx);
      if (!claimed) {
        log("proof claimed already, flipping to PROOF_REUSED task_id=", taskId.slice(0, 24));
        result = { decision: 0, reason_code: REASON.REUSED };
      }
    }

    const response = {
      decision: result.decision === 1 ? "APPROVE" : "REJECT",
      reason_code: result.reason_code,
    };

    // Proof on every provable task. PROOF_REUSED has no proof by definition.
    if (result.reason_code !== REASON.REUSED) {
      const remainingBudget = Math.max(
        0,
        Math.min(
          softBudgetMs - (Date.now() - startedAt),
          deadlineMs ? deadlineMs - Date.now() - 1000 : Infinity
        )
      );
      if (remainingBudget > 0) {
        try {
          const circuitInput = buildProofInput(flatTask, result.decision, taskIdMode);
          const t0 = Date.now();
          const generated = await proveFn(circuitInput, remainingBudget);
          response.proof = generated.proof;
          response.public_signals = generated.publicSignals;
          log(`proof generated in ${Date.now() - t0}ms decision=${decisionStr} task_id=`, taskId.slice(0, 24));
        } catch (err) {
          // Proof failure must not change the decision. A correct decision
          // without a proof costs -2 and no bonus — far better than flipping
          // the decision or timing out.
          log("proof generation failed, answering decision without proof:", String(err.message).slice(0, 200));
        }
      } else {
        log("no proof budget left, answering decision without proof task_id=", taskId.slice(0, 24));
      }
    }

    if (proofTx) response.proof_tx = proofTx;

    const entry = respond(200, response);
    // Record the answered proof reference as seen (see store.mjs).
    if (proofTx && store) store.markProofUsed(proofTx);
    if (taskId && store) store.cacheResponse(taskId, entry);
    return entry;
  }

  async function handleAgent(rawBody, headers = {}) {
    const startedAt = Date.now();
    const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || "");

    if (!secret) {
      log("misconfigured: AGENT_GAMES_HMAC_SECRET is not set");
      return respond(500, { error: "server_misconfigured" });
    }

    const signatureHeader = headers[SIGNATURE_HEADER] || headers["X-Agent-Games-Signature"];
    if (!signatureHeader || !verifySignature(secret, raw, signatureHeader, hmacFormat)) {
      log("rejected invalid_signature bytes=", raw.length);
      return respond(401, { error: "invalid_signature" });
    }

    let envelope;
    try {
      envelope = JSON.parse(raw.toString("utf8"));
    } catch (_) {
      log("rejected invalid_json bytes=", raw.length);
      return respond(400, { error: "invalid_json" });
    }

    if (!envelope || typeof envelope !== "object" || typeof envelope.type !== "string") {
      log("rejected invalid_envelope");
      return respond(400, { error: "invalid_envelope" });
    }

    if (envelope.type === "agent-games.preflight.v1") {
      log("preflight ok");
      return respond(200, { ok: true, protocolVersion });
    }

    if (envelope.type === "agent-games.proof-gatekeeper.v1") {
      return handleGatekeeperTask(envelope, startedAt);
    }

    log("rejected unknown_type type=", envelope.type);
    return respond(400, { error: "unknown_type", type: envelope.type });
  }

  function handleHealth() {
    return respond(200, {
      ok: true,
      agent: agentId,
      protocolVersion,
      hmacConfigured: Boolean(secret),
      taskIdMode,
      selfTest,
      store: store ? store.stats() : null,
    });
  }

  return { handleAgent, handleHealth, setSelfTest };
}
