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

Proofs take ~2.4–3.5 s each on a small VM. Everything runs locally — no
mainnet submit, no API key, no public endpoint.

## Honest scope

This is the local half of the loop only. There is no live public endpoint and
no scored round played; the write-up in `docs/article.md` states that limit
plainly. Proof-correct is not decision-correct — that is the whole point of
the build.
