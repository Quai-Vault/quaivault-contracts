# QuaiVault Contracts

Modular multisig wallet with integrated timelock, per-transaction expiration, and
Zodiac IAvatar compatibility for Quai Network.

## Features

- **Multisig with configurable threshold** (up to 20 owners)
- **Per-transaction timelock** with vault-level floor and per-tx override
- **Transaction expiration** with on-chain validation and permissionless cleanup
- **Hash-based transactions** (unordered, no head-of-line blocking)
- **Epoch-based approval invalidation** (owner removal atomically invalidates all their approvals)
- **Option B failure handling** (external call failures are terminal, never revert)
- **Zodiac IAvatar module system** (linked list, DelegateCall support, MultiSend batching)
- **Social recovery** via guardian-based module
- **EIP-1271** contract signatures (mapping-based pre-approval)
- **ERC-721 / ERC-1155** token receivers (native, not via fallback handler)
- **ERC-165** interface detection
- **EIP-712** domain separator (computed fresh for fork safety)
- **ERC1967 constructor proxy** with own `receive()` for Quai Network compatibility

## Setup

### Install Dependencies

```bash
npm install
```

### Configure Environment

Copy `.env.example` and fill in your values:

```bash
cp .env.example .env
```

Each Quai zone requires a different private key. Configure:
- `CYPRUS1_PK`, `CYPRUS2_PK`, `CYPRUS3_PK` (Cyprus region)
- `PAXOS1_PK`, `PAXOS2_PK`, `PAXOS3_PK` (Paxos region)
- `HYDRA1_PK`, `HYDRA2_PK`, `HYDRA3_PK` (Hydra region)

## Compilation

```bash
npm run compile
```

## Testing

### Unit Tests (Hardhat, local network)

```bash
npm test            # 266 tests across 7 test files
npm run test:gas    # same tests with gas reporting
npm run test:coverage
```

### E2E Tests (Quai Network Orchard Testnet)

Requires deployed contracts, funded wallets, and `.env.e2e` configuration:

```bash
npm run deploy:cyprus1:mock   # deploy all contracts + test mocks
npm run update-env            # sync addresses to .env and .env.e2e
npm run test:e2e              # 49 on-chain tests (~47 min)
```

See `.env.e2e.example` for required configuration.

## Deployment

### Local

```bash
npx hardhat node              # start local node
npm run deploy:local          # deploy to localhost
```

### Quai Network

```bash
npm run deploy:cyprus1                 # production deploy
npm run deploy:cyprus1:mock            # deploy with test mocks (MockModule, MockERC721, MockERC1155)
npm run update-env                     # sync deployed addresses to .env files
```

### Other Zones

```bash
npx hardhat run scripts/deploy.ts --network paxos1
npx hardhat run scripts/deploy.ts --network hydra1
```

### Create a Wallet

After deployment, create a wallet instance with shard-prefix mining:

```bash
npm run create-wallet
```

This mines a CREATE2 salt that produces a wallet address matching the target shard prefix,
then deploys via the factory.

## Contract Architecture

### Core Contracts

| Contract | Purpose |
|---|---|
| **QuaiVault.sol** | Multisig implementation — transaction lifecycle, owner management, module system, token receivers, EIP-1271 |
| **QuaiVaultProxy.sol** | ERC1967 constructor proxy with own `receive()` — handles plain QUAI transfers without DELEGATECALL |
| **QuaiVaultFactory.sol** | Factory deploying QuaiVaultProxy instances via CREATE2 for deterministic shard-compatible addresses |

QuaiVaultProxy is **not an upgradeable proxy**. The ERC1967 storage slot stores the
implementation address for inspection only (`getImplementation()`). Wallets are immutable
by design — there is no upgrade path. Each wallet is a separate proxy instance pointing
to the shared QuaiVault implementation.

### Libraries

| Contract | Purpose |
|---|---|
| **MultiSend.sol** | Batched transaction execution via DelegateCall (Gnosis Safe compatible) |
| **Enum.sol** | Operation type enum (Call / DelegateCall) |

### Modules

| Contract | Purpose |
|---|---|
| **SocialRecoveryModule.sol** | Guardian-based wallet recovery with configurable threshold and recovery period |

Modules interact with QuaiVault via the Zodiac IAvatar interface (`execTransactionFromModule`).
Module enablement requires multisig consensus (self-call through the vault).

### Interfaces

| Interface | Purpose |
|---|---|
| **IAvatar.sol** | Zodiac module interface — module management and execution |
| **IOwnerManager.sol** | Owner management interface for modules (addOwner, removeOwner, changeThreshold) |

## Transaction Lifecycle

See [TRANSACTION_LIFECYCLE_DESIGN.md](TRANSACTION_LIFECYCLE_DESIGN.md) for the complete
design document covering:

