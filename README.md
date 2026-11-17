# gowther.ai — Proof Gatekeeper (zkVerify Agent Games, Season 01)

Local, deterministic half of the Proof Gatekeeper loop: given a signed payment
request, decide APPROVE or REJECT, and prove the decision with a Groth16
zero-knowledge proof generated from the tournament's official circuit.

- Agent: **gowther.ai** (Binance Agent ID wallet)
- Track: **Proof Gatekeeper** — Creator Track entry documents this build
- Circuit: official `gatekeeper.wasm` / `gatekeeper_final.zkey` from
  agentgames.zkverify.io/circuits (Groth16 / bn128, verification-key hash
  `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`)

## What it does

`gatekeeper.mjs` — deterministic decision logic (no model anywhere near the
final call) + circuit-input builder. Decisions are fail-closed: amount over
cap, wrong verification key, balance below minimum, recipient mismatch, or
expired condition all REJECT.

`run-demo.mjs` — end-to-end demo: 6 tasks (1 valid APPROVE + 5 trap REJECTs),
every proof verified locally with snarkjs (`g16v` → OK). The 5 attempts to
prove APPROVE on a trap all fail inside the circuit: it refuses to prove a
wrong decision.

## Run it

```bash
npm install
node run-demo.mjs
```

Proofs take ~1–1.5 s each on a small VM. Everything runs locally — no
mainnet submit, no API key, no public endpoint.

## Live responder (server)

`server.js` is the live half: a plain-Node HTTP server that answers the
platform's signed task webhooks. `api/agent.js` is the same handler as a
Vercel serverless function; `lib/handler.mjs` is shared by both.

- `POST /agent` — signed task envelope in, signed decision + Groth16 proof
  out (60 s hard deadline; fail closed: any error/uncertainty → REJECT).
  Preflight envelopes (`agent-games.preflight.v1`) are answered with exactly
  `{ok: true, protocolVersion: "v1"}`.
- `GET /health` — operator status incl. the startup proof self-test.
- HMAC-SHA256 (lowercase hex, `x-agent-games-signature`) is verified over
  the raw body **before** JSON parsing; every response is signed the same
  way. Bad/missing signature → 401.
- Idempotency: retries of the same `task_id` get the byte-identical earlier
  response. Answered `proof_tx` values are recorded in a persistent
  seen-set (`data/state.json` locally, `/tmp` on Vercel) — a re-sent
  reference is answered `PROOF_REUSED` with no proof.
- Proof failure never flips the decision: the decision is returned without
  a proof (correct decision without proof costs −2, no bonus) rather than
  timing out.
- `taskId` mapping defaults to `keccak256(task_id) mod p`
  (`GATEKEEPER_TASK_ID_MODE=keccak`; `numeric`/`hex` alternatives). The
  correct mapping is unconfirmed in the public docs — validate it against
  a practice task before a scored round.

```bash
# local run (needs the dashboard secret; server refuses to start without it)
export AGENT_GAMES_HMAC_SECRET='...'   # from Agent Games dashboard -> Rotate Secret
npm start
npm test   # 44 checks: preflight, HMAC, 6 demo tasks, replay, PROOF_REUSED,
           # deadline/malformed fail-closed, proof-failure path, timings
```

## Deploy (Vercel Hobby, free)

1. Push this repo to GitHub; import it in Vercel (Hobby, no card).
2. Set env var `AGENT_GAMES_HMAC_SECRET` to the dashboard secret
   (Rotate Secret on agentgames.zkverify.io — shown once; never commit it).
3. Deploy. `vercel.json` rewrites `/agent` → `/api/agent` and bundles the
   circuit files into the function (`includeFiles: circuits/**`).
4. On the Agent Games dashboard, register the full handler path as the
   agent endpoint, e.g. `https://<your-domain>/api/agent` (not just the
   root — a root that 404s fails preflight and every task).
5. Run preflight from the dashboard — pass/fail is the oracle for the
   HMAC hex assumption. Then fire practice tasks (≤10/hr) to validate the
   HMAC format + `taskId` mapping + proof acceptance before a scored round.
6. Watch `GET /health` (self-test must be PASS) and the round results.

Known limits (honest): on Vercel the state file lives in `/tmp` and is
per-instance/ephemeral across cold starts — a retry landing on another
instance re-decides instead of replaying. The durable upgrade is Vercel
Blob (`@vercel/blob` + `BLOB_READ_WRITE_TOKEN`); the ibank reference
(`../ref-ibank/lib/store.js`) shows the shape. Kurier submission is
intentionally skipped: response-only mode (proof in the response) is proven
working, and Kurier would add $0.005/proof. No wallet seed or private key
is ever needed.

## Honest scope

The local demo proves decisions + proofs; the server above is the live
half, tested end-to-end locally (`npm test`, 44/44). It has NOT yet passed
a real platform preflight or practice task — that is the next step after
deploy, and the only way to confirm the HMAC encoding and `taskId`
mapping assumptions. No scored round has been played by this agent yet
(R03–R05: 0/24 tasks answered, −48 pts expected); the realistic target is
R06 (18 Nov 17:30 WIB). Proof-correct is not decision-correct — that is
the whole point of the build.
