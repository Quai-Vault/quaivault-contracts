# QuaiVault Security Guide for Wallet Owners

An honest assessment of what QuaiVault protects against, what it doesn't, and what
wallet owners must do themselves. This document is written for operators managing
real funds, not for marketing.

---

## Realistic Attack Vectors

Ordered by severity. These are the ways a QuaiVault wallet can actually be compromised.

### 1. Key Compromise + Self-Call Bypass

**Severity: Critical**

If an attacker obtains `threshold` private keys, **the timelock does not protect you**.
Self-calls (owner management, threshold changes, module enablement) execute immediately
once quorum is reached. The attacker can take over the wallet in minutes:

```
T+0:00  Attacker proposes addOwner(attackerAddress)      — self-call, no delay
T+0:30  Attacker approves with compromised keys           — quorum met, executes immediately
T+1:00  Attacker proposes changeThreshold(1)              — self-call, no delay
T+1:30  Attacker approves + executes                      — solo control achieved
T+2:00  Attacker drains wallet via external call           — threshold=1, no meaningful resistance
```

The entire takeover happens in minutes. The timelock only delays **external calls** (fund
transfers, contract interactions). Every administrative operation bypasses it by design —
this is correct behavior (you need fast admin ops for incident response), but it means
key compromise at threshold is total loss.

**Why self-calls bypass the timelock**: If a malicious timelocked withdrawal is in-flight,
honest owners must be able to propose and execute a `cancelByConsensus` self-call *faster*
than the malicious transaction's delay window. If self-calls were also timelocked, cancellation
would be impossible.

**Your defense**:
- Use hardware wallets (Ledger, Trezor) for all owner keys
- Distribute keys geographically — no two keys in the same building
- Set threshold high relative to owner count (e.g., 3-of-5, not 2-of-5)
- Never store key material in cloud storage, email, or chat
- Rotate keys periodically via addOwner/removeOwner self-calls

### 2. Module = God Mode

**Severity: Critical (if a vulnerable module is enabled)**

An enabled module bypasses threshold, timelock, and all access controls. It can execute
arbitrary `Call` or `DelegateCall` on behalf of the wallet with zero approval required.

**DelegateCall is especially dangerous**: it executes code in the wallet's storage context.
A malicious or buggy module using DelegateCall could overwrite ownership, threshold, or
any storage slot directly — bypassing every safety check in the contract.

Module enablement requires multisig consensus (`onlySelf`), so an attacker can't enable
a module without `threshold` approvals. But once a module is enabled, any external caller
that can trigger the module's execution function has full access to the wallet.

**Your defense**:
- Only enable modules that have been independently audited
- Review module source code before enabling — understand exactly what it can do
- Regularly audit which modules are enabled: call `getModulesPaginated(0x1, 50)`
- Disable modules immediately when no longer needed
- Be especially cautious with modules that support DelegateCall operations
- The built-in SocialRecoveryModule and MultiSend library have been audited alongside
  the core contract. Third-party Zodiac modules have not.

### 3. Social Recovery Guardian Takeover

**Severity: High (if guardians are compromised)**

If an attacker compromises `guardianThreshold` guardian keys, they can replace all owners:

```
T+0:00    Attacker calls initiateRecovery(newOwners=[attacker], threshold=1)
T+0:30    Compromised guardians call approveRecovery
T+24:00   Attacker calls executeRecovery — owners replaced, wallet taken over
```

The SocialRecoveryModule enforces a minimum 1-day recovery period. During this window,
owners see the `RecoveryInitiated` event and can call `cancelRecovery`.

**But**: If owners have lost all their keys (the scenario recovery is designed for),
there is no way to cancel. Guardian compromise in that situation is unrecoverable.

**Your defense**:
- Choose guardians who are independent of each other (different organizations, jurisdictions)
- Set guardian threshold high (e.g., 3-of-5 guardians, not 2-of-3)
- Use a recovery period longer than the 1-day minimum for high-value wallets
- Monitor `RecoveryInitiated` events with automated alerting
- Ensure at least one owner key is always accessible for emergency cancellation
- Never make wallet owners also be guardians — that defeats the purpose

### 4. Frontend / Indexer Deception (The Bybit Vector)

**Severity: High**

In the Feb 2025 Bybit hack ($1.4B), the Gnosis Safe contract was uncompromised. The
attack targeted the signing interface — it displayed legitimate-looking transaction data
while the actual on-chain calldata was malicious. Owners signed what they thought was
a routine transaction.

