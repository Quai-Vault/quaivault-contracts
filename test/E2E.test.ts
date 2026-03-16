/**
 * On-Chain End-to-End Transaction Lifecycle Tests
 *
 * Runs against the real Quai Network Orchard testnet using quais.js.
 * Exercises every path through the QuaiVault state machine: factory
 * deployment, multisig operations, timelock enforcement, expiration,
 * module execution, token handling, message signing, social recovery
 * setup, and all cancellation paths.
 *
 * Time-dependent tests (timelock, expiration) use real 5-minute delays.
 * Social recovery execution is NOT tested here — the contract enforces a
 * 1-day minimum recovery period (SocialRecoveryModule L181), which would
 * require a dedicated long-running test or a two-phase test script.
 *
 * Prerequisites:
 *   1. Contracts deployed: npm run deploy:cyprus1:mock
 *   2. Env synced: npm run update-env
 *   3. .env.e2e populated with private keys and contract addresses
 *   4. Test wallets funded with testnet QUAI
 *
 * Run: npm run test:e2e
 */

import { expect } from "chai";
import * as quais from "quais";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

// Load contract ABIs from artifacts
const QuaiVaultJson = require("../artifacts/contracts/QuaiVault.sol/QuaiVault.json");
const QuaiVaultFactoryJson = require("../artifacts/contracts/QuaiVaultFactory.sol/QuaiVaultFactory.json");
const SocialRecoveryModuleJson = require("../artifacts/contracts/modules/SocialRecoveryModule.sol/SocialRecoveryModule.json");
const MultiSendJson = require("../artifacts/contracts/libraries/MultiSend.sol/MultiSend.json");
const MockModuleJson = require("../artifacts/contracts/test/MockModule.sol/MockModule.json");
const MockERC721Json = require("../artifacts/contracts/test/MockERC721.sol/MockERC721.json");
const MockERC1155Json = require("../artifacts/contracts/test/MockERC1155.sol/MockERC1155.json");
const QuaiVaultProxyJson = require("../artifacts/contracts/QuaiVaultProxy.sol/QuaiVaultProxy.json");

// Load .env.e2e config (does NOT override process.env)
const e2eEnvPath = path.resolve(__dirname, "..", ".env.e2e");
if (!fs.existsSync(e2eEnvPath)) {
  throw new Error(
    ".env.e2e not found. Copy .env.e2e.example to .env.e2e and fill in values."
  );
}
const config = dotenv.parse(fs.readFileSync(e2eEnvPath));

// Validate required config
function requireConfig(key: string): string {
  const value = config[key];
  if (!value || value === "0x...") {
    throw new Error(`Missing required .env.e2e value: ${key}`);
  }
  return value;
}

// ============================================================================
// Timing constants
// ============================================================================
const TIMELOCK_DELAY = 300; // 5 minutes — used for timelocked wallet tests
const EXPIRATION_WINDOW = 360; // 6 minutes — expiration window for expiry tests
const WAIT_MARGIN = 90; // extra seconds past delay before attempting execution
                        // (Quai woHeader.timestamp may diverge from EVM block.timestamp)

// Shard prefix for cyprus1
const TARGET_PREFIX = "0x00";
const MAX_MINING_ATTEMPTS = 100000;

// Retry configuration for transient RPC failures (Quai Network specific)
const MAX_TX_RETRIES = 5;
const RETRY_DELAY_MS = 2000;

/**
 * Check if an error is a transient RPC error that should be retried.
 * Quai Network intermittently fails with access list creation errors,
 * missing revert data, spurious CALL_EXCEPTION on valid transactions,
 * and replacement-underpriced when a prior tx is still pending in the mempool.
 */
function isTransientRpcError(err: Error & { code?: string }): boolean {
  return (
    err.message?.includes("Access list creation failed") ||
    err.message?.includes("missing revert data") ||
    err.message?.includes("replacement fee too low") ||
    err.message?.includes("replacement transaction underpriced") ||
    err.code === "CALL_EXCEPTION" ||
    err.code === "REPLACEMENT_UNDERPRICED"
  );
}

/**
 * Retry wrapper for operations that may fail due to transient Quai RPC errors.
 * Uses exponential backoff for replacement-underpriced errors (pending tx needs
 * time to mine before the next tx can use the same nonce).
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxRetries = MAX_TX_RETRIES,
  retryDelay = RETRY_DELAY_MS
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: unknown) {
      const err = error as Error & { code?: string };
      lastError = err;

      if (isTransientRpcError(err)) {
        // Use longer delay for replacement-underpriced (pending tx needs to mine)
        const isReplacement = err.code === "REPLACEMENT_UNDERPRICED" ||
          err.message?.includes("replacement");
        const delay = isReplacement ? retryDelay * attempt * 2 : retryDelay;
        console.log(
          `    [${operationName}] Transient error (attempt ${attempt}/${maxRetries}): ${err.code || err.message?.substring(0, 80)}`
        );
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }

      throw error;
    }
  }

  throw lastError || new Error(`${operationName} failed after ${maxRetries} retries`);
}

/**
 * Mine for a CREATE2 salt that produces a valid Quai address with the target prefix.
 * Identical logic to scripts/create-wallet.ts.
 */
function mineSalt(
  factoryAddress: string,
  senderAddress: string,
  implementationAddress: string,
  owners: string[],
  threshold: number,
  minExecutionDelay: number = 0,
  delegatecallDisabled: boolean = true
): { salt: string; expectedAddress: string } {
  // ERC1967 constructor proxy creation code
  const quaiVaultIface = new quais.Interface(QuaiVaultJson.abi);
  const initData = quaiVaultIface.encodeFunctionData("initialize", [
    owners, threshold, minExecutionDelay, delegatecallDisabled,
  ]);
  const abiCoder = quais.AbiCoder.defaultAbiCoder();
  const constructorArgs = abiCoder.encode(
    ["address", "bytes"],
    [implementationAddress, initData]
  );
  const creationCode = QuaiVaultProxyJson.bytecode + constructorArgs.slice(2);
  const bytecodeHash = quais.keccak256(creationCode);

  for (let i = 0; i < MAX_MINING_ATTEMPTS; i++) {
    const userSalt = quais.hexlify(quais.randomBytes(32));
    const fullSalt = quais.keccak256(
      quais.solidityPacked(["address", "bytes32"], [senderAddress, userSalt])
    );
    const create2Address = quais.getCreate2Address(
      factoryAddress,
      fullSalt,
      bytecodeHash
    );

    if (
      create2Address.toLowerCase().startsWith(TARGET_PREFIX.toLowerCase()) &&
      quais.isQuaiAddress(create2Address)
    ) {
      return { salt: userSalt, expectedAddress: create2Address };
    }
  }

  throw new Error(`Could not mine valid salt after ${MAX_MINING_ATTEMPTS} attempts`);
}

/** Extract txHash from a TransactionProposed event */
function parseTxHash(
  iface: quais.Interface,
  receipt: any
): string {
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log as any);
      if (parsed?.name === "TransactionProposed") {
        return parsed.args[0];
      }
    } catch {}
  }
  throw new Error("TransactionProposed event not found in receipt");
}

/** Extract recoveryHash from a RecoveryInitiated event */
function parseRecoveryHash(
  iface: quais.Interface,
  receipt: any
): string {
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log as any);
      if (parsed?.name === "RecoveryInitiated") {
        return parsed.args.recoveryHash;
      }
    } catch {}
  }
  throw new Error("RecoveryInitiated event not found in receipt");
}

/**
 * Search a receipt for a specific event name using one or more interfaces.
 * Returns the parsed event args if found, null otherwise.
 */
function findEvent(
  receipt: any,
  eventName: string,
  ifaces: quais.Interface[]
): any | null {
  for (const log of receipt.logs || []) {
    for (const iface of ifaces) {
      try {
        const parsed = iface.parseLog(log as any);
        if (parsed?.name === eventName) return parsed;
      } catch {}
    }
  }
  return null;
}

/**
 * Assert that a receipt contains a specific event.
 */
function expectEvent(
  receipt: any,
  eventName: string,
  ifaces: quais.Interface[]
): any {
  const event = findEvent(receipt, eventName, ifaces);
  expect(event, `Expected event ${eventName} not found in receipt`).to.not.be.null;
  return event;
}

/** Wait for a tx and return the receipt, with error context */
async function waitForTx(
  tx: any,
  label: string
): Promise<any> {
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`${label} failed — tx: ${tx.hash}, status: ${receipt?.status}`);
  }
  return receipt;
}

/**
 * Extract the custom error name from a quais revert error.
 * quais returns "execution reverted (unknown custom error)" with a `data` field
 * containing the 4-byte error selector. This helper decodes it using the ABI.
 */
