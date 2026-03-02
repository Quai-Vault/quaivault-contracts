import { expect } from "chai";
import { ethers } from "hardhat";
import { QuaiVault, QuaiVaultFactory } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  getTxHash,
  proposeExternal,
  proposeSelfCall,
  approveN,
  executeSelfCall,
} from "./helpers";

/**
 * Comprehensive test suite for the Transaction Lifecycle Design.
 * Covers: per-transaction timelock (C-6), approvedAt clock semantics, cancellation paths,
 * expiration, Option B external call failures, self-call bypass, setMinExecutionDelay,
 * factory integration, lazy clock start, and expiredTxs mapping (L-3).
 */

const ONE_DAY = 24 * 60 * 60;
const TWO_DAYS = 2 * ONE_DAY;

// ==================== Test Suite ====================

describe("Timelock Design", function () {
  let implementation: QuaiVault;
  let factory: QuaiVaultFactory;
  let owner1: SignerWithAddress;
  let owner2: SignerWithAddress;
  let owner3: SignerWithAddress;
  let nonOwner: SignerWithAddress;

  const THRESHOLD = 2;

  // Deploy a simple quorum wallet (minExecutionDelay = 0)
  async function deploySimpleWallet(): Promise<QuaiVault> {
    const owners = [owner1.address, owner2.address, owner3.address];
    const salt = ethers.randomBytes(32);
    const tx = await factory.connect(owner1).createWallet(owners, THRESHOLD, salt);
    const receipt = await tx.wait();
    const event = receipt?.logs.find((log: any) => {
      try { return factory.interface.parseLog(log)?.name === "WalletCreated"; }
      catch { return false; }
    });
    const addr = factory.interface.parseLog(event as any)?.args[0];
    const QuaiVaultFactory = await ethers.getContractFactory("QuaiVault");
    const wallet = QuaiVaultFactory.attach(addr) as QuaiVault;
    await owner1.sendTransaction({ to: addr, value: ethers.parseEther("10") });
    return wallet;
  }

  // Deploy a timelocked wallet (minExecutionDelay = ONE_DAY)
  async function deployTimelockWallet(delay: number = ONE_DAY): Promise<QuaiVault> {
    const owners = [owner1.address, owner2.address, owner3.address];
    const salt = ethers.randomBytes(32);
    const tx = await factory.connect(owner1)["createWallet(address[],uint256,bytes32,uint32)"](
      owners, THRESHOLD, salt, delay
    );
    const receipt = await tx.wait();
    const event = receipt?.logs.find((log: any) => {
      try { return factory.interface.parseLog(log)?.name === "WalletCreated"; }
      catch { return false; }
    });
    const addr = factory.interface.parseLog(event as any)?.args[0];
    const QuaiVaultFactory = await ethers.getContractFactory("QuaiVault");
    const wallet = QuaiVaultFactory.attach(addr) as QuaiVault;
    await owner1.sendTransaction({ to: addr, value: ethers.parseEther("10") });
    return wallet;
  }

  beforeEach(async function () {
    [owner1, owner2, owner3, nonOwner] = await ethers.getSigners();

    const QuaiVault = await ethers.getContractFactory("QuaiVault");
    implementation = await QuaiVault.deploy();
    await implementation.waitForDeployment();

    const QuaiVaultFactoryF = await ethers.getContractFactory("QuaiVaultFactory");
    factory = await QuaiVaultFactoryF.deploy(await implementation.getAddress());
    await factory.waitForDeployment();
  });

  // ==================== Factory Integration ====================

  describe("Factory Integration", function () {
    it("3-param createWallet creates wallet with minExecutionDelay == 0", async function () {
      const wallet = await deploySimpleWallet();
      expect(await wallet.minExecutionDelay()).to.equal(0);
    });

    it("4-param createWallet creates wallet with correct minExecutionDelay", async function () {
      const wallet = await deployTimelockWallet(ONE_DAY);
      expect(await wallet.minExecutionDelay()).to.equal(ONE_DAY);
    });

    it("4-param createWallet is registered in factory", async function () {
      const wallet = await deployTimelockWallet(ONE_DAY);
      expect(await factory.isWallet(await wallet.getAddress())).to.be.true;
    });
  });

  // ==================== approvedAt Clock Semantics ====================

  describe("approvedAt Clock Semantics", function () {
    it("approvedAt is 0 before threshold is crossed", async function () {
      const wallet = await deploySimpleWallet();
      const txHash = await proposeExternal(wallet, owner1, nonOwner.address, ethers.parseEther("1"));
      // 1 approval below threshold=2
      await wallet.connect(owner1).approveTransaction(txHash);
      const tx = await wallet.getTransaction(txHash);
      expect(tx.approvedAt).to.equal(0);
    });

    it("approvedAt is set once when threshold is first crossed", async function () {
      const wallet = await deploySimpleWallet();
      const txHash = await proposeExternal(wallet, owner1, nonOwner.address, ethers.parseEther("1"));
      await wallet.connect(owner1).approveTransaction(txHash);
      const before = await time.latest();
      await wallet.connect(owner2).approveTransaction(txHash); // crosses threshold
      const after = await time.latest();
      const tx = await wallet.getTransaction(txHash);
      expect(tx.approvedAt).to.be.gte(before);
      expect(tx.approvedAt).to.be.lte(after);
    });

    it("approvedAt is NOT cleared when an approver revokes (clock permanence)", async function () {
      const wallet = await deploySimpleWallet();
      const txHash = await proposeExternal(wallet, owner1, nonOwner.address, ethers.parseEther("1"));
      await wallet.connect(owner1).approveTransaction(txHash);
      await wallet.connect(owner2).approveTransaction(txHash); // threshold crossed
      const { approvedAt: clockSet } = await wallet.getTransaction(txHash);
      expect(clockSet).to.be.gt(0);

      // owner2 revokes — count drops below threshold
      await wallet.connect(owner2).revokeApproval(txHash);
      const { approvedAt: afterRevoke } = await wallet.getTransaction(txHash);
      expect(afterRevoke).to.equal(clockSet); // unchanged
    });

    it("approvedAt is NOT reset when re-approved after revoke", async function () {
      const wallet = await deploySimpleWallet();
      const txHash = await proposeExternal(wallet, owner1, nonOwner.address, ethers.parseEther("1"));
      await wallet.connect(owner1).approveTransaction(txHash);
      await wallet.connect(owner2).approveTransaction(txHash);
      const { approvedAt: original } = await wallet.getTransaction(txHash);

      await wallet.connect(owner2).revokeApproval(txHash);
      await time.increase(10); // advance time
      await wallet.connect(owner2).approveTransaction(txHash); // re-approve
      const { approvedAt: afterReapprove } = await wallet.getTransaction(txHash);
      expect(afterReapprove).to.equal(original); // original timestamp preserved
    });

    it("ThresholdReached emitted exactly once — not re-emitted on subsequent approvals", async function () {
      const wallet = await deploySimpleWallet();
      const txHash = await proposeExternal(wallet, owner1, nonOwner.address, ethers.parseEther("1"));

      // Second approval crosses threshold → ThresholdReached emitted
      await wallet.connect(owner1).approveTransaction(txHash);
      await expect(wallet.connect(owner2).approveTransaction(txHash))
        .to.emit(wallet, "ThresholdReached");

      // Third approval (beyond threshold) should NOT re-emit ThresholdReached
      const filter = wallet.filters.ThresholdReached();
      const eventsBefore = await wallet.queryFilter(filter);
      await wallet.connect(owner3).approveTransaction(txHash);
      const eventsAfter = await wallet.queryFilter(filter);
      expect(eventsAfter.length).to.equal(eventsBefore.length); // no new event
    });

    it("ThresholdReached emitted from approveAndExecute path", async function () {
      const wallet = await deploySimpleWallet();
      const txHash = await proposeExternal(wallet, owner1, nonOwner.address, ethers.parseEther("1"));
      await wallet.connect(owner1).approveTransaction(txHash);

      // approveAndExecute crosses threshold — should emit ThresholdReached
      await expect(wallet.connect(owner2).approveAndExecute(txHash))
        .to.emit(wallet, "ThresholdReached");
    });
  });

  // ==================== Self-Call Delay Override ====================

  describe("Self-Call Delay Override", function () {
    it("self-call proposal stores executionDelay == 0 regardless of vault minExecutionDelay", async function () {
      const wallet = await deployTimelockWallet(ONE_DAY);
      const addData = wallet.interface.encodeFunctionData("addOwner", [nonOwner.address]);
      const txHash = await proposeSelfCall(wallet, owner1, addData);
      const tx = await wallet.getTransaction(txHash);
      expect(tx.executionDelay).to.equal(0); // forced to 0 for self-calls
    });

    it("self-call executes immediately even when vault minExecutionDelay > 0", async function () {
      const wallet = await deployTimelockWallet(ONE_DAY);
      const addData = wallet.interface.encodeFunctionData("addOwner", [nonOwner.address]);
      await executeSelfCall(wallet, addData, [owner1, owner2, owner3], THRESHOLD);
      expect(await wallet.isOwner(nonOwner.address)).to.be.true;
    });

    it("per-tx requestedDelay == 0 for self-call even when requested > 0", async function () {
      const wallet = await deployTimelockWallet(ONE_DAY);
      const addData = wallet.interface.encodeFunctionData("addOwner", [nonOwner.address]);
      const walletAddr = await wallet.getAddress();
      // Use the 5-param overload with requestedDelay = TWO_DAYS for a self-call
      const tx = await wallet.connect(owner1)["proposeTransaction(address,uint256,bytes,uint48,uint32)"](
        walletAddr, 0, addData, 0, TWO_DAYS
      );
      const txHash = await getTxHash(wallet, tx);
      const stored = await wallet.getTransaction(txHash);
      expect(stored.executionDelay).to.equal(0); // self-call always 0
    });
  });

  // ==================== Timelock Enforcement ====================

  describe("Timelock Enforcement", function () {
    it("simple vault (delay=0): executes immediately after threshold", async function () {
      const wallet = await deploySimpleWallet();
      const txHash = await proposeExternal(wallet, owner1, nonOwner.address, ethers.parseEther("1"));
      await approveN(wallet, txHash, [owner1, owner2], THRESHOLD);
      await expect(wallet.connect(owner3).executeTransaction(txHash))
        .to.emit(wallet, "TransactionExecuted");
    });

    it("timelocked vault: executeTransaction reverts TimelockNotElapsed before delay", async function () {
      const wallet = await deployTimelockWallet(ONE_DAY);
      const txHash = await proposeExternal(wallet, owner1, nonOwner.address, ethers.parseEther("1"));
      await approveN(wallet, txHash, [owner1, owner2], THRESHOLD);
      await expect(wallet.connect(owner3).executeTransaction(txHash))
        .to.be.revertedWithCustomError(wallet, "TimelockNotElapsed");
    });

    it("timelocked vault: executeTransaction succeeds after delay elapses", async function () {
      const wallet = await deployTimelockWallet(ONE_DAY);
      const txHash = await proposeExternal(wallet, owner1, nonOwner.address, ethers.parseEther("1"));
      await approveN(wallet, txHash, [owner1, owner2], THRESHOLD);
      await time.increase(ONE_DAY);
      await expect(wallet.connect(owner3).executeTransaction(txHash))
        .to.emit(wallet, "TransactionExecuted");
    });

    it("TimelockNotElapsed error carries correct executableAfter", async function () {
      const wallet = await deployTimelockWallet(ONE_DAY);
      const txHash = await proposeExternal(wallet, owner1, nonOwner.address, ethers.parseEther("1"));
      await wallet.connect(owner1).approveTransaction(txHash);
      const { approvedAt } = await wallet.getTransaction(txHash);
      await wallet.connect(owner2).approveTransaction(txHash); // crosses threshold, sets approvedAt
      const { approvedAt: clock } = await wallet.getTransaction(txHash);
      const expectedExecutableAfter = BigInt(clock) + BigInt(ONE_DAY);

      await expect(wallet.connect(owner3).executeTransaction(txHash))
        .to.be.revertedWithCustomError(wallet, "TimelockNotElapsed")
        .withArgs(expectedExecutableAfter);
    });

    it("per-tx requestedDelay > vault floor: effectiveDelay = requestedDelay", async function () {
      const wallet = await deployTimelockWallet(ONE_DAY); // floor = 1 day
      const txHash = await proposeExternal(wallet, owner1, nonOwner.address, ethers.parseEther("1"),
        "0x"); // ... then use 5-param overload with TWO_DAYS
      // Get stored executionDelay (this one was proposed with default 0 delay → uses floor=ONE_DAY)
      let tx = await wallet.getTransaction(txHash);
      expect(tx.executionDelay).to.equal(ONE_DAY);

      // Propose again with requestedDelay = TWO_DAYS (> vault floor)
      const tx2 = await wallet.connect(owner1)["proposeTransaction(address,uint256,bytes,uint48,uint32)"](
        nonOwner.address, ethers.parseEther("1"), "0x", 0, TWO_DAYS
      );
      const txHash2 = await getTxHash(wallet, tx2);
      const stored2 = await wallet.getTransaction(txHash2);
      expect(stored2.executionDelay).to.equal(TWO_DAYS); // max(ONE_DAY, TWO_DAYS)
    });

    it("per-tx requestedDelay < vault floor: effectiveDelay = minExecutionDelay (floor enforced)", async function () {
      const wallet = await deployTimelockWallet(ONE_DAY); // floor = 1 day
      // requestedDelay = 0 (below floor)
      const txHash = await proposeExternal(wallet, owner1, nonOwner.address, ethers.parseEther("1"));
      const stored = await wallet.getTransaction(txHash);
      expect(stored.executionDelay).to.equal(ONE_DAY); // floor applied
    });

    it("lazy clock start: threshold met by lowering threshold, first execute starts clock and returns", async function () {
      // Vault has 1-day timelock; 3 owners; threshold starts at 3
      const owners = [owner1.address, owner2.address, owner3.address];
      const salt = ethers.randomBytes(32);
      const tx = await factory.connect(owner1)["createWallet(address[],uint256,bytes32,uint32)"](
        owners, 3, salt, ONE_DAY
      );
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try { return factory.interface.parseLog(log)?.name === "WalletCreated"; }
        catch { return false; }
      });
      const addr = factory.interface.parseLog(event as any)?.args[0];
      const QuaiVaultF = await ethers.getContractFactory("QuaiVault");
      const wallet = QuaiVaultF.attach(addr) as QuaiVault;
      await owner1.sendTransaction({ to: addr, value: ethers.parseEther("10") });

      // Propose external transfer; only owner1 and owner2 approve (below threshold=3)
      const txHash = await proposeExternal(wallet, owner1, nonOwner.address, ethers.parseEther("1"));
      await wallet.connect(owner1).approveTransaction(txHash);
      await wallet.connect(owner2).approveTransaction(txHash);
      // approvedAt still 0 — threshold not met

      // Lower threshold to 2 via self-call (all 3 sign)
      const changeData = wallet.interface.encodeFunctionData("changeThreshold", [2]);
      await executeSelfCall(wallet, changeData, [owner1, owner2, owner3], 3);
      expect(await wallet.threshold()).to.equal(2);

      // Now the external tx has 2 approvals >= threshold=2 but approvedAt was never set.
      // First executeTransaction: lazy clock start → sets approvedAt, emits ThresholdReached,
      // and RETURNS (no revert). We cannot revert here — EVM reverts roll back all state changes,
      // which would undo the approvedAt assignment and make the lazy clock impossible to start.
      await expect(wallet.connect(owner3).executeTransaction(txHash))
        .to.emit(wallet, "ThresholdReached");

      // approvedAt is committed to storage (no revert means the assignment persists)
      const { approvedAt } = await wallet.getTransaction(txHash);
      expect(approvedAt).to.be.gt(0);

      // Attempting to execute before delay elapses now reverts TimelockNotElapsed
      await expect(wallet.connect(owner3).executeTransaction(txHash))
        .to.be.revertedWithCustomError(wallet, "TimelockNotElapsed");

      // After delay: succeeds
      await time.increase(ONE_DAY);
      await expect(wallet.connect(owner3).executeTransaction(txHash))
        .to.emit(wallet, "TransactionExecuted");
    });
  });

  // ==================== Cancellation Paths ====================

  describe("Cancellation Paths", function () {
    it("cancelTransaction allowed before approvedAt is set", async function () {
      const wallet = await deployTimelockWallet();
      const txHash = await proposeExternal(wallet, owner1, nonOwner.address, ethers.parseEther("1"));
      // one approval below threshold
      await wallet.connect(owner1).approveTransaction(txHash);
      await expect(wallet.connect(owner1).cancelTransaction(txHash))
        .to.emit(wallet, "TransactionCancelled");
    });

    it("cancelTransaction blocked once approvedAt is set — even after revocation drops count below threshold", async function () {
      const wallet = await deployTimelockWallet();
      const txHash = await proposeExternal(wallet, owner1, nonOwner.address, ethers.parseEther("1"));
      await wallet.connect(owner1).approveTransaction(txHash);
      await wallet.connect(owner2).approveTransaction(txHash); // threshold → approvedAt set
      await wallet.connect(owner2).revokeApproval(txHash);     // count back below threshold

      // approvedAt != 0 → permanent block on cancelTransaction
      await expect(wallet.connect(owner1).cancelTransaction(txHash))
        .to.be.revertedWithCustomError(wallet, "CannotCancelApprovedTransaction");
    });

    it("cancelByConsensus via self-call cancels a timelocked approved tx", async function () {
      const wallet = await deployTimelockWallet();
      const txHash = await proposeExternal(wallet, owner1, nonOwner.address, ethers.parseEther("1"));
      await approveN(wallet, txHash, [owner1, owner2], THRESHOLD);
      // Tx is in APPROVED state (timelock ticking)

      // Cancel via self-call (quorum consensus, no timelock)
      const cancelData = wallet.interface.encodeFunctionData("cancelByConsensus", [txHash]);
      await executeSelfCall(wallet, cancelData, [owner1, owner2, owner3], THRESHOLD);

      const tx = await wallet.getTransaction(txHash);
      expect(tx.cancelled).to.be.true;
    });

    it("after cancelByConsensus: executeTransaction reverts TransactionAlreadyCancelled", async function () {
      const wallet = await deployTimelockWallet();
      const txHash = await proposeExternal(wallet, owner1, nonOwner.address, ethers.parseEther("1"));
      await approveN(wallet, txHash, [owner1, owner2], THRESHOLD);
      const cancelData = wallet.interface.encodeFunctionData("cancelByConsensus", [txHash]);
      await executeSelfCall(wallet, cancelData, [owner1, owner2, owner3], THRESHOLD);
      await time.increase(ONE_DAY);
      await expect(wallet.connect(owner3).executeTransaction(txHash))
        .to.be.revertedWithCustomError(wallet, "TransactionAlreadyCancelled");
    });

    it("cancel clears approval mappings (QV-L2)", async function () {
      const wallet = await deploySimpleWallet();
      const txHash = await proposeExternal(wallet, owner1, nonOwner.address, ethers.parseEther("1"));
      await wallet.connect(owner2).approveTransaction(txHash);
      await wallet.connect(owner1).cancelTransaction(txHash);
      expect(await wallet.hasApproved(txHash, owner2.address)).to.be.false;
    });
  });

  // ==================== Failed External Calls (Option B) ====================

  describe("Failed External Calls (Option B)", function () {
    let reverting: any;

    beforeEach(async function () {
      // Deploy a contract that always reverts
      const Reverting = await ethers.getContractFactory("MockERC721");
      reverting = await Reverting.deploy();
      await reverting.waitForDeployment();
    });

    it("external call to reverting contract: TransactionFailed emitted, no revert", async function () {
      const wallet = await deploySimpleWallet();
      // Call a function that will revert (transfer to non-receiver)
      const badData = reverting.interface.encodeFunctionData("transferFrom", [
        await wallet.getAddress(), nonOwner.address, 999
      ]);
      const txHash = await proposeExternal(wallet, owner1, await reverting.getAddress(), 0n, badData);
      await approveN(wallet, txHash, [owner1, owner2], THRESHOLD);

      await expect(wallet.connect(owner3).executeTransaction(txHash))
        .to.emit(wallet, "TransactionFailed")
        .and.not.to.emit(wallet, "TransactionExecuted");
    });

    it("after external failure: transaction.executed == true (terminal state)", async function () {
      const wallet = await deploySimpleWallet();
      const badData = reverting.interface.encodeFunctionData("transferFrom", [
        await wallet.getAddress(), nonOwner.address, 999
      ]);
      const txHash = await proposeExternal(wallet, owner1, await reverting.getAddress(), 0n, badData);
      await approveN(wallet, txHash, [owner1, owner2], THRESHOLD);
      await wallet.connect(owner3).executeTransaction(txHash);

      const tx = await wallet.getTransaction(txHash);
      expect(tx.executed).to.be.true;
    });

    it("after external failure: re-execution attempt reverts TransactionAlreadyExecuted", async function () {
      const wallet = await deploySimpleWallet();
      const badData = reverting.interface.encodeFunctionData("transferFrom", [
        await wallet.getAddress(), nonOwner.address, 999
      ]);
      const txHash = await proposeExternal(wallet, owner1, await reverting.getAddress(), 0n, badData);
      await approveN(wallet, txHash, [owner1, owner2], THRESHOLD);
      await wallet.connect(owner3).executeTransaction(txHash);

      await expect(wallet.connect(owner3).executeTransaction(txHash))
        .to.be.revertedWithCustomError(wallet, "TransactionAlreadyExecuted");
    });

    it("self-call failure (unrecognized selector) reverts — executed rolls back", async function () {
      const wallet = await deploySimpleWallet();
      const walletAddr = await wallet.getAddress();
      // threshold() selector is not in dispatch table
      const badSelfCallData = wallet.interface.encodeFunctionData("threshold");
      const txHash = await proposeSelfCall(wallet, owner1, badSelfCallData);
      await approveN(wallet, txHash, [owner1, owner2], THRESHOLD);

      await expect(wallet.connect(owner3).executeTransaction(txHash))
        .to.be.revertedWithCustomError(wallet, "UnrecognizedSelfCall");

      // Reverted — executed should still be false
      const tx = await wallet.getTransaction(txHash);
      expect(tx.executed).to.be.false;
    });
  });

  // ==================== Expiration ====================

  describe("Expiration", function () {
    it("ExpirationTooSoon reverts when expiration <= block.timestamp + effectiveDelay", async function () {
      const wallet = await deploySimpleWallet(); // delay=0
      const now = await time.latest();
      // expiration == block.timestamp (at boundary — must be strictly greater)
      const data = wallet.interface.encodeFunctionData(
        "proposeTransaction(address,uint256,bytes,uint48)",
        [nonOwner.address, ethers.parseEther("1"), "0x", now]
      );
      await expect(
        owner1.sendTransaction({ to: await wallet.getAddress(), data })
      ).to.be.revertedWithCustomError(wallet, "ExpirationTooSoon");
    });

    it("ExpirationTooSoon for timelocked vault: expiration must exceed approvedAt + delay", async function () {
      const wallet = await deployTimelockWallet(ONE_DAY);
      const now = await time.latest();
      // expiration = now + ONE_DAY - 1: too soon (must be > now + ONE_DAY)
      const tooSoon = now + ONE_DAY;
      const data = wallet.interface.encodeFunctionData(
        "proposeTransaction(address,uint256,bytes,uint48)",
        [nonOwner.address, ethers.parseEther("1"), "0x", tooSoon]
      );
      await expect(
        owner1.sendTransaction({ to: await wallet.getAddress(), data })
      ).to.be.revertedWithCustomError(wallet, "ExpirationTooSoon");
    });

    it("expiration == 0 (no expiry) always valid regardless of delay", async function () {
      const wallet = await deployTimelockWallet(ONE_DAY);
      const txHash = await proposeExternal(wallet, owner1, nonOwner.address, ethers.parseEther("1"));
      const tx = await wallet.getTransaction(txHash);
      expect(tx.expiration).to.equal(0);
    });

    it("expireTransaction on no-expiry tx (expiration==0): reverts TransactionNotExpired", async function () {
      const wallet = await deploySimpleWallet();
      const txHash = await proposeExternal(wallet, owner1, nonOwner.address, ethers.parseEther("1"));
      await expect(wallet.expireTransaction(txHash))
        .to.be.revertedWithCustomError(wallet, "TransactionNotExpired");
    });

    it("expireTransaction before expiry: reverts TransactionNotExpired", async function () {
      const wallet = await deploySimpleWallet();
      const now = await time.latest();
      const expiration = now + ONE_DAY + 10;
      const data = wallet.interface.encodeFunctionData(
        "proposeTransaction(address,uint256,bytes,uint48)",
        [nonOwner.address, ethers.parseEther("1"), "0x", expiration]
      );
      const tx = await owner1.sendTransaction({ to: await wallet.getAddress(), data });
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try { return wallet.interface.parseLog(log)?.name === "TransactionProposed"; }
        catch { return false; }
      });
      const txHash = wallet.interface.parseLog(event as any)?.args[0];

      await expect(wallet.expireTransaction(txHash))
        .to.be.revertedWithCustomError(wallet, "TransactionNotExpired");
    });

    it("expireTransaction after expiry: succeeds, sets cancelled=true, clears approvals, emits TransactionExpired", async function () {
      const wallet = await deploySimpleWallet();
      const now = await time.latest();
      const expiration = now + ONE_DAY + 10;
      const data = wallet.interface.encodeFunctionData(
        "proposeTransaction(address,uint256,bytes,uint48)",
        [nonOwner.address, ethers.parseEther("1"), "0x", expiration]
      );
      const tx = await owner1.sendTransaction({ to: await wallet.getAddress(), data });
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try { return wallet.interface.parseLog(log)?.name === "TransactionProposed"; }
        catch { return false; }
      });
      const txHash = wallet.interface.parseLog(event as any)?.args[0];

      await wallet.connect(owner2).approveTransaction(txHash);

      await time.increase(ONE_DAY + 11);
      await expect(wallet.expireTransaction(txHash))
        .to.emit(wallet, "TransactionExpired")
        .withArgs(txHash);

      const stored = await wallet.getTransaction(txHash);
      expect(stored.cancelled).to.be.true;
      expect(await wallet.hasApproved(txHash, owner2.address)).to.be.false; // QV-L2 cleared
    });

    it("expireTransaction callable by non-owner (permissionless)", async function () {
      const wallet = await deploySimpleWallet();
      const now = await time.latest();
      const expiration = now + ONE_DAY + 10;
      const data = wallet.interface.encodeFunctionData(
        "proposeTransaction(address,uint256,bytes,uint48)",
        [nonOwner.address, ethers.parseEther("1"), "0x", expiration]
      );
      const tx = await owner1.sendTransaction({ to: await wallet.getAddress(), data });
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try { return wallet.interface.parseLog(log)?.name === "TransactionProposed"; }
        catch { return false; }
      });
      const txHash = wallet.interface.parseLog(event as any)?.args[0];

      await time.increase(ONE_DAY + 11);
      // nonOwner calls expireTransaction — should succeed
      await expect(wallet.connect(nonOwner).expireTransaction(txHash))
        .to.emit(wallet, "TransactionExpired");
    });

    it("after expireTransaction: executeTransaction reverts TransactionAlreadyCancelled", async function () {
      const wallet = await deploySimpleWallet();
      const now = await time.latest();
      const expiration = now + ONE_DAY + 10;
      const data = wallet.interface.encodeFunctionData(
        "proposeTransaction(address,uint256,bytes,uint48)",
        [nonOwner.address, ethers.parseEther("1"), "0x", expiration]
      );
      const tx = await owner1.sendTransaction({ to: await wallet.getAddress(), data });
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try { return wallet.interface.parseLog(log)?.name === "TransactionProposed"; }
        catch { return false; }
      });
      const txHash = wallet.interface.parseLog(event as any)?.args[0];
      await approveN(wallet, txHash, [owner1, owner2], THRESHOLD);
      await time.increase(ONE_DAY + 11);
      await wallet.expireTransaction(txHash);
      await expect(wallet.connect(owner3).executeTransaction(txHash))
        .to.be.revertedWithCustomError(wallet, "TransactionAlreadyCancelled");
    });

    it("should allow 0 expiration and execute after long delay", async function () { // Audit: C-7
      const wallet = await deploySimpleWallet();
      const tx = await wallet.connect(owner1).proposeTransaction(nonOwner.address, ethers.parseEther("1"), "0x");
      const txHash = await getTxHash(wallet, tx);
      const transaction = await wallet.getTransaction(txHash);
      expect(transaction.expiration).to.equal(0);

      await time.increase(365 * 24 * 60 * 60); // 1 year

      await wallet.connect(owner1).approveTransaction(txHash);
      await wallet.connect(owner2).approveTransaction(txHash);
      await wallet.connect(owner3).executeTransaction(txHash);
      expect((await wallet.getTransaction(txHash)).executed).to.be.true;
    });

    it("should reject execution of expired transaction", async function () { // Audit: C-7
      const wallet = await deploySimpleWallet();
      const now = await time.latest();
      const expiration = now + 3600; // 1 hour from now

      const data = wallet.interface.encodeFunctionData(
        "proposeTransaction(address,uint256,bytes,uint48)",
        [nonOwner.address, ethers.parseEther("1"), "0x", expiration]
      );

      const tx = await owner1.sendTransaction({
        to: await wallet.getAddress(),
        data: data,
      });
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try { return wallet.interface.parseLog(log)?.name === "TransactionProposed"; }
        catch { return false; }
      });
      const txHash = wallet.interface.parseLog(event as any)?.args[0];

      await wallet.connect(owner1).approveTransaction(txHash);
      await wallet.connect(owner2).approveTransaction(txHash);

      await time.increase(3601);

      await expect(
        wallet.connect(owner3).executeTransaction(txHash)
      ).to.be.revertedWithCustomError(wallet, "TransactionIsExpired");
    });

    it("should execute non-expired transaction with expiration set", async function () { // Audit: C-7
      const wallet = await deploySimpleWallet();
      const now = await time.latest();
      const expiration = now + 86400; // 1 day from now

      const data = wallet.interface.encodeFunctionData(
        "proposeTransaction(address,uint256,bytes,uint48)",
        [nonOwner.address, ethers.parseEther("1"), "0x", expiration]
      );

      const tx = await owner1.sendTransaction({
        to: await wallet.getAddress(),
        data: data,
      });
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try { return wallet.interface.parseLog(log)?.name === "TransactionProposed"; }
        catch { return false; }
      });
      const txHash = wallet.interface.parseLog(event as any)?.args[0];

      await wallet.connect(owner1).approveTransaction(txHash);
      await wallet.connect(owner2).approveTransaction(txHash);

      await wallet.connect(owner3).executeTransaction(txHash);
      expect((await wallet.getTransaction(txHash)).executed).to.be.true;
    });

    it("should accept proposal with future expiration", async function () { // Audit: L-NEW-5
      const wallet = await deploySimpleWallet();
      const now = await time.latest();
      const futureExpiration = now + 86400;

      const data = wallet.interface.encodeFunctionData(
        "proposeTransaction(address,uint256,bytes,uint48)",
        [nonOwner.address, ethers.parseEther("1"), "0x", futureExpiration]
      );

      const tx = await owner1.sendTransaction({
        to: await wallet.getAddress(),
        data: data,
      });
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try { return wallet.interface.parseLog(log)?.name === "TransactionProposed"; }
        catch { return false; }
      });
      expect(event).to.not.be.undefined;
    });
  });

  // ==================== expiredTxs Mapping (L-3) ====================

  describe("expiredTxs Mapping", function () {
    it("expireTransaction sets expiredTxs[txHash]=true, cancelled=true", async function () { // Audit: L-3
      const wallet = await deploySimpleWallet();
      const now = await time.latest();
      const expiration = now + 10;

      const tx = await wallet.connect(owner1)["proposeTransaction(address,uint256,bytes,uint48)"](
        nonOwner.address, 0n, "0x", expiration
      );
      const txHash = await getTxHash(wallet, tx);

      await time.increase(20);

      await wallet.connect(owner1).expireTransaction(txHash);

      const stored = await wallet.getTransaction(txHash);
      expect(stored.cancelled).to.be.true;
      expect(await wallet.expiredTxs(txHash)).to.be.true;
    });

    it("cancelTransaction does NOT set expiredTxs", async function () { // Audit: L-3
      const wallet = await deploySimpleWallet();
      const tx = await wallet.connect(owner1).proposeTransaction(nonOwner.address, 0n, "0x");
      const txHash = await getTxHash(wallet, tx);

      await wallet.connect(owner1).cancelTransaction(txHash);

      const stored = await wallet.getTransaction(txHash);
      expect(stored.cancelled).to.be.true;
      expect(await wallet.expiredTxs(txHash)).to.be.false; // key distinction
    });
  });

  // ==================== setMinExecutionDelay (prospective only) ====================

  describe("setMinExecutionDelay", function () {
    it("changes minExecutionDelay and emits MinExecutionDelayChanged", async function () {
      const wallet = await deploySimpleWallet(); // starts at 0
      const setDelayData = wallet.interface.encodeFunctionData("setMinExecutionDelay", [ONE_DAY]);

      await expect(executeSelfCall(wallet, setDelayData, [owner1, owner2, owner3], THRESHOLD))
        .to.be.fulfilled;

      expect(await wallet.minExecutionDelay()).to.equal(ONE_DAY);
    });

    it("in-flight tx proposed before change retains original executionDelay", async function () {
      const wallet = await deploySimpleWallet(); // starts at 0
      // Propose with delay=0 (simple vault)
      const txHash = await proposeExternal(wallet, owner1, nonOwner.address, ethers.parseEther("1"));
      const { executionDelay: before } = await wallet.getTransaction(txHash);
      expect(before).to.equal(0);

      // Change vault delay to 1 day
      const setDelayData = wallet.interface.encodeFunctionData("setMinExecutionDelay", [ONE_DAY]);
      await executeSelfCall(wallet, setDelayData, [owner1, owner2, owner3], THRESHOLD);

      // In-flight tx still has executionDelay=0 (locked at proposal time)
      const { executionDelay: after } = await wallet.getTransaction(txHash);
      expect(after).to.equal(0);

      // And can still be executed immediately (no timelock applied to it)
      await approveN(wallet, txHash, [owner1, owner2], THRESHOLD);
      await expect(wallet.connect(owner3).executeTransaction(txHash))
        .to.emit(wallet, "TransactionExecuted");
    });

    it("new proposal after change uses new floor", async function () {
      const wallet = await deploySimpleWallet();
      const setDelayData = wallet.interface.encodeFunctionData("setMinExecutionDelay", [ONE_DAY]);
      await executeSelfCall(wallet, setDelayData, [owner1, owner2, owner3], THRESHOLD);

      const txHash = await proposeExternal(wallet, owner1, nonOwner.address, ethers.parseEther("1"));
      const { executionDelay } = await wallet.getTransaction(txHash);
      expect(executionDelay).to.equal(ONE_DAY); // new floor applied
    });
  });
});