QuaiVault is equally vulnerable to this class of attack. If the frontend or indexer is
compromised, it could show "Send 1 QUAI to vendor" while the actual calldata is
`enableModule(attackerModule)`. Since this is a self-call, it executes immediately once
quorum is reached.

**The contract cannot prevent this.** It faithfully executes whatever calldata owners approve.

**Your defense**:
- **Always verify calldata on-chain** before approving — decode the raw transaction data
  using a block explorer or independent tool, not the same frontend used to propose it
- Use multiple independent frontends to cross-check transaction details
- For high-value transactions, have at least two owners independently decode and verify
  the calldata before any owner approves
- Run your own indexer instance rather than depending on a shared service
- Treat any frontend as potentially compromised — it is an input device, not a trusted authority

### 5. Threshold-1 Compromise + Social Engineering

**Severity: Medium**

An attacker has `threshold - 1` keys and needs one more honest owner to approve:

- Proposes a legitimate-looking transaction with a subtle payload difference
- Contacts the remaining owner with urgency ("we need to move funds now")
- The honest owner approves without carefully verifying calldata
- **External call**: the timelock provides a window for other owners to catch and cancel it
- **Self-call**: executes immediately — no recovery window

**Your defense**:
- Establish an out-of-band verification protocol among owners (phone call, in-person)
- Never approve under time pressure — the timelock exists precisely for this
- Set a policy: no approvals without independent calldata verification by each signer

---

## What the Contract Defends Against

These attack vectors are structurally prevented by QuaiVault's design. No operational
action is needed — the contract handles them automatically.

### Clock Gaming

`approvedAt` (the timestamp when quorum was first reached) is set exactly once and
**never cleared**. If approvals drop below threshold via revocation and later recover,
the original clock stands. This prevents the attack where a proposer colludes with one
approver to cycle revoke → cancel → re-propose → get fresh timelock indefinitely.

### Ghost Approvals After Owner Removal

When an owner is removed, `ownerVersions[owner]` is incremented. All their in-flight
approvals become instantly invalid without iterating transaction storage (O(1)). If the
same address is later re-added, old approvals remain invalid — a new approval epoch
is required. This prevents removed owners' stale approvals from being counted toward
quorum on any pending transaction.

### Head-of-Line Blocking

Transactions are identified by content hash, not sequential nonce. Any approved transaction
can execute independently — a stuck or malicious transaction does not block others. There
is no "nonce N must execute before N+1" ordering constraint.

### Expired Transaction Exploitation

Expiration is checked **before** the timelock in the execution path. An expired transaction
cannot be executed even if the timelock has elapsed and quorum is met. Anyone can call
`expireTransaction()` to formally close an expired transaction and reclaim storage.

### Proposer Cancel Abuse

`cancelTransaction` (proposer-only cancel) is permanently blocked once `approvedAt != 0`
(quorum was reached at any point). This prevents the attack where a proposer colludes with
one approver: approve → revoke → proposer cancels → re-propose with fresh timelock.
Post-approval cancellation requires full quorum consensus via `cancelByConsensus`.

### Reentrancy

`executeTransaction` is protected by OpenZeppelin's `nonReentrant` modifier. A malicious
target contract cannot re-enter the wallet during execution.

### Storage and Gas Griefing

All mappings are O(1) lookup — no unbounded iteration exists anywhere in the contract.
Hundreds of thousands of transactions, approvals, or signed messages have zero impact on
gas costs for any operation. There is no way to grief the wallet by inflating storage.

---

## Operational Security Recommendations

### Threshold Configuration

| Use Case | Recommended Setup | Rationale |
|---|---|---|
| Personal wallet | 2-of-3 owners | Lose one key, still operational |
| Team treasury | 3-of-5 owners | Majority required, tolerates 2 compromised keys |
| Protocol treasury | 4-of-7 or 5-of-9 | High bar, geographic distribution essential |
| Cold storage | 3-of-5 + timelock (24h+) | Timelock gives monitoring window for external calls |

A threshold of 1 is technically valid but provides zero multisig protection — it is
functionally equivalent to an EOA. Never use threshold=1 for any wallet holding
meaningful value.

### Timelock Configuration

`minExecutionDelay` is the vault-level floor applied to all external calls.
Individual transactions can request a longer delay but never a shorter one.