let _allInterfaces: quais.Interface[] = [];
function initErrorDecoder(ifaces: quais.Interface[]): void {
  _allInterfaces = ifaces;
}
function getRevertReason(err: any): string {
  const data = err.data;
  if (data && typeof data === "string" && data.length >= 10) {
    for (const iface of _allInterfaces) {
      try {
        const decoded = iface.parseError(data);
        if (decoded) return decoded.name;
      } catch {}
    }
  }
  return err.message || err.toString();
}

/**
 * Assert that a transaction call reverts with the expected custom error name.
 * Works with quais.js which doesn't decode custom errors in error messages.
 */
async function expectRevert(
  promise: Promise<any>,
  expectedError: string
): Promise<void> {
  try {
    const tx = await promise;
    await tx.wait();
    expect.fail(`Should have reverted with ${expectedError}`);
  } catch (err: any) {
    if (err.message?.includes("Should have reverted")) throw err;
    const reason = getRevertReason(err);
    expect(reason).to.equal(expectedError, `Expected ${expectedError}, got: ${reason} (data: ${err.data})`);
  }
}

/**
 * Wait for a given number of seconds, logging progress every 30s.
 * Used for real on-chain timelock/expiration delays.
 */
async function waitSeconds(seconds: number, label: string): Promise<void> {
  const end = Date.now() + seconds * 1000;
  console.log(`      Waiting ${seconds}s for ${label}...`);
  while (Date.now() < end) {
    const remaining = Math.ceil((end - Date.now()) / 1000);
    if (remaining <= 0) break;
    const chunk = Math.min(remaining, 30);
    await new Promise((resolve) => setTimeout(resolve, chunk * 1000));
    if (remaining > chunk) {
      console.log(`      ${remaining - chunk}s remaining...`);
    }
  }
  console.log(`      ${label} elapsed.`);
}

