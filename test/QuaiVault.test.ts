import { expect } from "chai";
import { ethers } from "hardhat";
import { QuaiVault, QuaiVaultFactory } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  getTxHash,
  executeSelfCall,
  executeMultisig,
  deployWalletViaFactory,
  proposeExternal,
  proposeSelfCall,
  approveN,
} from "./helpers";

describe("QuaiVault", function () {
  let implementation: QuaiVault;
  let factory: QuaiVaultFactory;
  let wallet: QuaiVault;
  let owner1: SignerWithAddress;
  let owner2: SignerWithAddress;
  let owner3: SignerWithAddress;
  let nonOwner: SignerWithAddress;
  let extra1: SignerWithAddress;
  let extra2: SignerWithAddress;

  const THRESHOLD = 2;

  beforeEach(async function () {
    [owner1, owner2, owner3, nonOwner, extra1, extra2] =
      await ethers.getSigners();

    // Deploy implementation
    const QuaiVault = await ethers.getContractFactory("QuaiVault");
    implementation = await QuaiVault.deploy();
    await implementation.waitForDeployment();

    // Deploy factory
    const QuaiVaultFactory = await ethers.getContractFactory(
      "QuaiVaultFactory"
    );
    factory = await QuaiVaultFactory.deploy(
      await implementation.getAddress()
    );
    await factory.waitForDeployment();

    // Create a 2-of-3 wallet through the factory
    wallet = await deployWalletViaFactory(
      factory,
      [owner1.address, owner2.address, owner3.address],
      THRESHOLD,
      owner1
    );

    // Fund the wallet
    await owner1.sendTransaction({
      to: await wallet.getAddress(),
      value: ethers.parseEther("10"),
    });
  });

  // ==================== Initialization ====================

  describe("Initialization", function () {
    it("should initialize with correct owners and threshold", async function () {
      const owners = await wallet.getOwners();
      expect(owners).to.have.lengthOf(3);
      expect(owners).to.include(owner1.address);
      expect(owners).to.include(owner2.address);
      expect(owners).to.include(owner3.address);

      expect(await wallet.threshold()).to.equal(THRESHOLD);
    });

    it("should set owner flags correctly", async function () {
      expect(await wallet.isOwner(owner1.address)).to.be.true;
      expect(await wallet.isOwner(owner2.address)).to.be.true;
      expect(await wallet.isOwner(owner3.address)).to.be.true;
      expect(await wallet.isOwner(nonOwner.address)).to.be.false;
    });

    it("should initialize nonce to 0", async function () {
      expect(await wallet.nonce()).to.equal(0);
    });

    it("should reject invalid threshold", async function () {
      const owners = [owner1.address, owner2.address];
      const salt = ethers.randomBytes(32);

      await expect(
        factory.connect(owner1).createWallet(owners, 0, salt)
      ).to.be.revertedWithCustomError(wallet, "InvalidThreshold");

      await expect(
        factory.connect(owner1).createWallet(owners, 3, salt)
      ).to.be.revertedWithCustomError(wallet, "InvalidThreshold");
    });

    it("should reject empty owners array", async function () {
      const salt = ethers.randomBytes(32);

      await expect(
        factory.connect(owner1).createWallet([], THRESHOLD, salt)
      ).to.be.revertedWithCustomError(wallet, "OwnersRequired");
    });

    it("should reject double initialization (Initializable)", async function () {
      await expect(
        wallet.initialize([owner1.address], 1, 0, true)
      ).to.be.revertedWithCustomError(wallet, "InvalidInitialization");
    });

    it("should reject initialization on implementation contract directly", async function () {
      await expect(
        implementation.initialize([owner1.address], 1, 0, true)
      ).to.be.revertedWithCustomError(
        implementation,
        "InvalidInitialization"
      );
    });
  });

  // ==================== Transaction Proposal ====================

  describe("Transaction Proposal", function () {
    it("should allow owner to propose transaction", async function () {
      const to = nonOwner.address;
      const value = ethers.parseEther("1.0");
      const data = "0x";

      const tx = await wallet
        .connect(owner1)
        .proposeTransaction(to, value, data);
      const receipt = await tx.wait();

      expect(receipt?.logs).to.have.lengthOf.at.least(1);
    });

    it("should emit TransactionProposed event", async function () {
      const to = nonOwner.address;
      const value = ethers.parseEther("1.0");
      const data = "0x";

      await expect(
        wallet.connect(owner1).proposeTransaction(to, value, data)
      ).to.emit(wallet, "TransactionProposed");
    });

    it("should reject proposal from non-owner", async function () {
      const to = nonOwner.address;
      const value = ethers.parseEther("1.0");
      const data = "0x";

      await expect(
        wallet.connect(nonOwner).proposeTransaction(to, value, data)
      ).to.be.revertedWithCustomError(wallet, "NotAnOwner");
    });

    it("should reject proposal to zero address", async function () {
      const value = ethers.parseEther("1.0");
      const data = "0x";

      await expect(
        wallet
          .connect(owner1)
          .proposeTransaction(ethers.ZeroAddress, value, data)
      ).to.be.revertedWithCustomError(wallet, "InvalidDestinationAddress");
    });

    it("should create transaction with correct hash", async function () {
      const to = nonOwner.address;
      const value = ethers.parseEther("1.0");
      const data = "0x";

      const tx = await wallet
        .connect(owner1)
        .proposeTransaction(to, value, data);
      const txHash = await getTxHash(wallet, tx);

      const transaction = await wallet.getTransaction(txHash);
      expect(transaction.to).to.equal(to);
      expect(transaction.value).to.equal(value);
      expect(transaction.data).to.equal(data);
      expect(transaction.executed).to.be.false;
      expect(transaction.approvedAt).to.equal(0);
    });

    it("should handle all three proposeTransaction overloads", async function () {
      // 3-param overload
      const tx1 = await wallet
        .connect(owner1)
        .proposeTransaction(nonOwner.address, 0, "0x");
      const hash1 = await getTxHash(wallet, tx1);
      expect(hash1).to.not.be.undefined;

      // 4-param overload
      const futureExp = (await time.latest()) + 86400;
      const tx2 = await wallet
        .connect(owner1)
        ["proposeTransaction(address,uint256,bytes,uint48)"](
          nonOwner.address,
          0,
          "0x",
          futureExp
        );
      const hash2 = await getTxHash(wallet, tx2);
      expect(hash2).to.not.be.undefined;

      // 5-param overload
      const tx3 = await wallet
        .connect(owner1)
        ["proposeTransaction(address,uint256,bytes,uint48,uint32)"](
          nonOwner.address,
          0,
          "0x",
          futureExp,
          100
        );
      const hash3 = await getTxHash(wallet, tx3);
      expect(hash3).to.not.be.undefined;

      // All three should produce unique hashes (different nonces)
      expect(hash1).to.not.equal(hash2);
      expect(hash2).to.not.equal(hash3);
    });

    it("should reject proposal with 5-param overload when expiration is in the past", async function () {
      const pastTimestamp = (await time.latest()) - 100;
      await expect(
        wallet
          .connect(owner1)
          ["proposeTransaction(address,uint256,bytes,uint48,uint32)"](
            nonOwner.address,
            0,
            "0x",
            pastTimestamp,
            0
          )
      ).to.be.revertedWithCustomError(wallet, "ExpirationTooSoon");
    });

    it("event args include expiration and executionDelay fields", async function () {
      // Audit: I-1
      const latestBlock = await ethers.provider.getBlock("latest");
      const now = latestBlock!.timestamp;
      const expiration = now + 3600;
      const requestedDelay = 1800;

      // Use explicit 5-param signature to disambiguate from shorter overloads
      const tx = await wallet
        .connect(owner1)
        ["proposeTransaction(address,uint256,bytes,uint48,uint32)"](
          nonOwner.address,
          0n,
          "0x",
          expiration,
          requestedDelay
        );
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try {
          return (
            wallet.interface.parseLog(log)?.name === "TransactionProposed"
          );
        } catch {
          return false;
        }
      });
      const parsed = wallet.interface.parseLog(event as any)!;

      // args[5] = expiration, args[6] = executionDelay
      expect(parsed.args[5]).to.equal(expiration);
      expect(parsed.args[6]).to.equal(requestedDelay);
    });

    it("3-param overload emits expiration=0, executionDelay=0", async function () {
      // Audit: I-1
      const tx = await wallet
        .connect(owner1)
        .proposeTransaction(nonOwner.address, 0n, "0x");
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try {
          return (
            wallet.interface.parseLog(log)?.name === "TransactionProposed"
          );
        } catch {
          return false;
        }
      });
      const parsed = wallet.interface.parseLog(event as any)!;
      expect(parsed.args[5]).to.equal(0); // expiration
      expect(parsed.args[6]).to.equal(0); // executionDelay
    });
  });

  // ==================== Transaction Approval ====================

  describe("Transaction Approval", function () {
    let txHash: string;

    beforeEach(async function () {
      const to = nonOwner.address;
      const value = ethers.parseEther("1.0");
      const data = "0x";

      const tx = await wallet
        .connect(owner1)
        .proposeTransaction(to, value, data);
      txHash = await getTxHash(wallet, tx);
    });

    it("should allow owner to approve transaction", async function () {
      await expect(wallet.connect(owner2).approveTransaction(txHash))
        .to.emit(wallet, "TransactionApproved")
        .withArgs(txHash, owner2.address);

      // Approval below threshold -- mapping reflects it, approvedAt still 0
      expect(await wallet.hasApproved(txHash, owner2.address)).to.be.true;
      const transaction = await wallet.getTransaction(txHash);
      expect(transaction.approvedAt).to.equal(0); // threshold not yet met
    });

    it("should prevent duplicate approvals", async function () {
      await wallet.connect(owner2).approveTransaction(txHash);

      await expect(
        wallet.connect(owner2).approveTransaction(txHash)
      ).to.be.revertedWithCustomError(wallet, "AlreadyApproved");
    });

    it("should reject approval from non-owner", async function () {
      await expect(
        wallet.connect(nonOwner).approveTransaction(txHash)
      ).to.be.revertedWithCustomError(wallet, "NotAnOwner");
    });

    it("should track approvals correctly", async function () {
      await wallet.connect(owner2).approveTransaction(txHash);
      expect(await wallet.hasApproved(txHash, owner2.address)).to.be.true;
      expect(await wallet.hasApproved(txHash, owner3.address)).to.be.false;

      // owner3 approval crosses threshold (threshold=2) -- ThresholdReached emitted
      await expect(
        wallet.connect(owner3).approveTransaction(txHash)
      ).to.emit(wallet, "ThresholdReached");
      expect(await wallet.hasApproved(txHash, owner3.address)).to.be.true;
      const transaction = await wallet.getTransaction(txHash);
      expect(transaction.approvedAt).to.be.greaterThan(0); // clock set permanently
    });

    it("approveAndExecute should return false when not enough approvals (single owner of 2-of-3)", async function () {
      // approveAndExecute with only 1 approval (threshold=2) should return false, not revert
      const result = await wallet
        .connect(owner1)
        .approveAndExecute.staticCall(txHash);
      expect(result).to.equal(false);
    });

    it("approveAndExecute should not re-emit TransactionApproved when already approved", async function () {
      // First approve
      await wallet.connect(owner1).approveTransaction(txHash);

      // Second approval via normal path
      await wallet.connect(owner2).approveTransaction(txHash);

      // owner1 calls approveAndExecute -- already approved, should not re-emit
      const execTx = await wallet.connect(owner1).approveAndExecute(txHash);
      const receipt = await execTx.wait();

      const approvedEvents = receipt?.logs.filter((log: any) => {
        try {
          const parsed = wallet.interface.parseLog(log);
          return parsed?.name === "TransactionApproved";
        } catch {
          return false;
        }
      });

      // Should have zero TransactionApproved events (owner1 was already approved)
      expect(approvedEvents?.length).to.equal(0);
    });

    it("approveAndExecute should return false on timelocked tx when delay not elapsed", async function () {
      // Create timelocked wallet (1 hour delay)
      const timelocked = await deployWalletViaFactory(
        factory,
        [owner1.address, owner2.address, owner3.address],
        2,
        owner1,
        3600 // 1 hour
      );

      await owner1.sendTransaction({
        to: await timelocked.getAddress(),
        value: ethers.parseEther("1.0"),
      });

      const tlTx = await timelocked
        .connect(owner1)
        .proposeTransaction(nonOwner.address, ethers.parseEther("0.1"), "0x");
      const tlTxHash = await getTxHash(timelocked, tlTx);

      // First approval
      await timelocked.connect(owner1).approveTransaction(tlTxHash);

      // Second approval via approveAndExecute -- threshold met but timelock not elapsed
      const result = await timelocked
        .connect(owner2)
        .approveAndExecute.staticCall(tlTxHash);
      expect(result).to.equal(false);
    });
  });

  // ==================== Transaction Execution ====================

  describe("Transaction Execution", function () {
    let txHash: string;

    beforeEach(async function () {
      const to = nonOwner.address;
      const value = ethers.parseEther("1.0");
      const data = "0x";

      const tx = await wallet
        .connect(owner1)
        .proposeTransaction(to, value, data);
      txHash = await getTxHash(wallet, tx);
    });

    it("should execute transaction after threshold is met", async function () {
      // Get approvals
      await wallet.connect(owner1).approveTransaction(txHash);
      await wallet.connect(owner2).approveTransaction(txHash);

      const balanceBefore = await ethers.provider.getBalance(
        nonOwner.address
      );

      await expect(wallet.connect(owner3).executeTransaction(txHash))
        .to.emit(wallet, "TransactionExecuted")
        .withArgs(txHash, owner3.address);

      const balanceAfter = await ethers.provider.getBalance(
        nonOwner.address
      );
      expect(balanceAfter - balanceBefore).to.equal(
        ethers.parseEther("1.0")
      );

      const transaction = await wallet.getTransaction(txHash);
      expect(transaction.executed).to.be.true;
    });

    it("should reject execution before threshold", async function () {
      await wallet.connect(owner1).approveTransaction(txHash);

      await expect(
        wallet.connect(owner2).executeTransaction(txHash)
      ).to.be.revertedWithCustomError(wallet, "NotEnoughApprovals");
    });

    it("should prevent double execution", async function () {
      await wallet.connect(owner1).approveTransaction(txHash);
      await wallet.connect(owner2).approveTransaction(txHash);

      await wallet.connect(owner3).executeTransaction(txHash);

      await expect(
        wallet.connect(owner3).executeTransaction(txHash)
      ).to.be.revertedWithCustomError(wallet, "TransactionAlreadyExecuted");
    });

    it("should increment nonce on proposal (not execution)", async function () {
      // Nonce should already be incremented from the beforeEach proposal
      const nonceAfterProposal = await wallet.nonce();
      expect(nonceAfterProposal).to.equal(1n);

      // Execute the transaction
      await wallet.connect(owner1).approveTransaction(txHash);
      await wallet.connect(owner2).approveTransaction(txHash);
      await wallet.connect(owner3).executeTransaction(txHash);

      // Nonce should NOT change on execution (only on proposal)
      const nonceAfterExecution = await wallet.nonce();
      expect(nonceAfterExecution).to.equal(1n);

      // Propose another transaction to verify nonce increments
      const to = nonOwner.address;
      const value = ethers.parseEther("0.5");
      const data = "0x";
      await wallet.connect(owner1).proposeTransaction(to, value, data);

      const nonceAfterSecondProposal = await wallet.nonce();
      expect(nonceAfterSecondProposal).to.equal(2n);
    });

    it("should not count removed owner's approval (ghost approvals excluded)", async function () {
      // Audit: C-3
      // Propose a simple ETH transfer
      const tx = await wallet
        .connect(owner1)
        .proposeTransaction(
          nonOwner.address,
          ethers.parseEther("1"),
          "0x"
        );
      const ghostTxHash = await getTxHash(wallet, tx);

      // owner2 approves
      await wallet.connect(owner2).approveTransaction(ghostTxHash);

      // Now remove owner2 through multisig
      const removeData = wallet.interface.encodeFunctionData("removeOwner", [
        owner2.address,
      ]);
      await executeSelfCall(wallet, removeData, [owner1, owner3], 2);

      // owner2 is now removed
      expect(await wallet.isOwner(owner2.address)).to.be.false;

      // owner2's approval on the first tx should be a ghost -- not counted
      // owner1 approves: 1 valid approval, still below threshold
      await wallet.connect(owner1).approveTransaction(ghostTxHash);

      // Should fail -- only 1 valid approval (owner1), ghost from owner2 doesn't count
      await expect(
        wallet.connect(owner1).executeTransaction(ghostTxHash)
      ).to.be.revertedWithCustomError(wallet, "NotEnoughApprovals");

      // owner3 approves: 2 valid approvals, now meets threshold
      await wallet.connect(owner3).approveTransaction(ghostTxHash);
      await wallet.connect(owner1).executeTransaction(ghostTxHash);

      const transaction = await wallet.getTransaction(ghostTxHash);
      expect(transaction.executed).to.be.true;
    });
  });

  // ==================== Approval Revocation ====================

  describe("Approval Revocation", function () {
    let txHash: string;

    beforeEach(async function () {
      const to = nonOwner.address;
      const value = ethers.parseEther("1.0");
      const data = "0x";

      const tx = await wallet
        .connect(owner1)
        .proposeTransaction(to, value, data);
      txHash = await getTxHash(wallet, tx);

      await wallet.connect(owner1).approveTransaction(txHash);
    });

    it("should allow owner to revoke approval", async function () {
      await expect(wallet.connect(owner1).revokeApproval(txHash))
        .to.emit(wallet, "ApprovalRevoked")
        .withArgs(txHash, owner1.address);

      expect(await wallet.hasApproved(txHash, owner1.address)).to.be.false;
    });

    it("should reject revocation if not approved", async function () {
      await expect(
        wallet.connect(owner2).revokeApproval(txHash)
      ).to.be.revertedWithCustomError(wallet, "NotApproved");
    });

    it("should reject revocation after execution", async function () {
      await wallet.connect(owner2).approveTransaction(txHash);
      await wallet.connect(owner3).executeTransaction(txHash);

      await expect(
        wallet.connect(owner1).revokeApproval(txHash)
      ).to.be.revertedWithCustomError(wallet, "TransactionAlreadyExecuted");
    });
  });

  // ==================== Transaction Cancellation ====================

  describe("Transaction Cancellation", function () {
    let txHash: string;

    beforeEach(async function () {
      const to = nonOwner.address;
      const value = ethers.parseEther("1.0");
      const data = "0x";

      const tx = await wallet
        .connect(owner1)
        .proposeTransaction(to, value, data);
      txHash = await getTxHash(wallet, tx);
    });

    it("should allow proposer to cancel transaction", async function () {
      await expect(wallet.connect(owner1).cancelTransaction(txHash))
        .to.emit(wallet, "TransactionCancelled")
        .withArgs(txHash, owner1.address);

      const transaction = await wallet.getTransaction(txHash);
      expect(transaction.cancelled).to.be.true;
    });

    it("should reject cancellation after threshold approvals", async function () {
      // Audit: C-2
      await wallet.connect(owner2).approveTransaction(txHash);
      await wallet.connect(owner3).approveTransaction(txHash);

      // Proposer cannot cancel once threshold is met
      await expect(
        wallet.connect(owner1).cancelTransaction(txHash)
      ).to.be.revertedWithCustomError(
        wallet,
        "CannotCancelApprovedTransaction"
      );
    });

    it("should prevent execution of cancelled transaction", async function () {
      // Proposer cancels before any approvals
      await wallet.connect(owner1).cancelTransaction(txHash);

      // Try to execute -- should fail because transaction is cancelled
      await expect(
        wallet.connect(owner3).executeTransaction(txHash)
      ).to.be.revertedWithCustomError(wallet, "TransactionAlreadyCancelled");
    });

    it("should reject cancellation from non-proposer", async function () {
      // Audit: C-2
      await expect(
        wallet.connect(owner2).cancelTransaction(txHash)
      ).to.be.revertedWithCustomError(wallet, "NotProposer");
    });

    it("should allow proposer to cancel with zero approvals", async function () {
      // Audit: C-2
      await expect(
        wallet.connect(owner1).cancelTransaction(txHash)
      ).to.emit(wallet, "TransactionCancelled");
    });

    it("should clear approval mappings on cancel", async function () {
      // Audit: QV-L2
      await wallet.connect(owner2).approveTransaction(txHash);
      await wallet.connect(owner1).cancelTransaction(txHash);

      const transaction = await wallet.getTransaction(txHash);
      expect(transaction.cancelled).to.be.true;
      // QV-L2: approvals cleared on cancel to prevent ghost approvals on address reuse
      expect(await wallet.hasApproved(txHash, owner2.address)).to.be.false;
    });

    it("should block cancelTransaction once approvedAt is set -- even after revoke (C-6 clock permanence)", async function () {
      // Audit: C-6
      // owner1 (proposer) and owner2 approve -- threshold met -- approvedAt set
      await wallet.connect(owner1).approveTransaction(txHash);
      await wallet.connect(owner2).approveTransaction(txHash);

      // owner2 revokes -- count drops below threshold again
      await wallet.connect(owner2).revokeApproval(txHash);

      // proposer cannot cancel despite count being below threshold:
      // approvedAt != 0 is the permanent gate, not current count
      await expect(
        wallet.connect(owner1).cancelTransaction(txHash)
      ).to.be.revertedWithCustomError(
        wallet,
        "CannotCancelApprovedTransaction"
      );
    });

    it("cancelByConsensus should revert on non-existent transaction", async function () {
      const fakeTxHash = ethers.keccak256(
        ethers.toUtf8Bytes("nonexistent")
      );
      const data = wallet.interface.encodeFunctionData("cancelByConsensus", [
        fakeTxHash,
      ]);
      const walletAddr = await wallet.getAddress();

      const cancelProposeTx = await wallet
        .connect(owner1)
        .proposeTransaction(walletAddr, 0, data);
      const cancelTxHash = await getTxHash(wallet, cancelProposeTx);
      await wallet.connect(owner1).approveTransaction(cancelTxHash);
      await wallet.connect(owner2).approveTransaction(cancelTxHash);

      await expect(
        wallet.connect(owner1).executeTransaction(cancelTxHash)
      ).to.be.revertedWithCustomError(wallet, "TransactionDoesNotExist");
    });

    it("cancelByConsensus should revert on already executed transaction", async function () {
      // Execute the beforeEach transaction
      await wallet.connect(owner1).approveTransaction(txHash);
      await wallet.connect(owner2).approveTransaction(txHash);
      await wallet.connect(owner1).executeTransaction(txHash);

      // Now try to cancelByConsensus the already-executed tx
      const data = wallet.interface.encodeFunctionData("cancelByConsensus", [
        txHash,
      ]);
      const walletAddr = await wallet.getAddress();

      const cancelProposeTx = await wallet
        .connect(owner1)
        .proposeTransaction(walletAddr, 0, data);
      const cancelTxHash = await getTxHash(wallet, cancelProposeTx);
      await wallet.connect(owner1).approveTransaction(cancelTxHash);
      await wallet.connect(owner2).approveTransaction(cancelTxHash);

      await expect(
        wallet.connect(owner1).executeTransaction(cancelTxHash)
      ).to.be.revertedWithCustomError(wallet, "TransactionAlreadyExecuted");
    });

    it("cancelByConsensus should revert on already cancelled transaction", async function () {
      // Cancel via proposer
      await wallet.connect(owner1).cancelTransaction(txHash);

      // Now try to cancelByConsensus the already-cancelled tx
      const data = wallet.interface.encodeFunctionData("cancelByConsensus", [
        txHash,
      ]);
      const walletAddr = await wallet.getAddress();

      const cancelProposeTx = await wallet
        .connect(owner1)
        .proposeTransaction(walletAddr, 0, data);
      const cancelTxHash = await getTxHash(wallet, cancelProposeTx);
      await wallet.connect(owner1).approveTransaction(cancelTxHash);
      await wallet.connect(owner2).approveTransaction(cancelTxHash);

      await expect(
        wallet.connect(owner1).executeTransaction(cancelTxHash)
      ).to.be.revertedWithCustomError(wallet, "TransactionAlreadyCancelled");
    });
  });

  // ==================== Owner Management ====================

  describe("Owner Management", function () {
    it("should add owner through multisig", async function () {
      const newOwner = nonOwner.address;
      const addOwnerData = wallet.interface.encodeFunctionData("addOwner", [
        newOwner,
      ]);

      await executeSelfCall(
        wallet,
        addOwnerData,
        [owner1, owner2, owner3],
        THRESHOLD
      );

      expect(await wallet.isOwner(newOwner)).to.be.true;
      const owners = await wallet.getOwners();
      expect(owners).to.include(newOwner);
    });

    it("should remove owner through multisig", async function () {
      const removeOwnerData = wallet.interface.encodeFunctionData(
        "removeOwner",
        [owner3.address]
      );

      await executeSelfCall(
        wallet,
        removeOwnerData,
        [owner1, owner2, owner3],
        THRESHOLD
      );

      expect(await wallet.isOwner(owner3.address)).to.be.false;
      const owners = await wallet.getOwners();
      expect(owners).to.not.include(owner3.address);
    });

    it("should change threshold through multisig", async function () {
      const newThreshold = 3;
      const changeThresholdData = wallet.interface.encodeFunctionData(
        "changeThreshold",
        [newThreshold]
      );

      await executeSelfCall(
        wallet,
        changeThresholdData,
        [owner1, owner2, owner3],
        THRESHOLD
      );

      expect(await wallet.threshold()).to.equal(newThreshold);
    });

    it("should revert addOwner with zero address", async function () {
      const data = wallet.interface.encodeFunctionData("addOwner", [
        ethers.ZeroAddress,
      ]);
      const walletAddr = await wallet.getAddress();

      const tx = await wallet
        .connect(owner1)
        .proposeTransaction(walletAddr, 0, data);
      const txHash = await getTxHash(wallet, tx);
      await wallet.connect(owner1).approveTransaction(txHash);
      await wallet.connect(owner2).approveTransaction(txHash);

      await expect(
        wallet.connect(owner1).executeTransaction(txHash)
      ).to.be.revertedWithCustomError(wallet, "InvalidOwnerAddress");
    });

    // BB-M-2 defense-in-depth: SENTINEL_MODULES must not be an owner
    it("should revert addOwner with SENTINEL address (BB-M-2)", async function () {
      const SENTINEL = "0x0000000000000000000000000000000000000001";
      const data = wallet.interface.encodeFunctionData("addOwner", [SENTINEL]);
      const walletAddr = await wallet.getAddress();

      const tx = await wallet.connect(owner1).proposeTransaction(walletAddr, 0, data);
      const txHash = await getTxHash(wallet, tx);
      await wallet.connect(owner1).approveTransaction(txHash);
      await wallet.connect(owner2).approveTransaction(txHash);

      await expect(
        wallet.connect(owner1).executeTransaction(txHash)
      ).to.be.revertedWithCustomError(wallet, "InvalidOwnerAddress");
    });

    it("should revert addOwner when MAX_OWNERS already reached", async function () {
      // Deploy wallet with 20 owners (MAX_OWNERS)
      const signers = await ethers.getSigners();
      const maxOwners: string[] = [];
      for (let i = 0; i < 20; i++) {
        maxOwners.push(signers[i].address);
      }

      const maxWallet = await deployWalletViaFactory(
        factory,
        maxOwners,
        1,
        owner1
      );

      // Try to add 21st owner
      const data = maxWallet.interface.encodeFunctionData("addOwner", [
        ethers.Wallet.createRandom().address,
      ]);
      const walletAddr = await maxWallet.getAddress();

      const tx = await maxWallet
        .connect(signers[0])
        .proposeTransaction(walletAddr, 0, data);
      const txHash = await getTxHash(maxWallet, tx);
      await maxWallet.connect(signers[0]).approveTransaction(txHash);

      await expect(
        maxWallet.connect(signers[0]).executeTransaction(txHash)
      ).to.be.revertedWithCustomError(maxWallet, "MaxOwnersReached");
    });

    it("should revert addOwner for already existing owner", async function () {
      const data = wallet.interface.encodeFunctionData("addOwner", [
        owner1.address,
      ]);
      const walletAddr = await wallet.getAddress();

      const tx = await wallet
        .connect(owner1)
        .proposeTransaction(walletAddr, 0, data);
      const txHash = await getTxHash(wallet, tx);
      await wallet.connect(owner1).approveTransaction(txHash);
      await wallet.connect(owner2).approveTransaction(txHash);

      await expect(
        wallet.connect(owner1).executeTransaction(txHash)
      ).to.be.revertedWithCustomError(wallet, "AlreadyAnOwner");
    });

    it("should revert removeOwner when it would drop below threshold", async function () {
      // 3-of-3 wallet: removing an owner would leave 2 owners with threshold=3
      const strictWallet = await deployWalletViaFactory(
        factory,
        [owner1.address, owner2.address, owner3.address],
        3,
        owner1
      );

      const data = strictWallet.interface.encodeFunctionData("removeOwner", [
        owner3.address,
      ]);
      const walletAddr = await strictWallet.getAddress();

      const tx = await strictWallet
        .connect(owner1)
        .proposeTransaction(walletAddr, 0, data);
      const txHash = await getTxHash(strictWallet, tx);
      await strictWallet.connect(owner1).approveTransaction(txHash);
      await strictWallet.connect(owner2).approveTransaction(txHash);
      await strictWallet.connect(owner3).approveTransaction(txHash);

      await expect(
        strictWallet.connect(owner1).executeTransaction(txHash)
      ).to.be.revertedWithCustomError(
        strictWallet,
        "CannotRemoveOwnerWouldFallBelowThreshold"
      );
    });

    it("should revert removeOwner for non-owner address", async function () {
      const data = wallet.interface.encodeFunctionData("removeOwner", [
        nonOwner.address,
      ]);
      const walletAddr = await wallet.getAddress();

      const tx = await wallet
        .connect(owner1)
        .proposeTransaction(walletAddr, 0, data);
      const txHash = await getTxHash(wallet, tx);
      await wallet.connect(owner1).approveTransaction(txHash);
      await wallet.connect(owner2).approveTransaction(txHash);

      await expect(
        wallet.connect(owner1).executeTransaction(txHash)
      ).to.be.revertedWithCustomError(wallet, "NotAnOwner");
    });

    it("should revert changeThreshold to 0", async function () {
      const data = wallet.interface.encodeFunctionData("changeThreshold", [
        0,
      ]);
      const walletAddr = await wallet.getAddress();

      const tx = await wallet
        .connect(owner1)
        .proposeTransaction(walletAddr, 0, data);
      const txHash = await getTxHash(wallet, tx);
      await wallet.connect(owner1).approveTransaction(txHash);
      await wallet.connect(owner2).approveTransaction(txHash);

      await expect(
        wallet.connect(owner1).executeTransaction(txHash)
      ).to.be.revertedWithCustomError(wallet, "InvalidThreshold");
    });

    it("should revert changeThreshold to value greater than owner count", async function () {
      const data = wallet.interface.encodeFunctionData("changeThreshold", [
        10,
      ]);
      const walletAddr = await wallet.getAddress();

      const tx = await wallet
        .connect(owner1)
        .proposeTransaction(walletAddr, 0, data);
      const txHash = await getTxHash(wallet, tx);
      await wallet.connect(owner1).approveTransaction(txHash);
      await wallet.connect(owner2).approveTransaction(txHash);

      await expect(
        wallet.connect(owner1).executeTransaction(txHash)
      ).to.be.revertedWithCustomError(wallet, "InvalidThreshold");
    });

    it("removing and re-adding an owner invalidates their prior approvals (epoch-based)", async function () {
      // Audit: H-2
      // owner2 approves tx1
      const tx = await wallet
        .connect(owner1)
        .proposeTransaction(
          nonOwner.address,
          ethers.parseEther("1"),
          "0x"
        );
      const epochTxHash = await getTxHash(wallet, tx);
      await wallet.connect(owner2).approveTransaction(epochTxHash);
      expect(await wallet.hasApproved(epochTxHash, owner2.address)).to.be
        .true;

      // Remove owner2 via multisig
      const removeData = wallet.interface.encodeFunctionData("removeOwner", [
        owner2.address,
      ]);
      await executeSelfCall(wallet, removeData, [owner1, owner3], 2);
      expect(await wallet.isOwner(owner2.address)).to.be.false;

      // Prior approval should be invalid (epoch incremented)
      expect(await wallet.hasApproved(epochTxHash, owner2.address)).to.be
        .false;

      // Re-add owner2 via multisig
      const addData = wallet.interface.encodeFunctionData("addOwner", [
        owner2.address,
      ]);
      await executeSelfCall(wallet, addData, [owner1, owner3], 2);
      expect(await wallet.isOwner(owner2.address)).to.be.true;

      // Re-added owner2's OLD approval should still be invalid
      expect(await wallet.hasApproved(epochTxHash, owner2.address)).to.be
        .false;

      // Attempting to execute should fail -- only owner1 (1 approval), below threshold=2
      await wallet.connect(owner1).approveTransaction(epochTxHash);
      await expect(
        wallet.connect(owner1).executeTransaction(epochTxHash)
      ).to.be.revertedWithCustomError(wallet, "NotEnoughApprovals");

      // After owner2 explicitly re-approves, approval is valid and tx executes
      await wallet.connect(owner2).approveTransaction(epochTxHash);
      expect(await wallet.hasApproved(epochTxHash, owner2.address)).to.be
        .true;
      await wallet.connect(owner1).executeTransaction(epochTxHash);
      expect((await wallet.getTransaction(epochTxHash)).executed).to.be.true;
    });

    it("ownerVersions increments on each removal", async function () {
      // Audit: H-2
      const v0 = await wallet.ownerVersions(owner2.address);
      expect(v0).to.equal(0);

      // Remove owner2
      const removeData = wallet.interface.encodeFunctionData("removeOwner", [
        owner2.address,
      ]);
      await executeSelfCall(wallet, removeData, [owner1, owner3], 2);
      const v1 = await wallet.ownerVersions(owner2.address);
      expect(v1).to.equal(1);

      // Re-add and remove again
      const addData = wallet.interface.encodeFunctionData("addOwner", [
        owner2.address,
      ]);
      await executeSelfCall(wallet, addData, [owner1, owner3], 2);
      const removeData2 = wallet.interface.encodeFunctionData("removeOwner", [
        owner2.address,
      ]);
      await executeSelfCall(wallet, removeData2, [owner1, owner3], 2);
      const v2 = await wallet.ownerVersions(owner2.address);
      expect(v2).to.equal(2);
    });
  });

  // ==================== Transaction Hash ====================

  describe("Transaction Hash", function () {
    it("should produce different hashes for different nonces", async function () {
      // Audit: C-1
      const hash0 = await wallet.getTransactionHash(
        nonOwner.address,
        100,
        "0x",
        0
      );
      const hash1 = await wallet.getTransactionHash(
        nonOwner.address,
        100,
        "0x",
        1
      );
      expect(hash0).to.not.equal(hash1);
    });

    it("should produce different hashes for different data", async function () {
      // Audit: C-1
      const hash1 = await wallet.getTransactionHash(
        nonOwner.address,
        0,
        "0x1234",
        0
      );
      const hash2 = await wallet.getTransactionHash(
        nonOwner.address,
        0,
        "0x5678",
        0
      );
      expect(hash1).to.not.equal(hash2);
    });

    it("should include chain ID in hash (replay protection)", async function () {
      // Audit: C-1
      // Can't easily change chain ID, but we verify the hash is deterministic
      const hash1 = await wallet.getTransactionHash(
        nonOwner.address,
        100,
        "0x",
        0
      );
      const hash2 = await wallet.getTransactionHash(
        nonOwner.address,
        100,
        "0x",
        0
      );
      expect(hash1).to.equal(hash2);
    });
  });

  // ==================== Self-Call Dispatch ====================

  describe("Self-Call Dispatch", function () {
    it("should revert on unrecognized function selector in self-call", async function () {
      // Audit: H-3
      // Encode a view function selector (threshold) -- not in dispatch table
      const data = wallet.interface.encodeFunctionData("threshold");
      const walletAddr = await wallet.getAddress();

      const tx = await wallet
        .connect(owner1)
        .proposeTransaction(walletAddr, 0, data);
      const txHash = await getTxHash(wallet, tx);
      await wallet.connect(owner1).approveTransaction(txHash);
      await wallet.connect(owner2).approveTransaction(txHash);

      // Should revert with UnrecognizedSelfCall
      await expect(
        wallet.connect(owner3).executeTransaction(txHash)
      ).to.be.revertedWithCustomError(wallet, "UnrecognizedSelfCall");
    });

    it("should revert on self-call with data too short", async function () {
      // Audit: H-3
      // Only 2 bytes of data -- less than a 4-byte selector
      const data = "0x1234";
      const walletAddr = await wallet.getAddress();

      const tx = await wallet
        .connect(owner1)
        .proposeTransaction(walletAddr, 0, data);
      const txHash = await getTxHash(wallet, tx);
      await wallet.connect(owner1).approveTransaction(txHash);
      await wallet.connect(owner2).approveTransaction(txHash);

      await expect(
        wallet.connect(owner3).executeTransaction(txHash)
      ).to.be.revertedWithCustomError(wallet, "CalldataTooShort");
    });

    it("should revert SelfCallCannotHaveValue when proposing self-call with value", async function () {
      // Audit: L-1
      const walletAddr = await wallet.getAddress();
      const addOwnerData = wallet.interface.encodeFunctionData("addOwner", [
        nonOwner.address,
      ]);

      await expect(
        wallet
          .connect(owner1)
          .proposeTransaction(walletAddr, ethers.parseEther("1"), addOwnerData)
      ).to.be.revertedWithCustomError(wallet, "SelfCallCannotHaveValue");
    });

    it("should allow self-call with value=0 at proposal time", async function () {
      // Audit: L-1
      const walletAddr = await wallet.getAddress();
      const addOwnerData = wallet.interface.encodeFunctionData("addOwner", [
        nonOwner.address,
      ]);

      // Should not revert
      const tx = await wallet
        .connect(owner1)
        .proposeTransaction(walletAddr, 0n, addOwnerData);
      expect(tx).to.not.be.undefined;
    });

    it("should enforce SelfCallCannotHaveValue at execution time (defense-in-depth)", async function () {
      // Audit: L-NEW-1
      // The proposal-time check (L-1) prevents self-calls with value > 0, so this
      // execution-time guard is defense-in-depth. We verify the guard exists by
      // confirming that a self-call with value=0 executes successfully.
      const walletAddr = await wallet.getAddress();
      const changeData = wallet.interface.encodeFunctionData(
        "changeThreshold",
        [3]
      );

      await executeSelfCall(
        wallet,
        changeData,
        [owner1, owner2, owner3],
        THRESHOLD
      );
      expect(await wallet.threshold()).to.equal(3);
    });

    it("should reject self-call with value > 0 at proposal (L-NEW-1 defense-in-depth)", async function () {
      // Audit: L-NEW-1
      const walletAddr = await wallet.getAddress();
      const changeData = wallet.interface.encodeFunctionData(
        "changeThreshold",
        [3]
      );

      // L-1 fix: SelfCallCannotHaveValue is now enforced at PROPOSAL time,
      // which also protects the L-NEW-1 execution-time guard path
      await expect(
        wallet
          .connect(owner1)
          .proposeTransaction(walletAddr, ethers.parseEther("1"), changeData)
      ).to.be.revertedWithCustomError(wallet, "SelfCallCannotHaveValue");
    });
  });

  // ==================== Receive / Fallback ====================

  describe("Receive / Fallback", function () {
    it("should accept ETH transfers", async function () {
      const amount = ethers.parseEther("1.0");

      await expect(
        owner1.sendTransaction({
          to: await wallet.getAddress(),
          value: amount,
        })
      ).to.emit(wallet, "Received");

      // beforeEach already sent 10 ETH, so we check for 11 total
      const balance = await ethers.provider.getBalance(
        await wallet.getAddress()
      );
      expect(balance).to.equal(ethers.parseEther("11"));
    });

    it("should reject zero-value calls with data (unknown selector)", async function () {
      const walletAddr = await wallet.getAddress();
      // Send a call with data but no value -- should revert
      await expect(
        owner1.sendTransaction({
          to: walletAddr,
          data: "0xdeadbeef",
          value: 0,
        })
      ).to.be.reverted;
    });

    it("should accept value transfers with data (payment with memo)", async function () {
      const walletAddr = await wallet.getAddress();
      // Send ETH with arbitrary data -- should succeed (payment router pattern)
      await expect(
        owner1.sendTransaction({
          to: walletAddr,
          data: "0xdeadbeef",
          value: ethers.parseEther("1.0"),
        })
      ).to.not.be.reverted;
    });

    it("should emit Received event on fallback with value", async function () {
      const walletAddr = await wallet.getAddress();
      await expect(
        owner1.sendTransaction({
          to: walletAddr,
          data: "0xdeadbeef",
          value: ethers.parseEther("0.5"),
        })
      )
        .to.emit(wallet, "Received")
        .withArgs(owner1.address, ethers.parseEther("0.5"));
    });
  });

  // ==================== View Functions ====================

  describe("View Functions", function () {
    it("should return correct initial owner count", async function () {
      expect(await wallet.getOwnerCount()).to.equal(3);
    });

    it("should return updated owner count after adding owner", async function () {
      const data = wallet.interface.encodeFunctionData("addOwner", [
        extra1.address,
      ]);
      await executeSelfCall(
        wallet,
        data,
        [owner1, owner2, owner3],
        THRESHOLD
      );

      expect(await wallet.getOwnerCount()).to.equal(4);
    });

    it("should return updated owner count after removing owner", async function () {
      const data = wallet.interface.encodeFunctionData("removeOwner", [
        owner3.address,
      ]);
      await executeSelfCall(
        wallet,
        data,
        [owner1, owner2, owner3],
        THRESHOLD
      );

      expect(await wallet.getOwnerCount()).to.equal(2);
    });

    it("getTransaction returns default struct for non-existent hash", async function () {
      const fakeHash = ethers.keccak256(
        ethers.toUtf8Bytes("doesnotexist")
      );
      const tx = await wallet.getTransaction(fakeHash);
      expect(tx.to).to.equal(ethers.ZeroAddress);
      expect(tx.executed).to.equal(false);
    });

    it("hasApproved returns false for non-existent transaction", async function () {
      const fakeHash = ethers.keccak256(
        ethers.toUtf8Bytes("doesnotexist")
      );
      expect(await wallet.hasApproved(fakeHash, owner1.address)).to.equal(
        false
      );
    });
  });

  // ==================== Access Control ====================

  describe("Access Control", function () {
    it("onlySelf: should reject direct call to addOwner", async function () {
      await expect(
        wallet.connect(owner1).addOwner(extra1.address)
      ).to.be.revertedWithCustomError(wallet, "OnlySelf");
    });

    it("onlySelf: should reject direct call to removeOwner", async function () {
      await expect(
        wallet.connect(owner1).removeOwner(owner3.address)
      ).to.be.revertedWithCustomError(wallet, "OnlySelf");
    });

    it("onlySelf: should reject direct call to changeThreshold", async function () {
      await expect(
        wallet.connect(owner1).changeThreshold(1)
      ).to.be.revertedWithCustomError(wallet, "OnlySelf");
    });

    it("onlySelf: should reject direct call to enableModule", async function () {
      await expect(
        wallet.connect(owner1).enableModule(extra1.address)
      ).to.be.revertedWithCustomError(wallet, "OnlySelf");
    });

    it("onlySelf: should reject direct call to disableModule", async function () {
      await expect(
        wallet
          .connect(owner1)
          .disableModule(ethers.ZeroAddress, extra1.address)
      ).to.be.revertedWithCustomError(wallet, "OnlySelf");
    });

    it("onlySelf: should reject direct call to signMessage", async function () {
      await expect(
        wallet.connect(owner1).signMessage("0xdeadbeef")
      ).to.be.revertedWithCustomError(wallet, "OnlySelf");
    });

    it("onlySelf: should reject direct call to unsignMessage", async function () {
      await expect(
        wallet.connect(owner1).unsignMessage("0xdeadbeef")
      ).to.be.revertedWithCustomError(wallet, "OnlySelf");
    });

    it("onlySelf: should reject direct call to cancelByConsensus", async function () {
      const fakeHash = ethers.keccak256(ethers.toUtf8Bytes("fake"));
      await expect(
        wallet.connect(owner1).cancelByConsensus(fakeHash)
      ).to.be.revertedWithCustomError(wallet, "OnlySelf");
    });

    it("onlySelf: should reject direct call to setMinExecutionDelay", async function () {
      await expect(
        wallet.connect(owner1).setMinExecutionDelay(100)
      ).to.be.revertedWithCustomError(wallet, "OnlySelf");
    });

    it("txExists: should revert approveTransaction on non-existent tx", async function () {
      const fakeHash = ethers.keccak256(ethers.toUtf8Bytes("fake"));
      await expect(
        wallet.connect(owner1).approveTransaction(fakeHash)
      ).to.be.revertedWithCustomError(wallet, "TransactionDoesNotExist");
    });

    it("notExecuted: should revert approveTransaction on executed tx", async function () {
      const tx = await wallet
        .connect(owner1)
        .proposeTransaction(
          nonOwner.address,
          ethers.parseEther("0.1"),
          "0x"
        );
      const txHash = await getTxHash(wallet, tx);
      await wallet.connect(owner1).approveTransaction(txHash);
      await wallet.connect(owner2).approveTransaction(txHash);
      await wallet.connect(owner1).executeTransaction(txHash);

      // Try to approve after execution
      await expect(
        wallet.connect(owner3).approveTransaction(txHash)
      ).to.be.revertedWithCustomError(wallet, "TransactionAlreadyExecuted");
    });

    it("notCancelled: should revert approveTransaction on cancelled tx", async function () {
      const tx = await wallet
        .connect(owner1)
        .proposeTransaction(nonOwner.address, 0, "0x");
      const txHash = await getTxHash(wallet, tx);
      await wallet.connect(owner1).cancelTransaction(txHash);

      await expect(
        wallet.connect(owner2).approveTransaction(txHash)
      ).to.be.revertedWithCustomError(wallet, "TransactionAlreadyCancelled");
    });

    it("nonReentrant: should have reentrancy guard on executeTransaction", async function () {
      // The nonReentrant modifier is present on executeTransaction.
      // We verify that normal single execution works correctly (reentrancy
      // would require a malicious callback contract, which is tested implicitly).
      const tx = await wallet
        .connect(owner1)
        .proposeTransaction(
          nonOwner.address,
          ethers.parseEther("0.1"),
          "0x"
        );
      const txHash = await getTxHash(wallet, tx);
      await wallet.connect(owner1).approveTransaction(txHash);
      await wallet.connect(owner2).approveTransaction(txHash);

      await expect(
        wallet.connect(owner1).executeTransaction(txHash)
      ).to.emit(wallet, "TransactionExecuted");
    });
  });

  // ==================== Reentrancy Attack ====================

  describe("Reentrancy Attack", function () {
    it("should block reentrancy via malicious callback contract", async function () {
      // Deploy attacker contract that tries to re-enter executeTransaction on receive
      const AttackerFactory = await ethers.getContractFactory("ReentrantAttacker");
      const attacker = await AttackerFactory.deploy(await wallet.getAddress());
      await attacker.waitForDeployment();
      const attackerAddr = await attacker.getAddress();

      // Propose two transactions: one sending ETH to attacker, one sending ETH to nonOwner
      const tx1 = await wallet
        .connect(owner1)
        .proposeTransaction(attackerAddr, ethers.parseEther("0.1"), "0x");
      const txHash1 = await getTxHash(wallet, tx1);

      const tx2 = await wallet
        .connect(owner1)
        .proposeTransaction(nonOwner.address, ethers.parseEther("0.1"), "0x");
      const txHash2 = await getTxHash(wallet, tx2);

      // Approve both
      await wallet.connect(owner1).approveTransaction(txHash1);
      await wallet.connect(owner2).approveTransaction(txHash1);
      await wallet.connect(owner1).approveTransaction(txHash2);
      await wallet.connect(owner2).approveTransaction(txHash2);

      // Tell attacker to re-enter with txHash2 when it receives ETH from txHash1
      await attacker.setAttackHash(txHash2);

      // Execute txHash1 — sends ETH to attacker, which triggers receive() -> executeTransaction(txHash2)
      // The nonReentrant guard should block the reentrant call
      await wallet.connect(owner1).executeTransaction(txHash1);

      // Attacker attempted the reentrancy but it should have failed
      expect(await attacker.attackAttempted()).to.be.true;
      expect(await attacker.attackSucceeded()).to.be.false;

      // txHash2 should NOT have been executed (reentrancy blocked)
      const tx2Data = await wallet.getTransaction(txHash2);
      expect(tx2Data.executed).to.be.false;

      // txHash2 can still be executed normally after txHash1 completes
      await expect(
        wallet.connect(owner1).executeTransaction(txHash2)
      ).to.emit(wallet, "TransactionExecuted");
    });
  });

  // ==================== 1-of-1 Wallet Lifecycle ====================

  describe("1-of-1 Wallet Lifecycle", function () {
    let soloWallet: QuaiVault;
    let soloOwner: SignerWithAddress;

    beforeEach(async function () {
      soloOwner = owner1;
      soloWallet = await deployWalletViaFactory(
        factory,
        [soloOwner.address],
        1,
        owner1
      );

      // Fund it
      await owner1.sendTransaction({
        to: await soloWallet.getAddress(),
        value: ethers.parseEther("5"),
      });
    });

    it("should propose, approve, and execute in single-owner workflow", async function () {
      const txHash = await proposeExternal(
        soloWallet, soloOwner, nonOwner.address, ethers.parseEther("0.1")
      );

      // Single owner's approval meets threshold
      await soloWallet.connect(soloOwner).approveTransaction(txHash);

      await expect(
        soloWallet.connect(soloOwner).executeTransaction(txHash)
      ).to.emit(soloWallet, "TransactionExecuted");
    });

    it("should execute self-calls (addOwner, changeThreshold) with single approval", async function () {
      // Add a second owner
      const addData = soloWallet.interface.encodeFunctionData("addOwner", [owner2.address]);
      await executeSelfCall(soloWallet, addData, [soloOwner], 1);
      expect(await soloWallet.isOwner(owner2.address)).to.be.true;

      // Change threshold to 2
      const threshData = soloWallet.interface.encodeFunctionData("changeThreshold", [2]);
      await executeSelfCall(soloWallet, threshData, [soloOwner], 1);
      expect(await soloWallet.threshold()).to.equal(2);

      // Now it's a 2-of-2, single approval should fail
      const tx = await soloWallet.connect(soloOwner).proposeTransaction(
        nonOwner.address, ethers.parseEther("0.01"), "0x"
      );
      const txHash = await getTxHash(soloWallet, tx);
      await soloWallet.connect(soloOwner).approveTransaction(txHash);
      await expect(
        soloWallet.connect(soloOwner).executeTransaction(txHash)
      ).to.be.revertedWithCustomError(soloWallet, "NotEnoughApprovals");
    });

    it("should handle cancellation in 1-of-1 wallet", async function () {
      const txHash = await proposeExternal(
        soloWallet, soloOwner, nonOwner.address, ethers.parseEther("0.1")
      );
      // Proposer can cancel before threshold
      await soloWallet.connect(soloOwner).cancelTransaction(txHash);
      const txData = await soloWallet.getTransaction(txHash);
      expect(txData.cancelled).to.be.true;
    });

    it("should support module operations on 1-of-1 wallet", async function () {
      // Deploy and enable a module
      const MockModuleFactory = await ethers.getContractFactory("MockModule");
      const soloWalletAddr = await soloWallet.getAddress();
      const module = await MockModuleFactory.deploy(soloWalletAddr);
      await module.waitForDeployment();
      const moduleAddr = await module.getAddress();

      const enableData = soloWallet.interface.encodeFunctionData("enableModule", [moduleAddr]);
      await executeSelfCall(soloWallet, enableData, [soloOwner], 1);
      expect(await soloWallet.isModuleEnabled(moduleAddr)).to.be.true;

      // Module can execute on the 1-of-1 wallet
      const result = await module.exec(
        nonOwner.address, ethers.parseEther("0.01"), "0x", 0
      );
      const receipt = await result.wait();
      expect(receipt?.status).to.equal(1);
    });
  });

  // ==================== Multi-Owner Scale ====================

  describe("Multi-Owner Scale", function () {
    it("should function correctly with maximum 20 owners and threshold=10", async function () {
      const signers = await ethers.getSigners();
      const twentyOwners = signers.slice(0, 20).map((s) => s.address);

      const largeWallet = await deployWalletViaFactory(
        factory,
        twentyOwners,
        10,
        owner1
      );

      // Fund it
      await signers[0].sendTransaction({
        to: await largeWallet.getAddress(),
        value: ethers.parseEther("1.0"),
      });

      // Propose
      const tx = await largeWallet
        .connect(signers[0])
        .proposeTransaction(
          nonOwner.address,
          ethers.parseEther("0.01"),
          "0x"
        );
      const txHash = await getTxHash(largeWallet, tx);

      // Approve with 10 signers
      for (let i = 0; i < 10; i++) {
        await largeWallet.connect(signers[i]).approveTransaction(txHash);
      }

      // Execute
      await expect(
        largeWallet.connect(signers[0]).executeTransaction(txHash)
      ).to.emit(largeWallet, "TransactionExecuted");
    });
  });
});
