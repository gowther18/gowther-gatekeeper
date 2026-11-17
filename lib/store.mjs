// Durable state for the Agent Games endpoint: the seen-set of answered
// proof references (proof_tx) and the idempotency cache
// (task_id -> exact earlier response).
//
// Backend: a JSON file (default ./data/state.json; on Vercel /tmp/...).
// Writes are atomic (tmp file + rename). Entries carry expiresAt (TTL 7
// days, covers the whole season); expired entries are treated as absent.
//
// Semantics (documented choice): EVERY answered task's proof_tx is recorded
// as seen — APPROVE and REJECT alike — because the platform's build
// checklist says to check the proof reference against the local seen-set,
// and a reference re-sent in a later task is the PROOF_REUSED trap
// (~11% of tasks). The platform is the final arbiter of reuse; this local
// set is the first line of defence.
//
// Vercel limitation, stated plainly: on serverless the state file lives in
// /tmp and is per-instance/ephemeral across cold starts. A retry landing on
// a different instance re-decides instead of replaying (the seen-set may
// also miss). The durable upgrade path is Vercel Blob (@vercel/blob +
// BLOB_READ_WRITE_TOKEN) — same shape as the ibank reference (lib/store.js
// there). For a single-region Hobby deploy with warm instances this is a
// small, accepted risk; for full durability wire Blob before R06 if time
// allows. Store errors are FAIL-OPEN (log + continue with the in-memory
// mirror) so a disk problem never blocks answering tasks.
import fs from "node:fs";
import path from "node:path";

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_CACHED_RESPONSES = 1000;

function defaultStatePath() {
  if (process.env.GATEKEEPER_STATE_PATH) return process.env.GATEKEEPER_STATE_PATH;
  // Vercel serverless: only /tmp is writable.
  if (process.env.VERCEL) return path.join("/tmp", "gatekeeper-state.json");
  return path.join(process.cwd(), "data", "state.json");
}

function normalizeRef(ref) {
  return typeof ref === "string" ? ref.trim().toLowerCase() : "";
}

export class Store {
  constructor(statePath = defaultStatePath()) {
    this.statePath = statePath;
    this.seen = new Set(); // normalized proof_tx
    this.responses = new Map(); // task_id -> { status, body }
    this.errors = 0;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      const now = Date.now();
      for (const ref of raw.seen || []) {
        if (ref && (!raw.seenAt || (raw.seenAt[ref] || 0) + TTL_MS > now)) {
          this.seen.add(ref);
        }
      }
      for (const [taskId, entry] of Object.entries(raw.responses || {})) {
        if (entry && typeof entry.expiresAt === "number" && entry.expiresAt > now) {
          // Full entry: status + body + headers (the signature header is
          // part of the cached response — a replay must be byte-identical
          // AND carry the same valid signature).
          this.responses.set(taskId, { status: entry.status, body: entry.body, headers: entry.headers || {} });
        }
      }
    } catch (e) {
      if (e.code !== "ENOENT") {
        this.errors += 1;
        console.error("[store] load failed, starting empty:", String(e.message).slice(0, 200));
      }
    }
  }

  save() {
    try {
      const dir = path.dirname(this.statePath);
      fs.mkdirSync(dir, { recursive: true });
      const now = Date.now();
      const state = {
        seen: [...this.seen],
        seenAt: Object.fromEntries([...this.seen].map((r) => [r, now])),
        responses: Object.fromEntries(
          [...this.responses.entries()].map(([k, v]) => [
            k,
            { status: v.status, body: v.body, headers: v.headers || {}, expiresAt: now + TTL_MS },
          ])
        ),
      };
      const tmp = `${this.statePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, this.statePath);
    } catch (e) {
      this.errors += 1;
      console.error("[store] save failed (continuing in-memory):", String(e.message).slice(0, 200));
    }
  }

  isProofUsed(proofTx) {
    return this.seen.has(normalizeRef(proofTx));
  }

  // Record a proof reference as seen. Returns true if this call recorded
  // it (or it was already recorded by this instance), false if another
  // holder recorded it first — in a single-instance server the latter
  // cannot happen; the return value exists for the claim-before-prove
  // pattern used by the handler.
  markProofUsed(proofTx) {
    const ref = normalizeRef(proofTx);
    if (ref === "") return true;
    if (this.seen.has(ref)) return false;
    this.seen.add(ref);
    this.save();
    return true;
  }

  getCachedResponse(taskId) {
    if (typeof taskId !== "string" || taskId === "") return null;
    return this.responses.get(taskId) || null;
  }

  cacheResponse(taskId, entry) {
    if (typeof taskId !== "string" || taskId.length === 0) return;
    this.responses.set(taskId, { status: entry.status, body: entry.body, headers: entry.headers || {} });
    if (this.responses.size > MAX_CACHED_RESPONSES) {
      const oldest = this.responses.keys().next().value;
      this.responses.delete(oldest);
    }
    this.save();
  }

  stats() {
    return {
      path: this.statePath,
      usedProofs: this.seen.size,
      cachedResponses: this.responses.size,
      errors: this.errors,
    };
  }
}