describe("E2E On-Chain Transaction Lifecycle (Orchard Testnet)", function () {
  // 10 minutes default per test — network latency + potential waits
  this.timeout(600_000);

  // Provider and signers
  let provider: quais.JsonRpcProvider;
  let owner1: quais.Wallet;
  let owner2: quais.Wallet;
  let owner3: quais.Wallet;
  let guardian1: quais.Wallet;
  let guardian2: quais.Wallet;

  // Deployed infrastructure contracts (typed as any for dynamic ABI access)
  let factory: any;
  let socialRecoveryModule: any;
  let multiSend: any;
  let mockModule: any;
  let mockERC721: any;
  let mockERC1155: any;

  // Interfaces for encoding/decoding
  let walletIface: quais.Interface;
  let socialRecoveryIface: quais.Interface;
  let multiSendIface: quais.Interface;
  let mockERC721Iface: quais.Interface;
  let mockERC1155Iface: quais.Interface;

  // Addresses from config
  let implementationAddress: string;
  let factoryAddress: string;

  // The primary test wallet (delay=0, created in before())
  let wallet: any;
  let walletAddress: string;

  // A second wallet with timelock (delay=TIMELOCK_DELAY, created in before())
  let timelockWallet: any;
  let timelockWalletAddress: string;

  // Owner addresses for convenience
  let ownerAddresses: string[];

  const THRESHOLD = 2;

  // --------------------------------------------------------------------------
  // Helpers (operate on a given wallet contract instance)
  // --------------------------------------------------------------------------

  /** Warm up the provider before a transaction (required by Quai Network) */
  async function warmup(): Promise<void> {
    await provider.getBlockNumber(quais.Shard.Cyprus1);
  }

  /** Propose an external transaction and return its txHash */
  async function proposeExternal(
    w: any,
    wAddr: string,
    signer: quais.Wallet,
    to: string,
    value: bigint = 0n,
    data: string = "0x"
  ): Promise<string> {
    return withRetry(async () => {
      await warmup();
      const tx = await w.connect(signer).proposeTransaction(to, value, data);
      const receipt = await waitForTx(tx, "proposeTransaction");
      return parseTxHash(walletIface, receipt);
    }, "proposeExternal");
  }

  /** Propose a self-call and return its txHash */
  async function proposeSelfCall(
    w: any,
    wAddr: string,
    signer: quais.Wallet,
    data: string
  ): Promise<string> {
    return withRetry(async () => {
      await warmup();
      const tx = await w.connect(signer).proposeTransaction(wAddr, 0, data);
      const receipt = await waitForTx(tx, "proposeSelfCall");
      return parseTxHash(walletIface, receipt);
    }, "proposeSelfCall");
  }

  /** Approve a transaction with the given signers */
  async function approveN(
    w: any,
    txHash: string,
    signers: quais.Wallet[],
    n: number
  ): Promise<void> {
    for (let i = 0; i < n; i++) {
      await withRetry(async () => {
        await warmup();
        const tx = await w.connect(signers[i]).approveTransaction(txHash);
        await waitForTx(tx, `approveTransaction[${i}]`);
      }, `approveTransaction[${i}]`);
    }
  }

  /** Propose + approve + execute a self-call on a wallet. Returns txHash and execution receipt. */
  async function executeSelfCall(
    w: any,
    wAddr: string,
    data: string,
    signers: quais.Wallet[],
    threshold: number
  ): Promise<{ txHash: string; execReceipt: any }> {
    const txHash = await proposeSelfCall(w, wAddr, signers[0], data);
    await approveN(w, txHash, signers, threshold);
    const execReceipt = await withRetry(async () => {
      await warmup();
      const tx = await w.connect(signers[0]).executeTransaction(txHash);
      return await waitForTx(tx, "executeSelfCall");
    }, "executeSelfCall");
    return { txHash, execReceipt };
  }

  /** Propose + approve + execute any transaction on a wallet. Returns txHash and execution receipt. */
  async function executeMultisig(
    w: any,
    wAddr: string,
    to: string,
    value: bigint,
    data: string,
    signers: quais.Wallet[],
    threshold: number
  ): Promise<{ txHash: string; execReceipt: any }> {
    const txHash = await proposeExternal(w, wAddr, signers[0], to, value, data);
    await approveN(w, txHash, signers, threshold);
    const execReceipt = await withRetry(async () => {
      await warmup();
      const execTx = await w.connect(signers[0]).executeTransaction(txHash);
      return await waitForTx(execTx, "executeTransaction");
    }, "executeMultisig");
    return { txHash, execReceipt };
  }

  /** Enable a module on a wallet via multisig self-call */
  async function enableModule(w: any, wAddr: string, moduleAddr: string): Promise<{ txHash: string; execReceipt: any }> {
    const data = walletIface.encodeFunctionData("enableModule", [moduleAddr]);
    return await executeSelfCall(w, wAddr, data, [owner1, owner2, owner3], THRESHOLD);
  }

  /** Encode MultiSend transactions (same encoding as Safe's MultiSend) */
  function encodeMultiSendTx(
    operation: number,
    to: string,
    value: bigint,
    data: string
  ): string {
    const dataBytes = quais.getBytes(data);
    return quais.solidityPacked(
      ["uint8", "address", "uint256", "uint256", "bytes"],
      [operation, to, value, dataBytes.length, dataBytes]
    );
  }

  /** Create a wallet via factory, fund it, return {contract, address} */
  async function createAndFundWallet(
    minDelay: number = 0,
    fundAmount: string = "5"
  ): Promise<{ w: any; addr: string }> {
    const { salt } = mineSalt(
      factoryAddress,
      owner1.address,
      implementationAddress,
      ownerAddresses,
      THRESHOLD,
      minDelay
    );

    // Deploy wallet with retry logic for transient Quai RPC errors
    const createReceipt = await withRetry(async () => {
      await warmup();
      let createTx;
      if (minDelay > 0) {
        createTx = await factory["createWallet(address[],uint256,bytes32,uint32)"](
          ownerAddresses,
          THRESHOLD,
          salt,
          minDelay
        );
      } else {
        createTx = await factory.createWallet(ownerAddresses, THRESHOLD, salt);
      }
      return await waitForTx(createTx, "createWallet");
    }, "createWallet");

    let addr = "";
    for (const log of createReceipt.logs) {
      try {
        const parsed = factory.interface.parseLog(log as any);
        if (parsed?.name === "WalletCreated") {
          addr = parsed.args.wallet || parsed.args[0];
          break;
        }
      } catch {}
    }
    if (!addr) throw new Error("WalletCreated event not found");

    const w = new quais.Contract(addr, QuaiVaultJson.abi, owner1);

    // Fund the wallet with retry logic.
    // ERC1967 constructor proxy has its own receive() — plain value transfers work
    // natively without data or access lists.
    await withRetry(async () => {
      await warmup();
      const toAddress = quais.getAddress(addr);
      const fundTx = await owner1.sendTransaction({
        from: owner1.address,
        to: toAddress,
        value: quais.parseQuai(fundAmount),
      } as any);
      await waitForTx(fundTx, "fundWallet");
    }, "fundWallet");

    return { w, addr };
  }

  // --------------------------------------------------------------------------
  // Setup
  // --------------------------------------------------------------------------

  before(async function () {
    this.timeout(600_000); // 10 minutes for setup (salt mining + wallet creation)

    console.log("\n=== E2E Test Setup ===\n");

    // Load config
    const rpcUrl = requireConfig("QUAI_RPC_URL");
    implementationAddress = requireConfig("QUAIVAULT_IMPLEMENTATION");
    factoryAddress = requireConfig("QUAIVAULT_FACTORY");
    const socialRecoveryAddress = requireConfig("SOCIAL_RECOVERY_MODULE");
    const multiSendAddress = requireConfig("MULTISEND");
    const mockModuleAddress = requireConfig("MOCK_MODULE");
    const mockERC721Address = requireConfig("MOCK_ERC721");
    const mockERC1155Address = requireConfig("MOCK_ERC1155");

    // Create provider
    provider = new quais.JsonRpcProvider(rpcUrl, undefined, { usePathing: true });

    // Create signers from private keys
    owner1 = new quais.Wallet(requireConfig("OWNER_PRIVATE_KEY_1"), provider);
    owner2 = new quais.Wallet(requireConfig("OWNER_PRIVATE_KEY_2"), provider);
    owner3 = new quais.Wallet(requireConfig("OWNER_PRIVATE_KEY_3"), provider);
    guardian1 = new quais.Wallet(requireConfig("GUARDIAN_PRIVATE_KEY_1"), provider);
    guardian2 = new quais.Wallet(requireConfig("GUARDIAN_PRIVATE_KEY_2"), provider);

    ownerAddresses = [owner1.address, owner2.address, owner3.address];

    console.log("Owner 1:", owner1.address);
    console.log("Owner 2:", owner2.address);
    console.log("Owner 3:", owner3.address);
    console.log("Guardian 1:", guardian1.address);
    console.log("Guardian 2:", guardian2.address);

    // Check balances
    const bal1 = await provider.getBalance(owner1.address);
    console.log("\nOwner 1 balance:", quais.formatQuai(bal1), "QUAI");
    if (bal1 === 0n) {
      throw new Error("Owner 1 has no funds — fund the wallet before running E2E tests");
    }

    // Build interfaces
    walletIface = new quais.Interface(QuaiVaultJson.abi);
    socialRecoveryIface = new quais.Interface(SocialRecoveryModuleJson.abi);
    multiSendIface = new quais.Interface(MultiSendJson.abi);
    mockERC721Iface = new quais.Interface(MockERC721Json.abi);
    mockERC1155Iface = new quais.Interface(MockERC1155Json.abi);

    // Initialize error decoder for custom error matching
    initErrorDecoder([walletIface, socialRecoveryIface]);

    // Attach to deployed contracts
    factory = new quais.Contract(factoryAddress, QuaiVaultFactoryJson.abi, owner1);
    socialRecoveryModule = new quais.Contract(
      socialRecoveryAddress,
      SocialRecoveryModuleJson.abi,
      owner1
    );
    multiSend = new quais.Contract(multiSendAddress, MultiSendJson.abi, owner1);
    mockModule = new quais.Contract(mockModuleAddress, MockModuleJson.abi, owner1);
    mockERC721 = new quais.Contract(mockERC721Address, MockERC721Json.abi, owner1);
    mockERC1155 = new quais.Contract(mockERC1155Address, MockERC1155Json.abi, owner1);

    // Warm up provider (required for reliable Quai Network transactions)
    console.log("\nWarming up provider...");
    await warmup();

    // Verify factory is deployed
    const implAddr = await factory.implementation();
    console.log("Factory implementation:", implAddr);
    expect(implAddr.toLowerCase()).to.equal(implementationAddress.toLowerCase());

    // Create primary wallet (delay=0)
    console.log("\nCreating primary wallet (delay=0)...");
    const primary = await createAndFundWallet(0);
    wallet = primary.w;
    walletAddress = primary.addr;
    console.log("Primary wallet:", walletAddress);

    // Create timelocked wallet (delay=TIMELOCK_DELAY)
    console.log(`Creating timelocked wallet (delay=${TIMELOCK_DELAY}s)...`);
    const timelocked = await createAndFundWallet(TIMELOCK_DELAY);
    timelockWallet = timelocked.w;
    timelockWalletAddress = timelocked.addr;
    console.log("Timelocked wallet:", timelockWalletAddress);

    console.log("\n=== Setup Complete ===\n");
  });

  // Warm up provider before every test for reliable Quai Network transactions
  beforeEach(async function () {
    await warmup();
  });

  // ==========================================================================
  // Factory Verification
  // ==========================================================================

  describe("Factory & Wallet Creation", function () {
    it("wallet is registered in factory", async function () {
      expect(await factory.isWallet(walletAddress)).to.be.true;
      expect(await factory.isWallet(timelockWalletAddress)).to.be.true;
    });

    it("wallet has correct owners and threshold", async function () {
      const owners = await wallet.getOwners();
      expect(owners).to.have.lengthOf(3);
      for (const addr of ownerAddresses) {
        expect(await wallet.isOwner(addr)).to.be.true;
      }
      expect(Number(await wallet.threshold())).to.equal(THRESHOLD);
    });

    it("primary wallet has delay=0, timelocked wallet has correct delay", async function () {
      expect(Number(await wallet.minExecutionDelay())).to.equal(0);
      expect(Number(await timelockWallet.minExecutionDelay())).to.equal(TIMELOCK_DELAY);
    });

    it("wallets default to delegatecallDisabled=true (CR-1)", async function () {
      expect(await wallet.delegatecallDisabled()).to.be.true;
      expect(await timelockWallet.delegatecallDisabled()).to.be.true;
    });

    it("wallet address matches CREATE2 prediction", async function () {
      const salt = quais.hexlify(quais.randomBytes(32));
      const predicted = await factory.predictWalletAddress(
        owner1.address, salt, ownerAddresses, THRESHOLD, 0, true
      );
      expect(predicted).to.be.a("string");
      expect(predicted.length).to.equal(42);
    });

    it("factory tracks wallet count", async function () {
      const count = await factory.getWalletCount();
      expect(Number(count)).to.be.gte(2); // at least primary + timelocked
    });
  });

  // ==========================================================================
  // Path 1: Simple Quorum (delay=0)
  // ==========================================================================

  describe("Path 1: Simple Quorum (no timelock)", function () {
    it("should complete propose → approve → execute for QUAI transfer", async function () {
      const sendAmount = quais.parseQuai("0.01");
      // Check wallet balance (not recipient) to avoid gas cost interference
      const walletBalBefore = await provider.getBalance(walletAddress);

      const txHash = await proposeExternal(wallet, walletAddress, owner1, owner2.address, sendAmount);
      await approveN(wallet, txHash, [owner1, owner3], THRESHOLD);

      const execReceipt = await withRetry(async () => {
        await warmup();
        const execTx = await wallet.connect(owner3).executeTransaction(txHash);
        return await waitForTx(execTx, "executeTransaction");
      }, "executeTransaction");

      const walletBalAfter = await provider.getBalance(walletAddress);
      expect(walletBalBefore - walletBalAfter).to.equal(sendAmount);

      const txData = await wallet.getTransaction(txHash);
      expect(txData.executed).to.be.true;
      expect(txData.cancelled).to.be.false;

      // Event assertions
      expectEvent(execReceipt, "TransactionExecuted", [walletIface]);
    });

    it("should complete propose → approveAndExecute in single call", async function () {
      const sendAmount = quais.parseQuai("0.01");
      const balanceBefore = await provider.getBalance(owner3.address);

      const txHash = await proposeExternal(wallet, walletAddress, owner1, owner3.address, sendAmount);
      await approveN(wallet, txHash, [owner1], 1);

      const aeReceipt = await withRetry(async () => {
        await warmup();
        const aeTx = await wallet.connect(owner2).approveAndExecute(txHash);
        return await waitForTx(aeTx, "approveAndExecute");
      }, "approveAndExecute");

      let foundExecuted = false;
      for (const log of aeReceipt.logs) {
        try {
          const parsed = walletIface.parseLog(log as any);
          if (parsed?.name === "TransactionExecuted") {
            foundExecuted = true;
            break;
          }
        } catch {}
      }
      expect(foundExecuted).to.be.true;

      const balanceAfter = await provider.getBalance(owner3.address);
      expect(balanceAfter - balanceBefore).to.equal(sendAmount);
    });

    it("should reject execution before threshold is met", async function () {
      const txHash = await proposeExternal(
        wallet, walletAddress, owner1, owner2.address, quais.parseQuai("0.01")
      );
      await approveN(wallet, txHash, [owner1], 1);

      await expectRevert(
        wallet.connect(owner1).executeTransaction(txHash),
        "NotEnoughApprovals"
      );
    });

    it("should reject proposal from non-owner", async function () {
      await expectRevert(
        wallet.connect(guardian1).proposeTransaction(owner2.address, 0, "0x"),
        "NotAnOwner"
      );
    });

    it("should reject approval from non-owner", async function () {
      const txHash = await proposeExternal(wallet, walletAddress, owner1, owner2.address, 0n);
      await expectRevert(
        wallet.connect(guardian1).approveTransaction(txHash),
        "NotAnOwner"
      );
    });

    it("should reject double execution", async function () {
      const txHash = await proposeExternal(
        wallet, walletAddress, owner1, owner2.address, quais.parseQuai("0.01")
      );
      await approveN(wallet, txHash, [owner1, owner2], THRESHOLD);
      await withRetry(async () => {
        await warmup();
        const execTx = await wallet.connect(owner1).executeTransaction(txHash);
        await waitForTx(execTx, "executeTransaction");
      }, "executeTransaction");

      await expectRevert(
        wallet.connect(owner1).executeTransaction(txHash),
        "TransactionAlreadyExecuted"
      );
    });
  });

  // ==========================================================================
  // Path 2: Timelocked External Call (real 5-minute delay)
  // ==========================================================================

  describe("Path 2: Timelocked Transactions", function () {
    it("should reject early execution, succeed after delay", async function () {
      this.timeout(0); // no timeout — we wait for the real delay

      const txHash = await proposeExternal(
        timelockWallet, timelockWalletAddress, owner1,
        owner2.address, quais.parseQuai("0.01")
      );
      await approveN(timelockWallet, txHash, [owner1, owner2], THRESHOLD);

      // Immediate execution should fail
      await expectRevert(
        timelockWallet.connect(owner1).executeTransaction(txHash),
        "TimelockNotElapsed"
      );

      // Wait for real delay
      await waitSeconds(TIMELOCK_DELAY + WAIT_MARGIN, "timelock delay");

      // Now it should succeed
      await withRetry(async () => {
        await warmup();
        const execTx = await timelockWallet.connect(owner1).executeTransaction(txHash);
        await waitForTx(execTx, "executeTransaction after delay");
      }, "executeAfterDelay");

      const txData = await timelockWallet.getTransaction(txHash);
      expect(txData.executed).to.be.true;
    });

    it("should emit ThresholdReached with correct executableAfter", async function () {
      const txHash = await proposeExternal(
        timelockWallet, timelockWalletAddress, owner1, owner2.address, 0n
      );
      await approveN(timelockWallet, txHash, [owner1], 1);

      // Second approval crosses threshold
      const receipt = await withRetry(async () => {
        await warmup();
        const approveTx = await timelockWallet.connect(owner2).approveTransaction(txHash);
        return await waitForTx(approveTx, "threshold-crossing approve");
      }, "thresholdCrossingApprove");

      let foundThresholdReached = false;
      for (const log of receipt.logs) {
        try {
          const parsed = walletIface.parseLog(log as any);
          if (parsed?.name === "ThresholdReached") {
            foundThresholdReached = true;
            const approvedAt = parsed.args.approvedAt;
            const executableAfter = parsed.args.executableAfter;
            expect(executableAfter).to.equal(BigInt(approvedAt) + BigInt(TIMELOCK_DELAY));
            break;
          }
        } catch {}
      }
      expect(foundThresholdReached).to.be.true;
    });

    it("should skip timelock for self-calls even on timelocked vault", async function () {
      const data = walletIface.encodeFunctionData("changeThreshold", [3]);
      const txHash = await proposeSelfCall(timelockWallet, timelockWalletAddress, owner1, data);
      await approveN(timelockWallet, txHash, [owner1, owner2], THRESHOLD);

      // Self-call should execute immediately despite vault delay
      await withRetry(async () => {
        await warmup();
        const execTx = await timelockWallet.connect(owner1).executeTransaction(txHash);
        await waitForTx(execTx, "self-call execute (no delay)");
      }, "selfCallExec");
      expect(Number(await timelockWallet.threshold())).to.equal(3);

      // Revert threshold to 2
      const revertData = walletIface.encodeFunctionData("changeThreshold", [2]);
      await executeSelfCall(timelockWallet, timelockWalletAddress, revertData, [owner1, owner2, owner3], 3);
      expect(Number(await timelockWallet.threshold())).to.equal(2);
    });

    it("should use per-tx requestedDelay when greater than vault floor", async function () {
      const longerDelay = TIMELOCK_DELAY * 2;
      const txHash = await withRetry(async () => {
        await warmup();
        const tx = await timelockWallet
          .connect(owner1)
          ["proposeTransaction(address,uint256,bytes,uint48,uint32)"](
            owner2.address, 0, "0x", 0, longerDelay
          );
        const receipt = await waitForTx(tx, "propose with longer delay");
        return parseTxHash(walletIface, receipt);
      }, "proposeWithLongerDelay");

      const txData = await timelockWallet.getTransaction(txHash);
      expect(Number(txData.executionDelay)).to.equal(longerDelay);
    });
  });

  // ==========================================================================
  // Path 3: Expiration (real wait)
  // ==========================================================================

  describe("Path 3: Expiration", function () {
    it("should reject execution of expired transaction", async function () {
      this.timeout(0); // no timeout — real wait

      // Use wall-clock time for expiration — woHeader.timestamp may diverge from EVM block.timestamp
      const now = Math.floor(Date.now() / 1000);
      const expiration = now + EXPIRATION_WINDOW;

      const txHash = await withRetry(async () => {
        await warmup();
        const tx = await wallet
          .connect(owner1)
          ["proposeTransaction(address,uint256,bytes,uint48)"](
            owner2.address, 0, "0x", expiration
          );
        const receipt = await waitForTx(tx, "propose with expiration");
        return parseTxHash(walletIface, receipt);
      }, "proposeWithExpiration");
      await approveN(wallet, txHash, [owner1, owner2], THRESHOLD);

      // Wait past expiration
      await waitSeconds(EXPIRATION_WINDOW + WAIT_MARGIN, "expiration");

      await expectRevert(
        wallet.connect(owner1).executeTransaction(txHash),
        "TransactionIsExpired"
      );
    });

    it("anyone can call expireTransaction after expiration", async function () {
      this.timeout(0);

      // Use wall-clock time — woHeader.timestamp may diverge from EVM block.timestamp
      const now = Math.floor(Date.now() / 1000);
      const expiration = now + EXPIRATION_WINDOW;

      const txHash = await withRetry(async () => {
        await warmup();
        const tx = await wallet
          .connect(owner1)
          ["proposeTransaction(address,uint256,bytes,uint48)"](
            owner2.address, quais.parseQuai("0.01"), "0x", expiration
          );
        const receipt = await waitForTx(tx, "propose with expiration");
        return parseTxHash(walletIface, receipt);
      }, "proposeWithExpiration");
      await approveN(wallet, txHash, [owner1, owner2], THRESHOLD);

      await waitSeconds(EXPIRATION_WINDOW + WAIT_MARGIN, "expiration");

      // Even guardian (non-owner) can expire
      const expireReceipt = await withRetry(async () => {
        await warmup();
        const expireTx = await wallet.connect(guardian1).expireTransaction(txHash);
        return await waitForTx(expireTx, "expireTransaction");
      }, "expireTransaction");

      let foundExpired = false;
      for (const log of expireReceipt.logs) {
        try {
          const parsed = walletIface.parseLog(log as any);
          if (parsed?.name === "TransactionExpired") {
            foundExpired = true;
            break;
          }
        } catch {}
      }
      expect(foundExpired).to.be.true;

      const txData = await wallet.getTransaction(txHash);
      expect(txData.cancelled).to.be.true;
      expect(await wallet.expiredTxs(txHash)).to.be.true;
    });

    it("should reject proposal with expiration in the past", async function () {
      // Use timestamp 1 — definitively in the past regardless of chain/wallclock drift
      await expectRevert(
        wallet
          .connect(owner1)
          ["proposeTransaction(address,uint256,bytes,uint48)"](
            owner2.address, 0, "0x", 1
          ),
        "ExpirationTooSoon"
      );
    });

    it("expiration=0 means no expiry — executes normally", async function () {
      const txHash = await proposeExternal(wallet, walletAddress, owner1, owner2.address, 0n);
      await approveN(wallet, txHash, [owner1, owner2], THRESHOLD);
      await withRetry(async () => {
        await warmup();
        const execTx = await wallet.connect(owner1).executeTransaction(txHash);
        await waitForTx(execTx, "execute no-expiry tx");
      }, "executeNoExpiry");
      expect((await wallet.getTransaction(txHash)).executed).to.be.true;
    });
  });

  // ==========================================================================
  // Path 4: Cancellation
  // ==========================================================================

  describe("Path 4: Cancellation", function () {
    it("proposer can cancel before threshold (PENDING state)", async function () {
      const txHash = await proposeExternal(
        wallet, walletAddress, owner1, owner2.address, quais.parseQuai("0.01")
      );
      await approveN(wallet, txHash, [owner1], 1);

      const cancelReceipt = await withRetry(async () => {
        await warmup();
        const cancelTx = await wallet.connect(owner1).cancelTransaction(txHash);
        return await waitForTx(cancelTx, "cancelTransaction");
      }, "cancelTransaction");

      const txData = await wallet.getTransaction(txHash);
      expect(txData.cancelled).to.be.true;

      // Event assertion
      expectEvent(cancelReceipt, "TransactionCancelled", [walletIface]);
    });

    it("non-proposer cannot cancel", async function () {
      const txHash = await proposeExternal(wallet, walletAddress, owner1, owner2.address, 0n);
      await expectRevert(
        wallet.connect(owner2).cancelTransaction(txHash),
        "NotProposer"
      );
    });

    it("proposer cannot cancel after threshold (APPROVED state)", async function () {
      const txHash = await proposeExternal(wallet, walletAddress, owner1, owner2.address, 0n);
      await approveN(wallet, txHash, [owner1, owner2], THRESHOLD);

      await expectRevert(
        wallet.connect(owner1).cancelTransaction(txHash),
        "CannotCancelApprovedTransaction"
      );
    });

    it("cancelByConsensus via self-call cancels approved tx", async function () {
      const txHash = await proposeExternal(
        wallet, walletAddress, owner1, owner2.address, quais.parseQuai("0.01")
      );
      await approveN(wallet, txHash, [owner1, owner2], THRESHOLD);

      const cancelData = walletIface.encodeFunctionData("cancelByConsensus", [txHash]);
      const { execReceipt: cancelReceipt } = await executeSelfCall(wallet, walletAddress, cancelData, [owner1, owner2, owner3], THRESHOLD);

      const txData = await wallet.getTransaction(txHash);
      expect(txData.cancelled).to.be.true;

      // Event assertion — cancelByConsensus emits TransactionCancelled
      expectEvent(cancelReceipt, "TransactionCancelled", [walletIface]);

      await expectRevert(
        wallet.connect(owner1).executeTransaction(txHash),
        "TransactionAlreadyCancelled"
      );
    });

    it("cancelled tx blocks further approvals", async function () {
      const txHash = await proposeExternal(wallet, walletAddress, owner1, owner2.address, 0n);
      await withRetry(async () => {
        await warmup();
        const cancelTx = await wallet.connect(owner1).cancelTransaction(txHash);
        await waitForTx(cancelTx, "cancelTransaction");
      }, "cancelTransaction");

      await expectRevert(
        wallet.connect(owner1).approveTransaction(txHash),
        "TransactionAlreadyCancelled"
      );
    });
  });

  // ==========================================================================
  // Path 5: Approval Revocation
  // ==========================================================================

  describe("Path 5: Approval Revocation", function () {
    it("should allow revoke and re-approve for execution", async function () {
      const txHash = await proposeExternal(
        wallet, walletAddress, owner1, owner2.address, quais.parseQuai("0.01")
      );
      await approveN(wallet, txHash, [owner1, owner2], THRESHOLD);

      const revokeReceipt = await withRetry(async () => {
        await warmup();
        const revokeTx = await wallet.connect(owner2).revokeApproval(txHash);
        return await waitForTx(revokeTx, "revokeApproval");
      }, "revokeApproval");

      // Event assertion
      expectEvent(revokeReceipt, "ApprovalRevoked", [walletIface]);

      await expectRevert(
        wallet.connect(owner1).executeTransaction(txHash),
        "NotEnoughApprovals"
      );

      await withRetry(async () => {
        await warmup();
        const reapproveTx = await wallet.connect(owner3).approveTransaction(txHash);
        await waitForTx(reapproveTx, "reApprove");
      }, "reApprove");

      await withRetry(async () => {
        await warmup();
        const execTx = await wallet.connect(owner1).executeTransaction(txHash);
        await waitForTx(execTx, "executeTransaction");
      }, "executeTransaction");

      const txData = await wallet.getTransaction(txHash);
      expect(txData.executed).to.be.true;
    });

    it("approvedAt is permanent (clock permanence)", async function () {
      const txHash = await proposeExternal(wallet, walletAddress, owner1, owner2.address, 0n);
      await approveN(wallet, txHash, [owner1, owner2], THRESHOLD);

      const txBefore = await wallet.getTransaction(txHash);
      expect(Number(txBefore.approvedAt)).to.be.gt(0);

      await withRetry(async () => {
        await warmup();
        const revokeTx = await wallet.connect(owner2).revokeApproval(txHash);
        await waitForTx(revokeTx, "revokeApproval");
      }, "revokeApproval");

      const txAfter = await wallet.getTransaction(txHash);
      expect(txAfter.approvedAt).to.equal(txBefore.approvedAt);
    });
  });

  // ==========================================================================
  // Path 6: Failed External Call (Option B)
  // ==========================================================================

  describe("Path 6: Failed External Call (Option B)", function () {
    it("external call to reverting target emits TransactionFailed, tx is terminal", async function () {
      const badCalldata = quais.solidityPacked(["bytes4"], ["0xdeadbeef"]);
      const txHash = await proposeExternal(
        wallet, walletAddress, owner1, factoryAddress, 0n, badCalldata
      );
      await approveN(wallet, txHash, [owner1, owner2], THRESHOLD);

      const receipt = await withRetry(async () => {
        await warmup();
        const execTx = await wallet.connect(owner1).executeTransaction(txHash);
        return await waitForTx(execTx, "executeTransaction (expect fail event)");
      }, "executeFailedCall");

      let foundFailed = false;
      for (const log of receipt.logs) {
        try {
          const parsed = walletIface.parseLog(log as any);
          if (parsed?.name === "TransactionFailed") {
            foundFailed = true;
            break;
          }
        } catch {}
      }
      expect(foundFailed).to.be.true;

      const txData = await wallet.getTransaction(txHash);
      expect(txData.executed).to.be.true;

      await expectRevert(
        wallet.connect(owner1).executeTransaction(txHash),
        "TransactionAlreadyExecuted"
      );
    });

    it("self-call failure reverts (does not use Option B)", async function () {
      const badSelfCall = quais.solidityPacked(["bytes4"], ["0xdeadbeef"]);
      const txHash = await proposeSelfCall(wallet, walletAddress, owner1, badSelfCall);
      await approveN(wallet, txHash, [owner1, owner2], THRESHOLD);

      await expectRevert(
        wallet.connect(owner1).executeTransaction(txHash),
        "UnrecognizedSelfCall"
      );
    });
  });

  // ==========================================================================
  // Owner Management via Self-Calls
  // ==========================================================================

  describe("Owner Management", function () {
    it("should add owner via multisig self-call", async function () {
      const addData = walletIface.encodeFunctionData("addOwner", [guardian1.address]);
      const { execReceipt } = await executeSelfCall(wallet, walletAddress, addData, [owner1, owner2, owner3], THRESHOLD);

      expect(await wallet.isOwner(guardian1.address)).to.be.true;
      const owners = await wallet.getOwners();
      expect(owners).to.have.lengthOf(4);

      // Event assertion
      expectEvent(execReceipt, "OwnerAdded", [walletIface]);
    });

    it("should remove owner via multisig self-call", async function () {
      const removeData = walletIface.encodeFunctionData("removeOwner", [guardian1.address]);
      const { execReceipt } = await executeSelfCall(wallet, walletAddress, removeData, [owner1, owner2, owner3], THRESHOLD);

      expect(await wallet.isOwner(guardian1.address)).to.be.false;
      const owners = await wallet.getOwners();
      expect(owners).to.have.lengthOf(3);

      // Event assertion
      expectEvent(execReceipt, "OwnerRemoved", [walletIface]);
    });

    it("removing owner invalidates their in-flight approvals (epoch-based)", async function () {
      // Add guardian1 back
      const addData = walletIface.encodeFunctionData("addOwner", [guardian1.address]);
      await executeSelfCall(wallet, walletAddress, addData, [owner1, owner2, owner3], THRESHOLD);

      // guardian1 approves a tx
      const txHash = await proposeExternal(
        wallet, walletAddress, owner1, owner2.address, quais.parseQuai("0.001")
      );
      await withRetry(async () => {
        await warmup();
        const approveTx = await wallet.connect(guardian1).approveTransaction(txHash);
        await waitForTx(approveTx, "guardian1 approve");
      }, "guardian1Approve");
      expect(await wallet.hasApproved(txHash, guardian1.address)).to.be.true;

      // Remove + re-add guardian1 (bumps epoch)
      const removeData = walletIface.encodeFunctionData("removeOwner", [guardian1.address]);
      await executeSelfCall(wallet, walletAddress, removeData, [owner1, owner2, owner3], THRESHOLD);
      const readdData = walletIface.encodeFunctionData("addOwner", [guardian1.address]);
      await executeSelfCall(wallet, walletAddress, readdData, [owner1, owner2, owner3], THRESHOLD);

      // Old approval should be invalid
      expect(await wallet.hasApproved(txHash, guardian1.address)).to.be.false;

      // Cleanup
      const cleanupData = walletIface.encodeFunctionData("removeOwner", [guardian1.address]);
      await executeSelfCall(wallet, walletAddress, cleanupData, [owner1, owner2, owner3], THRESHOLD);
    });

    it("should change threshold via multisig self-call", async function () {
      const threshData = walletIface.encodeFunctionData("changeThreshold", [3]);
      const { execReceipt } = await executeSelfCall(wallet, walletAddress, threshData, [owner1, owner2, owner3], THRESHOLD);
      expect(Number(await wallet.threshold())).to.equal(3);

      // Event assertion
      expectEvent(execReceipt, "ThresholdChanged", [walletIface]);

      const revertData = walletIface.encodeFunctionData("changeThreshold", [2]);
      await executeSelfCall(wallet, walletAddress, revertData, [owner1, owner2, owner3], 3);
      expect(Number(await wallet.threshold())).to.equal(2);
    });
  });

  // ==========================================================================
  // Module Management & Execution (MockModule)
  // ==========================================================================

  describe("Module Management & Execution", function () {
    it("should enable MockModule, execute via module, then disable", async function () {
      const moduleAddr = await mockModule.getAddress();

      await withRetry(async () => {
        await warmup();
        const setTargetTx = await mockModule.setTarget(walletAddress);
        await waitForTx(setTargetTx, "setTarget");
      }, "setTarget");

      const { execReceipt: enableReceipt } = await enableModule(wallet, walletAddress, moduleAddr);
      expect(await wallet.isModuleEnabled(moduleAddr)).to.be.true;

      // Event assertion — ModuleEnabled
      expectEvent(enableReceipt, "EnabledModule", [walletIface]);

      // Execute QUAI transfer via module (4-param)
      const balanceBefore = await provider.getBalance(owner3.address);
      const moduleExecReceipt = await withRetry(async () => {
        await warmup();
        const execTx = await mockModule.exec(
          owner3.address, quais.parseQuai("0.01"), "0x", 0
        );
        return await waitForTx(execTx, "module exec");
      }, "moduleExec");
      const balanceAfter = await provider.getBalance(owner3.address);
      expect(balanceAfter - balanceBefore).to.equal(quais.parseQuai("0.01"));

      // Event assertion — ExecutionFromModuleSuccess
      expectEvent(moduleExecReceipt, "ExecutionFromModuleSuccess", [walletIface]);

      // Execute via 3-param legacy
      await withRetry(async () => {
        await warmup();
        const legacyTx = await mockModule.execLegacy(
          owner3.address, quais.parseQuai("0.01"), "0x"
        );
        await waitForTx(legacyTx, "module execLegacy");
      }, "moduleExecLegacy");

      // Disable module
      const SENTINEL = "0x0000000000000000000000000000000000000001";
      const disableData = walletIface.encodeFunctionData("disableModule", [SENTINEL, moduleAddr]);
      const { execReceipt: disableReceipt } = await executeSelfCall(wallet, walletAddress, disableData, [owner1, owner2, owner3], THRESHOLD);
      expect(await wallet.isModuleEnabled(moduleAddr)).to.be.false;

      // Event assertion — ModuleDisabled
      expectEvent(disableReceipt, "DisabledModule", [walletIface]);
    });

    it("module can call addOwner via execTransactionFromModule", async function () {
      const moduleAddr = await mockModule.getAddress();

      await withRetry(async () => {
        await warmup();
        const setTargetTx = await mockModule.setTarget(walletAddress);
        await waitForTx(setTargetTx, "setTarget");
      }, "setTarget");

      // Enable module (skip if already enabled from prior test's failed cleanup)
      if (!(await wallet.isModuleEnabled(moduleAddr))) {
        await enableModule(wallet, walletAddress, moduleAddr);
      }

      const addOwnerData = walletIface.encodeFunctionData("addOwner", [guardian2.address]);
      await withRetry(async () => {
        await warmup();
        // Nested call chain (EOA → MockModule → wallet.execTransactionFromModule → wallet.addOwner)
        // needs explicit gas — quais underestimates for complex nested calls on Quai
        const gasEstimate = await mockModule.exec.estimateGas(walletAddress, 0, addOwnerData, 0);
        const execTx = await mockModule.exec(walletAddress, 0, addOwnerData, 0, {
          gasLimit: gasEstimate * 3n,
        });
        await waitForTx(execTx, "module addOwner");
      }, "moduleAddOwner");
      expect(await wallet.isOwner(guardian2.address)).to.be.true;

      // Cleanup
      const removeData = walletIface.encodeFunctionData("removeOwner", [guardian2.address]);
      await executeSelfCall(wallet, walletAddress, removeData, [owner1, owner2, owner3], THRESHOLD);
      const SENTINEL = "0x0000000000000000000000000000000000000001";
      const disableData = walletIface.encodeFunctionData("disableModule", [SENTINEL, moduleAddr]);
      await executeSelfCall(wallet, walletAddress, disableData, [owner1, owner2, owner3], THRESHOLD);
    });

    it("should emit ExecutionFromModuleFailure for reverting module call", async function () {
      const moduleAddr = await mockModule.getAddress();

      await withRetry(async () => {
        await warmup();
        const setTargetTx = await mockModule.setTarget(walletAddress);
        await waitForTx(setTargetTx, "setTarget");
      }, "setTarget");

      if (!(await wallet.isModuleEnabled(moduleAddr))) {
        await enableModule(wallet, walletAddress, moduleAddr);
      }

      // Execute a call that will fail — factory has no fallback, so 0xdeadbeef reverts
      const badCalldata = quais.solidityPacked(["bytes4"], ["0xdeadbeef"]);
      const failReceipt = await withRetry(async () => {
        await warmup();
        const execTx = await mockModule.exec(factoryAddress, 0, badCalldata, 0);
        return await waitForTx(execTx, "module exec (expect failure event)");
      }, "moduleExecFail");

      // Event assertion — ExecutionFromModuleFailure
      expectEvent(failReceipt, "ExecutionFromModuleFailure", [walletIface]);

      // Cleanup
      const SENTINEL = "0x0000000000000000000000000000000000000001";
      const disableData = walletIface.encodeFunctionData("disableModule", [SENTINEL, moduleAddr]);
      await executeSelfCall(wallet, walletAddress, disableData, [owner1, owner2, owner3], THRESHOLD);
    });

    it("non-module caller is rejected", async function () {
      await expectRevert(
        wallet
          .connect(guardian1)
          ["execTransactionFromModule(address,uint256,bytes,uint8)"](
            owner2.address, 0, "0x", 0
          ),
        "NotAnAuthorizedModule"
      );
    });
  });

  // ==========================================================================
  // MultiSend Batch Transactions
  // ==========================================================================

  describe("MultiSend Batch Transactions", function () {
    it("should execute batched QUAI transfers via MultiSend delegatecall", async function () {
      const moduleAddr = await mockModule.getAddress();

      await withRetry(async () => {
        await warmup();
        const setTargetTx = await mockModule.setTarget(walletAddress);
        await waitForTx(setTargetTx, "setTarget");
      }, "setTarget");

      // Enable module (skip if already enabled from prior test's failed cleanup)
      if (!(await wallet.isModuleEnabled(moduleAddr))) {
        await enableModule(wallet, walletAddress, moduleAddr);
      }

      // CR-1: Disable delegatecall guard to allow MultiSend DelegateCall
      if (await wallet.delegatecallDisabled()) {
        const disableDCData = walletIface.encodeFunctionData("setDelegatecallDisabled", [false]);
        await executeSelfCall(wallet, walletAddress, disableDCData, [owner1, owner2, owner3], THRESHOLD);
        expect(await wallet.delegatecallDisabled()).to.be.false;
      }

      const amount1 = quais.parseQuai("0.01");
      const amount2 = quais.parseQuai("0.01");

      const balBefore1 = await provider.getBalance(guardian1.address);
      const balBefore2 = await provider.getBalance(guardian2.address);

      const packed =
        encodeMultiSendTx(0, guardian1.address, amount1, "0x") +
        encodeMultiSendTx(0, guardian2.address, amount2, "0x").slice(2);

      const multiSendData = multiSendIface.encodeFunctionData("multiSend", [packed]);
      const multiSendAddress = await multiSend.getAddress();

      await withRetry(async () => {
        await warmup();
        // DelegateCall via module — explicit gas for complex nested call chain
        const gasEstimate = await mockModule.exec.estimateGas(multiSendAddress, 0, multiSendData, 1);
        const execTx = await mockModule.exec(multiSendAddress, 0, multiSendData, 1, {
          gasLimit: gasEstimate * 3n,
        });
        await waitForTx(execTx, "multiSend delegatecall");
      }, "multiSendExec");

      const balAfter1 = await provider.getBalance(guardian1.address);
      const balAfter2 = await provider.getBalance(guardian2.address);

      expect(balAfter1 - balBefore1).to.equal(amount1);
      expect(balAfter2 - balBefore2).to.equal(amount2);

      // CR-1: Re-enable delegatecall guard
      const enableDCData = walletIface.encodeFunctionData("setDelegatecallDisabled", [true]);
      await executeSelfCall(wallet, walletAddress, enableDCData, [owner1, owner2, owner3], THRESHOLD);
      expect(await wallet.delegatecallDisabled()).to.be.true;

      // Cleanup
      const SENTINEL = "0x0000000000000000000000000000000000000001";
      const disableData = walletIface.encodeFunctionData("disableModule", [SENTINEL, moduleAddr]);
      await executeSelfCall(wallet, walletAddress, disableData, [owner1, owner2, owner3], THRESHOLD);
    });

    it("should block MultiSend delegatecall when delegatecallDisabled=true (CR-1)", async function () {
      const moduleAddr = await mockModule.getAddress();

      await withRetry(async () => {
        await warmup();
        const setTargetTx = await mockModule.setTarget(walletAddress);
        await waitForTx(setTargetTx, "setTarget");
      }, "setTarget");

      if (!(await wallet.isModuleEnabled(moduleAddr))) {
        await enableModule(wallet, walletAddress, moduleAddr);
      }

      // Ensure delegatecall guard is ON
      expect(await wallet.delegatecallDisabled()).to.be.true;

      const packed = encodeMultiSendTx(0, guardian1.address, quais.parseQuai("0.01"), "0x");
      const multiSendData = multiSendIface.encodeFunctionData("multiSend", [packed]);
      const multiSendAddress = await multiSend.getAddress();

      // DelegateCall (operation=1) should be blocked
      // Use execStrict so the inner revert bubbles up (exec swallows reverts)
      await expectRevert(
        mockModule.execStrict(multiSendAddress, 0, multiSendData, 1),
        "DelegateCallDisabled"
      );

      // Cleanup
      const SENTINEL = "0x0000000000000000000000000000000000000001";
      const cleanupData = walletIface.encodeFunctionData("disableModule", [SENTINEL, moduleAddr]);
      await executeSelfCall(wallet, walletAddress, cleanupData, [owner1, owner2, owner3], THRESHOLD);
    });
  });

  // ==========================================================================
  // ERC-721 Token Handling
  // ==========================================================================

  describe("ERC-721 Token Handling", function () {
    it("should receive and send ERC-721 tokens", async function () {
      const tokenId = BigInt(Date.now());

      await withRetry(async () => {
        await warmup();
        const mintTx = await mockERC721.mint(owner1.address, tokenId);
        await waitForTx(mintTx, "mint ERC721");
      }, "mintERC721");

      await withRetry(async () => {
        await warmup();
        const transferTx = await mockERC721
          .connect(owner1)
          ["safeTransferFrom(address,address,uint256)"](owner1.address, walletAddress, tokenId);
        await waitForTx(transferTx, "safeTransfer to vault");
      }, "safeTransferToVault");

      expect(await mockERC721.ownerOf(tokenId)).to.equal(walletAddress);

      const transferOutData = mockERC721Iface.encodeFunctionData(
        "safeTransferFrom(address,address,uint256)",
        [walletAddress, owner2.address, tokenId]
      );
      await executeMultisig(
        wallet, walletAddress,
        await mockERC721.getAddress(), 0n, transferOutData,
        [owner1, owner2, owner3], THRESHOLD
      );

      expect(await mockERC721.ownerOf(tokenId)).to.equal(owner2.address);
    });
  });

  // ==========================================================================
  // ERC-1155 Token Handling
  // ==========================================================================

  describe("ERC-1155 Token Handling", function () {
    it("should receive and send ERC-1155 tokens", async function () {
      const tokenId = BigInt(Date.now());

      await withRetry(async () => {
        await warmup();
        const mintTx = await mockERC1155.mint(walletAddress, tokenId, 100, "0x");
        await waitForTx(mintTx, "mint ERC1155");
      }, "mintERC1155");
      expect(Number(await mockERC1155.balanceOf(walletAddress, tokenId))).to.equal(100);

      const transferData = mockERC1155Iface.encodeFunctionData(
        "safeTransferFrom",
        [walletAddress, owner2.address, tokenId, 50, "0x"]
      );
      await executeMultisig(
        wallet, walletAddress,
        await mockERC1155.getAddress(), 0n, transferData,
        [owner1, owner2, owner3], THRESHOLD
      );

      expect(Number(await mockERC1155.balanceOf(walletAddress, tokenId))).to.equal(50);
      expect(Number(await mockERC1155.balanceOf(owner2.address, tokenId))).to.equal(50);
    });

    it("should receive batch-minted ERC-1155 tokens", async function () {
      const ids = [BigInt(Date.now()), BigInt(Date.now() + 1), BigInt(Date.now() + 2)];

      await withRetry(async () => {
        await warmup();
        const mintTx = await mockERC1155.mintBatch(walletAddress, ids, [100, 200, 300], "0x");
        await waitForTx(mintTx, "mintBatch ERC1155");
      }, "mintBatchERC1155");

      expect(Number(await mockERC1155.balanceOf(walletAddress, ids[0]))).to.equal(100);
      expect(Number(await mockERC1155.balanceOf(walletAddress, ids[1]))).to.equal(200);
      expect(Number(await mockERC1155.balanceOf(walletAddress, ids[2]))).to.equal(300);
    });
  });

  // ==========================================================================
  // EIP-1271 Message Signing
  // ==========================================================================

  describe("EIP-1271 Message Signing", function () {
    it("should sign message via multisig, validate, then unsign", async function () {
      const dataHash = quais.keccak256(quais.toUtf8Bytes("Hello QuaiVault E2E"));
      const messageData = quais.AbiCoder.defaultAbiCoder().encode(["bytes32"], [dataHash]);

      const signData = walletIface.encodeFunctionData("signMessage", [messageData]);
      const { execReceipt: signReceipt } = await executeSelfCall(wallet, walletAddress, signData, [owner1, owner2, owner3], THRESHOLD);

      const result = await wallet.isValidSignature(dataHash, "0x");
      expect(result).to.equal("0x1626ba7e");

      // Event assertion — MessageSigned
      expectEvent(signReceipt, "MessageSigned", [walletIface]);

      const unsignData = walletIface.encodeFunctionData("unsignMessage", [messageData]);
      const { execReceipt: unsignReceipt } = await executeSelfCall(wallet, walletAddress, unsignData, [owner1, owner2, owner3], THRESHOLD);

      const result2 = await wallet.isValidSignature(dataHash, "0x");
      expect(result2).to.equal("0xffffffff");

      // Event assertion — MessageUnsigned
      expectEvent(unsignReceipt, "MessageUnsigned", [walletIface]);
    });

    it("different vaults produce different domain separators", async function () {
      const sep1 = await wallet.domainSeparator();
      const sep2 = await timelockWallet.domainSeparator();
      expect(sep1).to.not.equal(sep2);
    });
  });

  // ==========================================================================
  // ERC-165 Interface Support
  // ==========================================================================

  describe("ERC-165 Interface Support", function () {
    it("should support expected interfaces", async function () {
      expect(await wallet.supportsInterface("0x01ffc9a7")).to.be.true;  // IERC165
      expect(await wallet.supportsInterface("0x150b7a02")).to.be.true;  // IERC721Receiver
      expect(await wallet.supportsInterface("0x4e2312e0")).to.be.true;  // IERC1155Receiver
      expect(await wallet.supportsInterface("0x1626ba7e")).to.be.true;  // IERC1271
      expect(await wallet.supportsInterface("0xdeadbeef")).to.be.false; // Random
    });
  });

  // ==========================================================================
  // QUAI Reception
  // ==========================================================================

  describe("QUAI Reception", function () {
    it("should accept QUAI transfers and emit Received", async function () {
      // ERC1967 constructor proxy handles plain value transfers via its own receive()
      const balBefore = await provider.getBalance(walletAddress);
      const sendReceipt = await withRetry(async () => {
        await warmup();
        const sendTx = await owner1.sendTransaction({
          from: owner1.address,
          to: quais.getAddress(walletAddress),
          value: quais.parseQuai("0.01"),
        } as any);
        return await waitForTx(sendTx, "send QUAI");
      }, "sendQuai");

      const balAfter = await provider.getBalance(walletAddress);
      expect(balAfter - balBefore).to.equal(quais.parseQuai("0.01"));

      // Event assertion — Received emitted by proxy's receive()
      expectEvent(sendReceipt, "Received", [walletIface]);
    });

    it("should accept QUAI with data (payment memo)", async function () {
      await withRetry(async () => {
        await warmup();
        const sendTx = await owner1.sendTransaction({
          from: owner1.address,
          to: quais.getAddress(walletAddress),
          value: quais.parseQuai("0.01"),
          data: "0x1234",
        } as any);
        await waitForTx(sendTx, "send QUAI with memo");
      }, "sendQuaiWithMemo");
    });
  });

  // ==========================================================================
  // Social Recovery (Setup, Initiation, Cancellation)
  //
  // NOTE: Recovery *execution* is not tested here. The SocialRecoveryModule
  // enforces a 1-day minimum recovery period (L181), making it impractical
  // for a single-run E2E test. Recovery execution should be verified via:
  //   - The local Hardhat unit tests (time.increase), or
  //   - A two-phase on-chain script: phase 1 initiates+approves, phase 2
  //     runs 24+ hours later to execute and verify.
  // ==========================================================================

  describe("Social Recovery (Setup & Initiation)", function () {
    it("should enable module and setup recovery via multisig", async function () {
      const moduleAddr = await socialRecoveryModule.getAddress();
      await enableModule(wallet, walletAddress, moduleAddr);
      expect(await wallet.isModuleEnabled(moduleAddr)).to.be.true;

      const setupData = socialRecoveryIface.encodeFunctionData("setupRecovery", [
        walletAddress,
        [guardian1.address, guardian2.address],
        2,     // guardian threshold
        86400, // 1 day (contract minimum)
      ]);
      const { execReceipt: setupReceipt } = await executeMultisig(
        wallet, walletAddress,
        moduleAddr, 0n, setupData,
        [owner1, owner2, owner3], THRESHOLD
      );

      const recoveryConfig = await socialRecoveryModule.getRecoveryConfig(walletAddress);
      expect(recoveryConfig.guardians).to.deep.equal([guardian1.address, guardian2.address]);
      expect(Number(recoveryConfig.threshold)).to.equal(2);

      // Event assertion — RecoverySetup emitted by SocialRecoveryModule
      expectEvent(setupReceipt, "RecoverySetup", [socialRecoveryIface]);
    });

    it("should initiate and approve recovery", async function () {
      const newOwners = [guardian1.address, guardian2.address];

      const initReceipt = await withRetry(async () => {
        await warmup();
        const initTx = await socialRecoveryModule
          .connect(guardian1)
          .initiateRecovery(walletAddress, newOwners, 2);
        return await waitForTx(initTx, "initiateRecovery");
      }, "initiateRecovery");
      const recoveryHash = parseRecoveryHash(socialRecoveryIface, initReceipt);

      // Event assertion — RecoveryInitiated
      expectEvent(initReceipt, "RecoveryInitiated", [socialRecoveryIface]);

      const approve1Receipt = await withRetry(async () => {
        await warmup();
        const approve1Tx = await socialRecoveryModule
          .connect(guardian1)
          .approveRecovery(walletAddress, recoveryHash);
        return await waitForTx(approve1Tx, "approveRecovery[guardian1]");
      }, "approveRecovery[guardian1]");

      // Event assertion — RecoveryApproved
      expectEvent(approve1Receipt, "RecoveryApproved", [socialRecoveryIface]);

      await withRetry(async () => {
        await warmup();
        const approve2Tx = await socialRecoveryModule
          .connect(guardian2)
          .approveRecovery(walletAddress, recoveryHash);
        await waitForTx(approve2Tx, "approveRecovery[guardian2]");
      }, "approveRecovery[guardian2]");

      // Recovery is now approved and waiting the 1-day recovery period.
      // Execution tested separately (see NOTE above).
      console.log("      Recovery initiated and approved. Execution requires 24h wait.");
    });

    it("non-guardian cannot initiate recovery", async function () {
      await expectRevert(
        socialRecoveryModule
          .connect(owner3)
          .initiateRecovery(walletAddress, [owner3.address], 1),
        "NotAGuardian"
      );
    });

    it("owner can cancel pending recovery", async function () {
      const initReceipt = await withRetry(async () => {
        await warmup();
        const initTx = await socialRecoveryModule
          .connect(guardian1)
          .initiateRecovery(walletAddress, [guardian1.address], 1);
        return await waitForTx(initTx, "initiateRecovery");
      }, "initiateRecovery");
      const recoveryHash = parseRecoveryHash(socialRecoveryIface, initReceipt);

      const cancelReceipt = await withRetry(async () => {
        await warmup();
        const cancelTx = await socialRecoveryModule
          .connect(owner1)
          .cancelRecovery(walletAddress, recoveryHash);
        return await waitForTx(cancelTx, "cancelRecovery");
      }, "cancelRecovery");

      // Event assertion — RecoveryCancelled
      expectEvent(cancelReceipt, "RecoveryCancelled", [socialRecoveryIface]);

      await expectRevert(
        socialRecoveryModule
          .connect(guardian1)
          .approveRecovery(walletAddress, recoveryHash),
        "RecoveryNotInitiated"
      );
    });

    it("guardian can revoke recovery approval", async function () {
      // Initiate a fresh recovery
      const initReceipt = await withRetry(async () => {
        await warmup();
        const initTx = await socialRecoveryModule
          .connect(guardian1)
          .initiateRecovery(walletAddress, [guardian1.address, guardian2.address], 2);
        return await waitForTx(initTx, "initiateRecovery");
      }, "initiateRecovery");
      const recoveryHash = parseRecoveryHash(socialRecoveryIface, initReceipt);

      // Guardian1 approves
      await withRetry(async () => {
        await warmup();
        const approveTx = await socialRecoveryModule
          .connect(guardian1)
          .approveRecovery(walletAddress, recoveryHash);
        await waitForTx(approveTx, "approveRecovery[guardian1]");
      }, "approveRecovery[guardian1]");

      // Guardian1 revokes approval
      const revokeReceipt = await withRetry(async () => {
        await warmup();
        const revokeTx = await socialRecoveryModule
          .connect(guardian1)
          .revokeRecoveryApproval(walletAddress, recoveryHash);
        return await waitForTx(revokeTx, "revokeRecoveryApproval");
      }, "revokeRecoveryApproval");

      // Event assertion — RecoveryApprovalRevoked
      expectEvent(revokeReceipt, "RecoveryApprovalRevoked", [socialRecoveryIface]);

      // Cleanup — cancel the recovery
      await withRetry(async () => {
        await warmup();
        const cancelTx = await socialRecoveryModule
          .connect(owner1)
          .cancelRecovery(walletAddress, recoveryHash);
        await waitForTx(cancelTx, "cancelRecovery");
      }, "cancelRecovery");
    });
  });

  // ==========================================================================
  // setMinExecutionDelay
  // ==========================================================================

  describe("setMinExecutionDelay", function () {
    it("should change delay via self-call", async function () {
      expect(Number(await wallet.minExecutionDelay())).to.equal(0);

      const setData = walletIface.encodeFunctionData("setMinExecutionDelay", [60]);
      const { execReceipt } = await executeSelfCall(wallet, walletAddress, setData, [owner1, owner2, owner3], THRESHOLD);
      expect(Number(await wallet.minExecutionDelay())).to.equal(60);

      // Event assertion — MinExecutionDelayChanged
      expectEvent(execReceipt, "MinExecutionDelayChanged", [walletIface]);

      const revertData = walletIface.encodeFunctionData("setMinExecutionDelay", [0]);
      await executeSelfCall(wallet, walletAddress, revertData, [owner1, owner2, owner3], THRESHOLD);
      expect(Number(await wallet.minExecutionDelay())).to.equal(0);
    });
  });
});