- Transaction state machine (PENDING / APPROVED / EXECUTABLE / EXECUTED / CANCELLED / EXPIRED)
- Three transaction paths (simple quorum, timelocked, self-call)
- Cancellation design (pre-threshold proposer cancel, post-threshold consensus cancel)
- Expiration validation and formal cleanup
- `approvedAt` clock semantics and lazy clock start
- Epoch-based approval invalidation
- Option B failure handling
- Factory integration

## Events

QuaiVault emits 19 events covering the complete transaction lifecycle:

| Event | When |
|---|---|
| `TransactionProposed` | New transaction proposed (includes expiration and executionDelay) |
| `TransactionApproved` | Owner approves a transaction |
| `ApprovalRevoked` | Owner revokes their approval |
| `ThresholdReached` | Quorum first crossed (includes approvedAt and executableAfter) |
| `TransactionExecuted` | Transaction successfully executed |
| `TransactionFailed` | External call failed (includes returnData for error decoding) |
| `TransactionCancelled` | Transaction cancelled (pre- or post-threshold) |
| `TransactionExpired` | Expired transaction formally closed |
| `OwnerAdded` | Owner added via multisig self-call |
| `OwnerRemoved` | Owner removed via multisig self-call |
| `ThresholdChanged` | Threshold changed via multisig self-call |
| `ModuleEnabled` | Module enabled via multisig self-call |
| `ModuleDisabled` | Module disabled via multisig self-call |
| `ExecutionFromModuleSuccess` | Module executed a transaction successfully |
| `ExecutionFromModuleFailure` | Module-executed transaction failed |
| `Received` | Plain QUAI received (via proxy or fallback) |
| `MinExecutionDelayChanged` | Vault-level execution delay changed |
| `MessageSigned` | EIP-1271 message pre-approved via multisig |
| `MessageUnsigned` | EIP-1271 message approval revoked via multisig |

## Security

### Design Principles

- **Integrated security** — timelock, expiration, cancellation, and failure handling are native to the contract, not dependent on external module configuration
- **Immutable wallets** — deployed proxies cannot be upgraded (ERC1967 slot is read-only)
- **Epoch-based approvals** — owner removal atomically invalidates all their in-flight approvals without iterating transaction storage
- **Hash-based transactions** — unordered execution, no head-of-line blocking, no nonce-based attacks
- **Permanent `approvedAt` clock** — set once on first threshold crossing, never cleared (prevents clock gaming)
- **Self-call bypass** — administrative operations execute immediately, enabling rapid incident response

### Access Control

| Modifier | Purpose |
|---|---|
| `onlyOwner` | Requires `isOwner[msg.sender]` |
| `onlySelf` | Requires `msg.sender == address(this)` (multisig consensus via self-call) |
| `onlyModule` | Requires `isModuleEnabled(msg.sender)` |

### DelegateCall Warning

The Zodiac `execTransactionFromModule` function supports DelegateCall operations,
which execute code in the wallet's storage context. This is required for MultiSend
batching but means enabled modules have full storage access. **Only enable trusted,
audited modules.**

### Audit Status

Two audit rounds completed. All findings addressed:

- Round 1: Critical, High, Medium, and Low severity findings — all fixed
- Round 2: Verification of Round 1 fixes + new findings — all fixed

266 unit tests + 49 E2E on-chain tests covering all audit fixes.

## Comparison to Gnosis Safe

See [QUAIVAULT_VS_GNOSIS_SAFE.md](QUAIVAULT_VS_GNOSIS_SAFE.md) for a detailed
technical comparison covering architecture, transaction model, timelock, cancellation,
expiration, failure handling, module system, proxy pattern, and standards support.

## Available Networks

| Network | Chain ID | Purpose |
|---|---|---|
| `hardhat` | 1337 | Local testing |
| `localhost` | 1337 | Local node |
| `cyprus1` - `cyprus3` | Configured | Cyprus region |
| `paxos1` - `paxos3` | Configured | Paxos region |
| `hydra1` - `hydra3` | Configured | Hydra region |

## Solidity Version

All contracts use Solidity **0.8.22** with locked pragma and London EVM target.

## Additional Commands

```bash
npm run clean       # remove build artifacts
npm run lint        # lint Solidity files
npm run format      # format Solidity files
```

## Notes

- Deployment uses `quais.js` SDK for Quai Network compatibility
- Contract metadata is automatically uploaded to IPFS during deployment (`@quai/hardhat-deploy-metadata`)
- Deployment artifacts are saved to `deployments/deployment-{network}-{timestamp}.json`
- After deployment, run `npm run update-env` to sync addresses to `.env` and `.env.e2e`
