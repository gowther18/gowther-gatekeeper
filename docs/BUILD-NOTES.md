# BUILD NOTES — gowther.ai Proof Gatekeeper (local demo for zkVerify Agent Games, Creator Track)

Agent: **gowther.ai** — Binance Agentic Wallet `0x9C5cb173bEfC9daA78F2265c434ff4A8EB30b428`, X **@0xcaraka**
Tournament: zkVerify Agent Games Season 01 (21 Oct – 21 Nov 2026), Creator Track.
Built: 15 Nov 2026, all local. **Nothing was submitted to mainnet, no API key used,
no registration performed here** (registration is the user's own step, via X).

## 1. Official sources read

- https://agentgames.zkverify.io/events/creator-track — manual review; criteria:
  technical substance, clarity, zkVerify relevance, originality. Entries must include
  `#AgentGames`; on X also tag `@ZKVProtocol`.
- https://agentgames.zkverify.io/events/proof-gatekeeper — task arena, sample task
  payload, 7 trap varieties, scoring (+12 correct decision, −6 approving a trap,
  −3 rejecting a valid request, −2 timeout/offline, −2 proof fails to verify).
- https://agentgames.zkverify.io/build — builder field guide; circuit artifacts;
  registered gatekeeper vk_hash; Kurier/zkVerifyJS submission paths; security checklist.
- https://agentgames.zkverify.io/guide — registration flow (X or wallet).
- https://agentgames.zkverify.io/api/circuit-info — artifact URLs + vk hashes (JSON).

## 2. Circuit artifacts (official, downloaded 15 Nov 2026)

| file | bytes | sha256 |
|---|---|---|
| `circuits/gatekeeper.wasm` | 1,755,820 | `be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f` |
| `circuits/gatekeeper_final.zkey` | 309,750 | `adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d` |
| `circuits/verification_key.json` | — | exported locally from the zkey (`snarkjs zkev`) — not served by the site |

- Protocol: **Groth16**, curve **bn128**, Circom **2** (`getVersion() == 2`).
- `nVars = 647`, `nPublic = 13`.
- Registered verification-key hash (from `/build` **and** `/api/circuit-info`, identical):
  `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`

## 3. The 13 input signals — discovered, not assumed

The build page does **not** list the circuit's input signal names, and no `.r1cs` /
`.sym` / `verification_key.json` is served. I recovered the names by probing the
wasm itself: Circom 2 stores signals by FNV-1a hash, and the wasm exports
`getInputSignalSize(hMSB, hLSB)`, which returns the signal size (≥1) for a real
signal and 0 for an unknown name. Script: `probe-signals.mjs`.

Result — exactly 13 inputs, matching `getInputSize() == 13`:

```
decision, registeredVkHash, proofVkHash, minimum, publicBalance,
expiryBlock, currentBlock, recipient, conditionRecipient, amount,
maxTransfer, taskId, salt
```

### Public-signal layout (from `public-*.json`, 13 values, in order)

```
[0]  binding commitment (computed; see below)
[1]  registeredVkHash     [2]  proofVkHash
[3]  minimum              [4]  publicBalance
[5]  expiryBlock          [6]  currentBlock
[7]  recipient            [8]  conditionRecipient
[9]  amount               [10] maxTransfer
[11] decision (1 = APPROVE, 0 = REJECT)
[12] taskId
```

`salt` is a **private** input — it never appears in the public signals. But public
signal [0] changes when *only* the salt changes, and changes again when *only*
the taskId changes (verified experimentally). So [0] is a binding commitment over
the inputs including the private salt: the same decision/facts with a different
salt produce a different public commitment, which is what makes a proof
non-replayable across tasks.

### Note: vk hashes exceed the BN254 field prime

The registered vk hash (`0x6b79c6…`) as an integer is larger than the BN254 prime
`21888242871839275222246405745257275088548364400416034343698204186575808495617`.
The witness calculator reduces inputs mod p (`normalize`), so the hash is used as
`hash mod p` — equal hashes still reduce to equal field elements, so the
equality check `registeredVkHash == proofVkHash` works. Both hashes in my demo
reduce to `4836144126773920907502496244340012141761656471453348073975163706578152814510`.

## 4. Decision logic — `gatekeeper.mjs` (deterministic, no model)

`decide(task, seenProofRefs)` returns `{decision, reason_code}`. Same input →
same decision, always. Fail closed: any doubt → REJECT. Checks, in order
(matching the tournament's trap encyclopedia):

| check | fail → reason_code |
|---|---|
| proofVkHash (mod p) ≠ registeredVkHash (mod p) | `VK_SUBSTITUTION` |
| publicBalance < minimum | `THRESHOLD_MISMATCH` |
| proofTx already in seen set | `PROOF_REUSED` |
| currentBlock > expiryBlock | `EXPIRED_CONDITION` |
| recipient ≠ conditionRecipient | `RECIPIENT_MISMATCH` |
| amount > maxTransfer | `AMOUNT_OVERFLOW` |
| all pass | `VALID_CONDITION` → APPROVE |

The circuit enforces the same rule: it is named `GatekeeperEvaluation` and
asserts `decision == (all checks pass)`. A wrong APPROVE cannot be proven —
see §5.

`PROOF_REUSED` is the one check the circuit cannot do alone (it has no "seen"
input): reuse is enforced by the platform's proof-reference registry, plus the
(taskId, salt) binding in §3. The decision function checks it against a local
`seen.json` registry.

## 5. Demo results — `node run-demo.mjs` (15 Nov 2026)

Demo tasks in `tasks/` mirror the guide's sample task (minimum 1000, balance 1460,
expiry 8430000, current 8420000, amount 500, cap 1000, recipient
`0xDe4200000000000000000000000000000000009f01` — a synthetic address standing in
for the guide's truncated `0xDe42...9f01`). Salt is fixed at `12345` for
reproducibility; taskId is the numeric part of the sample task id (24).

```
task                          | decision | reason             | prove | ms   | verify
amount-overflow               | REJECT   | AMOUNT_OVERFLOW    | true  | 3511 | true
amount-overflow + decision=1  | APPROVE? | MUST FAIL          | false |  700 | false
expired                       | REJECT   | EXPIRED_CONDITION  | true  | 3085 | true
expired + decision=1          | APPROVE? | MUST FAIL          | false |  609 | false
recipient-mismatch            | REJECT   | RECIPIENT_MISMATCH | true  | 2716 | true
recipient-mismatch + decision=1| APPROVE?| MUST FAIL          | false |  834 | false
threshold-mismatch            | REJECT   | THRESHOLD_MISMATCH | true  | 2879 | true
threshold-mismatch + decision=1| APPROVE?| MUST FAIL          | false |  689 | false
valid                         | APPROVE  | VALID_CONDITION    | true  | 2710 | true
vk-substitution               | REJECT   | VK_SUBSTITUTION    | true  | 2414 | true
vk-substitution + decision=1  | APPROVE? | MUST FAIL          | false |  700 | false
```

- Every correct decision (1 approve + 5 rejects) generates a Groth16 proof in
  ~2.4–3.5 s on this VM and verifies locally: `snarkjs g16v` → `OK!`, exit 0.
- Every wrong APPROVE (decision=1 on a trap) fails at witness/proof time:
  `Error: Assert Failed. Error in template GatekeeperEvaluation_79 line: 102`
  (exit 1). The circuit is the referee: a valid-looking proof for a wrong
  decision cannot be produced.
- Proof files: `proof-demo-*.json`, 803–807 bytes each (Groth16 `pi_a`/`pi_b`/`pi_c`).
- PROOF_REUSED, checked in the decision layer: the same task decided twice with
  the same `proof_tx` returns `VALID_CONDITION` the first time and
  `PROOF_REUSED` the second time.

## 6. Reproduce

```sh
cd ~/workspace/agentgames
npm install snarkjs@0.7.6          # snarkjs 0.7.6, node v24.22.1
node probe-signals.mjs             # recover the 13 input names from the wasm
node run-demo.mjs                  # decide + prove + verify all 6 demo tasks
# single proof, by hand:
node_modules/.bin/snarkjs g16f input-approve.json circuits/gatekeeper.wasm \
  circuits/gatekeeper_final.zkey proof-approve.json public-approve.json
node_modules/.bin/snarkjs g16v circuits/verification_key.json \
  public-approve.json proof-approve.json   # -> OK!
```

## 7. What this demo is NOT (honest limits)

- **Local only.** No proof was submitted to zkVerify mainnet (no Kurier key, no
  fees), no endpoint was deployed, no practice/s scored round was played.
  The 60-second live loop and the platform's independent re-verification were
  not exercised — only the local half of the protocol (decide → prove → verify).
- **Registration is separate.** The agent is not registered on the platform from
  here; that step (sign-in with X) belongs to the user.
- **Assumptions baked into the demo:** `taskId` is taken as the small numeric
  part of the sample task id (24); `salt` is a fixed demo value (12345); the
  recipient address is synthetic. The circuit accepts them because it only
  constrains their relationships, not their provenance — the platform, not the
  circuit, is what ties a taskId to a real issued task.
- **A proof is necessary, not sufficient.** A verifying proof says "this
  decision followed the rule for these inputs". It says nothing about whether
  the inputs themselves were true — a genuine proof attached to a substituted
  verification key still proves the wrong payment if the agent never checks the
  key. That is exactly the trap the tournament is built around, and exactly
  what the decision layer in §4 exists to catch.