| Setting | Behavior |
|---|---|
| `minExecutionDelay = 0` | Simple quorum vault — external calls execute immediately after threshold |
| `minExecutionDelay = 300` (5 min) | Light monitoring window — catches obvious errors |
| `minExecutionDelay = 86400` (24h) | Standard security — gives owners a full day to review and cancel |
| `minExecutionDelay = 604800` (7d) | High security — maximum monitoring window, slower operations |

**Self-calls always execute immediately regardless of `minExecutionDelay`.** This is by
design — see "Key Compromise + Self-Call Bypass" above for the rationale.

To change the delay after deployment: propose a `setMinExecutionDelay(newDelay)` self-call.
Requires multisig consensus. Takes effect immediately.

### Monitoring Checklist

Set up automated alerts for these on-chain events:

| Event | Why it matters |
|---|---|
| `TransactionProposed` | Every new proposal — verify you recognize the proposer and the calldata |
| `ThresholdReached` | Quorum crossed — the timelock clock has started. Review immediately. |
| `TransactionExecuted` | Confirm expected transactions executed. Investigate unexpected ones. |
| `TransactionFailed` | External call failed — decode `returnData` for the reason. Terminal state. |
| `OwnerAdded` / `OwnerRemoved` | Ownership changed. If unexpected, assume compromise. |
| `ThresholdChanged` | Threshold changed. If unexpected, assume compromise. |
| `ModuleEnabled` / `ModuleDisabled` | Module configuration changed. Verify the module address. |
| `RecoveryInitiated` | Recovery started — if unexpected, call `cancelRecovery` immediately. |
| `MinExecutionDelayChanged` | Timelock changed. A delay reduction could weaken security. |

**The most critical alert is `RecoveryInitiated`.** You have exactly `recoveryPeriod`
seconds (minimum 24 hours) to cancel before the recovery executes and replaces all owners.

### Transaction Verification Protocol

Before approving any transaction:

1. **Read the raw calldata** — not the frontend's interpretation of it
2. **Decode the function selector** — first 4 bytes identify the function being called
3. **Verify the `to` address** — is it the expected recipient or contract?
4. **Check if it's a self-call** — `to == walletAddress` means administrative operation,
   executes immediately (no timelock)
5. **For self-calls: understand exactly what it does** — addOwner? changeThreshold?
   enableModule? These are irreversible once executed.
6. **Cross-check with at least one other owner** via out-of-band communication

### Social Recovery Best Practices

- **Guardian independence**: Guardians should not know each other, should be in different
  jurisdictions, and should have no shared infrastructure
- **Guardian threshold**: Set high enough that compromising a majority is impractical.
  For 5 guardians, require 3-of-5 or 4-of-5.
- **Recovery period**: The contract enforces a 1-day minimum. For high-value wallets,
  use 7 days or longer to give owners maximum time to detect and cancel
- **Test recovery**: Periodically verify that guardians are still accessible and that
  the recovery flow works. A recovery system that fails when needed is worse than none.
- **Separation of roles**: Wallet owners should NOT also be guardians. Guardians are
  a backup path for when owners lose access — making the same people both defeats
  the redundancy model.

---

## Security Summary

| Threat | Contract mitigates? | Your defense |
|---|---|---|
| Key compromise at threshold | Partially (timelock delays external calls) | Hardware wallets, key distribution, high threshold |
| Buggy/malicious module | Partially (`onlySelf` to enable) | Only enable audited modules, regular review |
| Guardian takeover | Partially (recovery delay period) | Independent guardians, active monitoring, owner key availability |
| Frontend/indexer deception | No | Verify calldata on-chain, multiple independent UIs |
| Social engineering | No | Out-of-band verification, no approvals under pressure |
| Clock gaming | Yes — fully prevented | None needed |
| Ghost approvals | Yes — fully prevented | None needed |
| Nonce/ordering attacks | Yes — fully prevented | None needed |
| Expired tx exploitation | Yes — fully prevented | None needed |
| Reentrancy | Yes — fully prevented | None needed |
| Storage griefing | Yes — fully prevented | None needed |

**The contract protects against everything a contract can protect against.** The remaining
attack surface is humans and infrastructure — key management, module trust, frontend integrity,
and social engineering. These are operational concerns that no smart contract can solve.
This is true for every multisig ever built, including Gnosis Safe.
