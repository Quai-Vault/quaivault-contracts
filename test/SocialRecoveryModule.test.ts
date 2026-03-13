import { expect } from "chai";
import { ethers } from "hardhat";
import { QuaiVault, QuaiVaultFactory, SocialRecoveryModule } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { getTxHash, executeSelfCall, executeMultisig, deployWalletViaFactory, getRecoveryHash } from "./helpers";

describe("SocialRecoveryModule", function () {
  let implementation: QuaiVault;
  let factory: QuaiVaultFactory;
  let wallet: QuaiVault;
  let module: SocialRecoveryModule;
  let owner1: SignerWithAddress;
  let owner2: SignerWithAddress;
  let owner3: SignerWithAddress;
  let guardian1: SignerWithAddress;
  let guardian2: SignerWithAddress;
  let guardian3: SignerWithAddress;
  let nonOwner: SignerWithAddress;
  let extra1: SignerWithAddress;

  const THRESHOLD = 2;
  const RECOVERY_PERIOD = 86400; // 1 day

  beforeEach(async function () {
    [owner1, owner2, owner3, guardian1, guardian2, guardian3, nonOwner, extra1] = await ethers.getSigners();

    // Deploy implementation
    const QuaiVault = await ethers.getContractFactory("QuaiVault");
    implementation = await QuaiVault.deploy();
    await implementation.waitForDeployment();

    // Deploy factory
    const QuaiVaultFactory = await ethers.getContractFactory("QuaiVaultFactory");
    factory = await QuaiVaultFactory.deploy(await implementation.getAddress());
    await factory.waitForDeployment();

    // Create wallet through factory
    wallet = await deployWalletViaFactory(
      factory,
      [owner1.address, owner2.address, owner3.address],
      THRESHOLD,
      owner1
    );

    // Deploy module
    const SocialRecoveryModule = await ethers.getContractFactory("SocialRecoveryModule");
    module = await SocialRecoveryModule.deploy();
    await module.waitForDeployment();

    // Enable module (requires multisig)
    const enableData = wallet.interface.encodeFunctionData("enableModule", [await module.getAddress()]);
    await executeSelfCall(wallet, enableData, [owner1, owner2, owner3], THRESHOLD);
  });

  /**
   * Helper to setup recovery through multisig (H-2 fix)
   */
  async function setupRecoveryViaMultisig(
    guardians: string[],
    threshold: number,
    recoveryPeriod: number
  ) {
    const setupData = module.interface.encodeFunctionData("setupRecovery", [
      await wallet.getAddress(),
      guardians,
      threshold,
      recoveryPeriod,
    ]);
    await executeMultisig(wallet, await module.getAddress(), 0n, setupData, [owner1, owner2, owner3], THRESHOLD);
  }

  /**
   * Helper to call setupRecovery by impersonating the wallet address.
   * Used to test the module's own validation errors directly,
   * bypassing the vault's Option B which swallows external call reverts.
   */
  async function callSetupAsWallet(
    guardians: string[],
    threshold: number,
    recoveryPeriod: number
  ) {
    const walletAddr = await wallet.getAddress();
    await ethers.provider.send("hardhat_impersonateAccount", [walletAddr]);
    const walletSigner = await ethers.getSigner(walletAddr);
    // Fund the impersonated account for gas
    await owner1.sendTransaction({ to: walletAddr, value: ethers.parseEther("1") });

    const promise = module.connect(walletSigner).setupRecovery(
      walletAddr,
      guardians,
      threshold,
      recoveryPeriod
    );

    return promise.finally(async () => {
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [walletAddr]);
    });
  }

  // ==================== setupRecovery (~11 tests) ====================

  describe("setupRecovery", function () {
    it("should set up recovery configuration via multisig", async function () {
      const guardians = [guardian1.address, guardian2.address, guardian3.address];
      const threshold = 2;

      await setupRecoveryViaMultisig(guardians, threshold, RECOVERY_PERIOD);

      const config = await module.getRecoveryConfig(await wallet.getAddress());
      expect(config.guardians).to.deep.equal(guardians);
      expect(config.threshold).to.equal(threshold);
      expect(config.recoveryPeriod).to.equal(RECOVERY_PERIOD);
    });

    // Audit: H-2
    it("should reject setup from single owner (H-2 security fix)", async function () {
      const guardians = [guardian1.address, guardian2.address];
      await expect(
        module.connect(owner1).setupRecovery(await wallet.getAddress(), guardians, 2, RECOVERY_PERIOD)
      ).to.be.revertedWithCustomError(module, "MustBeCalledByWallet");
    });

    it("should reject setup from non-wallet address", async function () {
      const guardians = [guardian1.address, guardian2.address];
      await expect(
        module.connect(nonOwner).setupRecovery(await wallet.getAddress(), guardians, 2, RECOVERY_PERIOD)
      ).to.be.revertedWithCustomError(module, "MustBeCalledByWallet");
    });

    it("should reject empty guardians array", async function () {
      const setupData = module.interface.encodeFunctionData("setupRecovery", [
        await wallet.getAddress(),
        [],
        1,
        RECOVERY_PERIOD,
      ]);

      const proposeTx = await wallet.connect(owner1).proposeTransaction(await module.getAddress(), 0, setupData);
      const txHash = await getTxHash(wallet, proposeTx);
      await wallet.connect(owner1).approveTransaction(txHash);
      await wallet.connect(owner2).approveTransaction(txHash);

      // Execute should emit TransactionFailed (Option B: external call failure never reverts)
      await expect(
        wallet.connect(owner3).executeTransaction(txHash)
      ).to.emit(wallet, "TransactionFailed");
    });

    it("should prevent config update while recovery is pending", async function () {
      const guardians = [guardian1.address, guardian2.address];
      await setupRecoveryViaMultisig(guardians, 2, RECOVERY_PERIOD);

      // Initiate recovery
      const newOwners = [guardian1.address, guardian2.address];
      await module.connect(guardian1).initiateRecovery(await wallet.getAddress(), newOwners, 2);

      // Try to update config via multisig - should fail during execution
      const setupData = module.interface.encodeFunctionData("setupRecovery", [
        await wallet.getAddress(),
        [guardian2.address, guardian3.address],
        2,
        RECOVERY_PERIOD,
      ]);

      const proposeTx = await wallet.connect(owner1).proposeTransaction(await module.getAddress(), 0, setupData);
      const txHash = await getTxHash(wallet, proposeTx);
      await wallet.connect(owner1).approveTransaction(txHash);
      await wallet.connect(owner2).approveTransaction(txHash);

      await expect(
        wallet.connect(owner3).executeTransaction(txHash)
      ).to.emit(wallet, "TransactionFailed");
    });

    // --- Impersonation-based validation tests (CoverageGaps) ---

    it("should reject setup with duplicate guardians (via impersonation)", async function () {
      await expect(
        callSetupAsWallet([guardian1.address, guardian2.address, guardian1.address], 2, RECOVERY_PERIOD)
      ).to.be.revertedWithCustomError(module, "DuplicateGuardian");
    });

    it("should reject setup with zero-address guardian (via impersonation)", async function () {
      await expect(
        callSetupAsWallet([guardian1.address, ethers.ZeroAddress], 1, RECOVERY_PERIOD)
      ).to.be.revertedWithCustomError(module, "InvalidGuardianAddress");
    });

    it("should reject setup with too many guardians (>MAX_GUARDIANS) (via impersonation)", async function () {
      const tooManyGuardians: string[] = [];
      for (let i = 0; i < 21; i++) {
        tooManyGuardians.push(ethers.Wallet.createRandom().address);
      }
      await expect(
        callSetupAsWallet(tooManyGuardians, 1, RECOVERY_PERIOD)
      ).to.be.revertedWithCustomError(module, "TooManyGuardians");
    });

    it("should reject setup with recovery period less than 1 day (via impersonation)", async function () {
      await expect(
        callSetupAsWallet([guardian1.address, guardian2.address], 1, 3600)
      ).to.be.revertedWithCustomError(module, "RecoveryPeriodTooShort");
    });

    it("should reject setup with threshold of 0 (via impersonation)", async function () {
      await expect(
        callSetupAsWallet([guardian1.address, guardian2.address], 0, RECOVERY_PERIOD)
      ).to.be.revertedWithCustomError(module, "InvalidThreshold");
    });

    it("should reject setup with threshold > number of guardians (via impersonation)", async function () {
      await expect(
        callSetupAsWallet([guardian1.address, guardian2.address], 3, RECOVERY_PERIOD)
      ).to.be.revertedWithCustomError(module, "InvalidThreshold");
    });
  });

  // ==================== initiateRecovery (~11 tests) ====================

  describe("initiateRecovery", function () {
    beforeEach(async function () {
      const guardians = [guardian1.address, guardian2.address, guardian3.address];
      await setupRecoveryViaMultisig(guardians, 2, RECOVERY_PERIOD);
    });

    it("should initiate recovery", async function () {
      const newOwners = [guardian1.address, guardian2.address];
      const newThreshold = 2;

      await expect(module.connect(guardian1).initiateRecovery(await wallet.getAddress(), newOwners, newThreshold))
        .to.emit(module, "RecoveryInitiated");

      const nonce = await module.recoveryNonces(await wallet.getAddress());
      expect(nonce).to.equal(1);
    });

    it("should reject initiation from non-guardian", async function () {
      const newOwners = [guardian1.address];
      await expect(
        module.connect(nonOwner).initiateRecovery(await wallet.getAddress(), newOwners, 1)
      ).to.be.revertedWithCustomError(module, "NotAGuardian");
    });

    it("should reject empty new owners", async function () {
      await expect(
        module.connect(guardian1).initiateRecovery(await wallet.getAddress(), [], 1)
      ).to.be.revertedWithCustomError(module, "NewOwnersRequired");
    });

    it("should reject invalid new threshold", async function () {
      const newOwners = [guardian1.address];
      await expect(
        module.connect(guardian1).initiateRecovery(await wallet.getAddress(), newOwners, 2)
      ).to.be.revertedWithCustomError(module, "InvalidThreshold");
    });

    it("should store requiredThreshold at initiation time", async function () {
      const newOwners = [guardian1.address, guardian2.address];
      const nonce = await module.recoveryNonces(await wallet.getAddress());
      const recoveryHash = await module.getRecoveryHash(
        await wallet.getAddress(),
        newOwners,
        2,
        nonce + 1n
      );

      await module.connect(guardian1).initiateRecovery(await wallet.getAddress(), newOwners, 2);

      const recovery = await module.getRecovery(await wallet.getAddress(), recoveryHash);
      expect(recovery.requiredThreshold).to.equal(2); // Should match config threshold
    });

    it("should add recovery to pending list", async function () {
      const newOwners = [guardian1.address, guardian2.address];

      const tx = await module.connect(guardian1).initiateRecovery(await wallet.getAddress(), newOwners, 2);
      const recoveryHash = await getRecoveryHash(module, tx);

      const pendingHashes = await module.getPendingRecoveryHashes(await wallet.getAddress());
      expect(pendingHashes).to.include(recoveryHash);
      expect(await module.hasPendingRecoveries(await wallet.getAddress())).to.be.true;
    });

    // Audit: M-3
    it("should revert InvalidNewOwnerAddress for zero-address in newOwners (M-3)", async function () {
      await expect(
        module.connect(guardian1).initiateRecovery(
          await wallet.getAddress(),
          [ethers.ZeroAddress, guardian2.address],
          1
        )
      ).to.be.revertedWithCustomError(module, "InvalidNewOwnerAddress");
    });

    // Audit: M-3
    it("should revert DuplicateNewOwner for repeated addresses in newOwners (M-3)", async function () {
      await expect(
        module.connect(guardian1).initiateRecovery(
          await wallet.getAddress(),
          [guardian1.address, guardian1.address],
          2
        )
      ).to.be.revertedWithCustomError(module, "DuplicateNewOwner");
    });

    // Audit: M-3
    it("should succeed with valid distinct non-zero newOwners (M-3)", async function () {
      await expect(
        module.connect(guardian1).initiateRecovery(
          await wallet.getAddress(),
          [guardian1.address, guardian2.address],
          2
        )
      ).to.emit(module, "RecoveryInitiated");
    });

    // CoverageGaps: too many newOwners
    it("should reject newOwners exceeding MAX_GUARDIANS", async function () {
      const tooManyNewOwners: string[] = [];
      for (let i = 0; i < 21; i++) {
        tooManyNewOwners.push(ethers.Wallet.createRandom().address);
      }

      await expect(
        module.connect(guardian1).initiateRecovery(
          await wallet.getAddress(),
          tooManyNewOwners,
          1
        )
      ).to.be.revertedWithCustomError(module, "TooManyNewOwners");
    });

    // CoverageGaps: newThreshold=0
    it("should reject newThreshold of 0", async function () {
      await expect(
        module.connect(guardian1).initiateRecovery(
          await wallet.getAddress(),
          [guardian1.address],
          0
        )
      ).to.be.revertedWithCustomError(module, "InvalidThreshold");
    });

    // CoverageGaps: newThreshold > newOwners.length (already covered by "invalid new threshold" above,
    // but this covers a different path with length=1, threshold=5)
  });

  // ==================== H-1: Pending recovery spam cap ====================

  describe("H-1: TooManyPendingRecoveries spam cap", function () {
    beforeEach(async function () {
      const guardians = [guardian1.address, guardian2.address, guardian3.address];
      await setupRecoveryViaMultisig(guardians, 2, RECOVERY_PERIOD);
    });

    // Audit: H-1
    it("should revert after MAX_GUARDIANS (20) concurrent pending recoveries", async function () {
      const walletAddr = await wallet.getAddress();
      const newOwners = [guardian1.address, guardian2.address];

      // Create 20 concurrent pending recoveries (each uses an auto-incrementing nonce)
      for (let i = 0; i < 20; i++) {
        await module.connect(guardian1).initiateRecovery(walletAddr, newOwners, 2);
      }

      // 21st initiation must revert
      await expect(
        module.connect(guardian1).initiateRecovery(walletAddr, newOwners, 2)
      ).to.be.revertedWithCustomError(module, "TooManyPendingRecoveries");
    });

    // Audit: H-1
    it("cancelling a pending recovery allows a new one to be initiated", async function () {
      const walletAddr = await wallet.getAddress();
      const newOwners = [guardian1.address, guardian2.address];

      // Fill pending list to the cap
      for (let i = 0; i < 20; i++) {
        await module.connect(guardian1).initiateRecovery(walletAddr, newOwners, 2);
      }

      // Cancel first pending entry
      const pending = await module.getPendingRecoveryHashes(walletAddr);
      await module.connect(owner1).cancelRecovery(walletAddr, pending[0]);

      // A new initiation should now succeed
      await expect(
        module.connect(guardian1).initiateRecovery(walletAddr, newOwners, 2)
      ).to.emit(module, "RecoveryInitiated");
    });
  });

  // ==================== approveRecovery (~6 tests) ====================

  describe("approveRecovery", function () {
    let recoveryHash: string;
    let newOwners: string[];

    beforeEach(async function () {
      const guardians = [guardian1.address, guardian2.address, guardian3.address];
      await setupRecoveryViaMultisig(guardians, 2, RECOVERY_PERIOD);

      newOwners = [guardian1.address, guardian2.address];
      const tx = await module.connect(guardian1).initiateRecovery(await wallet.getAddress(), newOwners, 2);
      recoveryHash = await getRecoveryHash(module, tx);
    });

    it("should allow guardian to approve recovery", async function () {
      await expect(module.connect(guardian2).approveRecovery(await wallet.getAddress(), recoveryHash))
        .to.emit(module, "RecoveryApproved")
        .withArgs(await wallet.getAddress(), recoveryHash, guardian2.address);

      const recovery = await module.getRecovery(await wallet.getAddress(), recoveryHash);
      expect(recovery.approvalCount).to.equal(1);
    });

    it("should reject approval from non-guardian", async function () {
      await expect(
        module.connect(nonOwner).approveRecovery(await wallet.getAddress(), recoveryHash)
      ).to.be.revertedWithCustomError(module, "NotAGuardian");
    });

    it("should reject duplicate approval", async function () {
      await module.connect(guardian2).approveRecovery(await wallet.getAddress(), recoveryHash);
      await expect(
        module.connect(guardian2).approveRecovery(await wallet.getAddress(), recoveryHash)
      ).to.be.revertedWithCustomError(module, "AlreadyApproved");
    });

    it("should track multiple approvals", async function () {
      await module.connect(guardian2).approveRecovery(await wallet.getAddress(), recoveryHash);
      await module.connect(guardian3).approveRecovery(await wallet.getAddress(), recoveryHash);

      const recovery = await module.getRecovery(await wallet.getAddress(), recoveryHash);
      expect(recovery.approvalCount).to.equal(2);
    });

    // Audit: L-NEW-3
    it("should block approveRecovery when module is disabled (L-NEW-3)", async function () {
      const walletAddr = await wallet.getAddress();
      const moduleAddr = await module.getAddress();

      // Disable the module
      const SENTINEL = "0x0000000000000000000000000000000000000001";
      const disableData = wallet.interface.encodeFunctionData("disableModule", [SENTINEL, moduleAddr]);
      await executeSelfCall(wallet, disableData, [owner1, owner2, owner3], THRESHOLD);

      // Try to approve -- should fail
      await expect(
        module.connect(guardian2).approveRecovery(walletAddr, recoveryHash)
      ).to.be.revertedWithCustomError(module, "ModuleNotEnabled");
    });

    // Audit: L-NEW-3
    it("should allow approveRecovery when module is re-enabled (L-NEW-3)", async function () {
      const walletAddr = await wallet.getAddress();
      const moduleAddr = await module.getAddress();

      // Disable and re-enable
      const SENTINEL = "0x0000000000000000000000000000000000000001";
      const disableData = wallet.interface.encodeFunctionData("disableModule", [SENTINEL, moduleAddr]);
      await executeSelfCall(wallet, disableData, [owner1, owner2, owner3], THRESHOLD);

      const enableData = wallet.interface.encodeFunctionData("enableModule", [moduleAddr]);
      await executeSelfCall(wallet, enableData, [owner1, owner2, owner3], THRESHOLD);

      // Now approve should work
      await module.connect(guardian2).approveRecovery(walletAddr, recoveryHash);

      const recovery = await module.getRecovery(walletAddr, recoveryHash);
      expect(recovery.approvalCount).to.equal(1);
    });
  });

  // ==================== revokeRecoveryApproval (~5 tests) ====================

  describe("revokeRecoveryApproval", function () {
    let recoveryHash: string;

    beforeEach(async function () {
      const guardians = [guardian1.address, guardian2.address, guardian3.address];
      await setupRecoveryViaMultisig(guardians, 2, RECOVERY_PERIOD);

      const tx = await module.connect(guardian1).initiateRecovery(
        await wallet.getAddress(),
        [extra1.address],
        1
      );
      recoveryHash = await getRecoveryHash(module, tx);
    });

    it("should allow guardian to revoke their approval", async function () {
      // Approve first
      await module.connect(guardian1).approveRecovery(await wallet.getAddress(), recoveryHash);

      // Revoke
      await expect(
        module.connect(guardian1).revokeRecoveryApproval(await wallet.getAddress(), recoveryHash)
      ).to.emit(module, "RecoveryApprovalRevoked")
        .withArgs(await wallet.getAddress(), recoveryHash, guardian1.address);

      // Verify approval count decreased
      const recovery = await module.getRecovery(await wallet.getAddress(), recoveryHash);
      expect(recovery.approvalCount).to.equal(0);
    });

    it("should reject revocation from non-guardian", async function () {
      await expect(
        module.connect(nonOwner).revokeRecoveryApproval(await wallet.getAddress(), recoveryHash)
      ).to.be.revertedWithCustomError(module, "NotAGuardian");
    });

    it("should reject revocation when not approved", async function () {
      // Try to revoke without having approved
      await expect(
        module.connect(guardian1).revokeRecoveryApproval(await wallet.getAddress(), recoveryHash)
      ).to.be.revertedWithCustomError(module, "NotApproved");
    });

    it("should reject revocation on executed recovery", async function () {
      // Approve and execute
      await module.connect(guardian1).approveRecovery(await wallet.getAddress(), recoveryHash);
      await module.connect(guardian2).approveRecovery(await wallet.getAddress(), recoveryHash);
      await time.increase(RECOVERY_PERIOD + 1);
      await module.connect(guardian1).executeRecovery(await wallet.getAddress(), recoveryHash);

      // Try to revoke after execution
      await expect(
        module.connect(guardian1).revokeRecoveryApproval(await wallet.getAddress(), recoveryHash)
      ).to.be.revertedWithCustomError(module, "RecoveryAlreadyExecuted");
    });

    it("should prevent execution after approval count drops below threshold", async function () {
      // Two approvals (meets threshold of 2)
      await module.connect(guardian1).approveRecovery(await wallet.getAddress(), recoveryHash);
      await module.connect(guardian2).approveRecovery(await wallet.getAddress(), recoveryHash);

      // Revoke one -- drops below threshold
      await module.connect(guardian2).revokeRecoveryApproval(await wallet.getAddress(), recoveryHash);

      await time.increase(RECOVERY_PERIOD + 1);

      // Should fail -- not enough approvals
      await expect(
        module.connect(guardian1).executeRecovery(await wallet.getAddress(), recoveryHash)
      ).to.be.revertedWithCustomError(module, "NotEnoughApprovals");
    });
  });

  // ==================== executeRecovery (~6 tests) ====================

  describe("executeRecovery", function () {
    let recoveryHash: string;
    let newOwners: string[];

    beforeEach(async function () {
      const guardians = [guardian1.address, guardian2.address, guardian3.address];
      await setupRecoveryViaMultisig(guardians, 2, RECOVERY_PERIOD);

      newOwners = [guardian1.address, guardian2.address];
      const tx = await module.connect(guardian1).initiateRecovery(await wallet.getAddress(), newOwners, 2);
      recoveryHash = await getRecoveryHash(module, tx);

      // Get approvals
      await module.connect(guardian1).approveRecovery(await wallet.getAddress(), recoveryHash);
      await module.connect(guardian2).approveRecovery(await wallet.getAddress(), recoveryHash);
    });

    it("should execute recovery after threshold and time delay", async function () {
      // Fast forward time
      await time.increase(RECOVERY_PERIOD);

      await expect(module.connect(guardian3).executeRecovery(await wallet.getAddress(), recoveryHash))
        .to.emit(module, "RecoveryExecuted")
        .withArgs(await wallet.getAddress(), recoveryHash);

      const recovery = await module.getRecovery(await wallet.getAddress(), recoveryHash);
      expect(recovery.executed).to.be.true;

      // Verify wallet owners changed
      const owners = await wallet.getOwners();
      expect(owners).to.have.lengthOf(2);
      expect(owners).to.include.members(newOwners);
      expect(await wallet.threshold()).to.equal(2);
    });

    it("should use requiredThreshold from initiation time", async function () {
      // Verify the recovery uses the threshold stored at initiation
      const recovery = await module.getRecovery(await wallet.getAddress(), recoveryHash);
      expect(recovery.requiredThreshold).to.equal(2);

      // Fast forward time
      await time.increase(RECOVERY_PERIOD);

      // Should execute with 2 approvals (stored threshold)
      await module.connect(guardian3).executeRecovery(await wallet.getAddress(), recoveryHash);
      const executedRecovery = await module.getRecovery(await wallet.getAddress(), recoveryHash);
      expect(executedRecovery.executed).to.be.true;
    });

    it("should reject execution before time delay", async function () {
      await expect(
        module.connect(guardian3).executeRecovery(await wallet.getAddress(), recoveryHash)
      ).to.be.revertedWithCustomError(module, "RecoveryPeriodNotElapsed");
    });

    it("should reject execution without enough approvals", async function () {
      // Create new recovery with only 1 approval
      const newRecoveryTx = await module.connect(guardian1).initiateRecovery(
        await wallet.getAddress(),
        [guardian1.address],
        1
      );
      const newRecoveryHash = await getRecoveryHash(module, newRecoveryTx);
      await module.connect(guardian1).approveRecovery(await wallet.getAddress(), newRecoveryHash);

      await time.increase(RECOVERY_PERIOD);

      // Try to execute with only 1 approval when threshold is 2
      await expect(
        module.connect(guardian3).executeRecovery(await wallet.getAddress(), newRecoveryHash)
      ).to.be.revertedWithCustomError(module, "NotEnoughApprovals");
    });

    it("should remove recovery from pending list after execution", async function () {
      await time.increase(RECOVERY_PERIOD);
      await module.connect(guardian3).executeRecovery(await wallet.getAddress(), recoveryHash);

      const pendingHashes = await module.getPendingRecoveryHashes(await wallet.getAddress());
      expect(pendingHashes).to.not.include(recoveryHash);
      expect(await module.hasPendingRecoveries(await wallet.getAddress())).to.be.false;
    });

    // CoverageGaps: module disabled rejection
    it("should revert execution if module was disabled after approval", async function () {
      await time.increase(RECOVERY_PERIOD + 1);

      // Disable the module
      const SENTINEL = "0x0000000000000000000000000000000000000001";
      const disableData = wallet.interface.encodeFunctionData("disableModule", [
        SENTINEL,
        await module.getAddress(),
      ]);
      await executeSelfCall(wallet, disableData, [owner1, owner2, owner3], THRESHOLD);

      // Try to execute recovery -- should fail (module disabled)
      await expect(
        module.connect(guardian1).executeRecovery(await wallet.getAddress(), recoveryHash)
      ).to.be.revertedWithCustomError(module, "ModuleNotEnabled");
    });
  });

  // ==================== cancelRecovery (~5 tests) ====================

  describe("cancelRecovery", function () {
    let recoveryHash: string;

    beforeEach(async function () {
      const guardians = [guardian1.address, guardian2.address];
      await setupRecoveryViaMultisig(guardians, 2, RECOVERY_PERIOD);

      const newOwners = [guardian1.address];
      const tx = await module.connect(guardian1).initiateRecovery(await wallet.getAddress(), newOwners, 1);
      recoveryHash = await getRecoveryHash(module, tx);
    });

    it("should allow owner to cancel recovery", async function () {
      await expect(module.connect(owner1).cancelRecovery(await wallet.getAddress(), recoveryHash))
        .to.emit(module, "RecoveryCancelled")
        .withArgs(await wallet.getAddress(), recoveryHash);

      const recovery = await module.getRecovery(await wallet.getAddress(), recoveryHash);
      expect(recovery.executionTime).to.equal(0); // Deleted
    });

    it("should reject cancellation from non-owner", async function () {
      await expect(
        module.connect(nonOwner).cancelRecovery(await wallet.getAddress(), recoveryHash)
      ).to.be.revertedWithCustomError(module, "NotAnOwner");
    });

    it("should remove recovery from pending list after cancellation", async function () {
      await module.connect(owner1).cancelRecovery(await wallet.getAddress(), recoveryHash);

      const pendingHashes = await module.getPendingRecoveryHashes(await wallet.getAddress());
      expect(pendingHashes).to.not.include(recoveryHash);
    });

    // Audit: L-2
    it("should revert RecoveryNotInitiated before reaching isOwner for non-existent recovery (L-2 CEI)", async function () {
      // A recovery hash that was never initiated -- executionTime is 0
      const fakeHash = ethers.keccak256(ethers.toUtf8Bytes("nonexistent-recovery"));

      // After L-2 fix: state check (executionTime==0) fires BEFORE the external isOwner call.
      // So even a nonOwner gets RecoveryNotInitiated, not NotAnOwner.
      await expect(
        module.connect(nonOwner).cancelRecovery(await wallet.getAddress(), fakeHash)
      ).to.be.revertedWithCustomError(module, "RecoveryNotInitiated");
    });

    // Audit: L-2
    it("should revert NotAnOwner only after state checks pass (L-2 CEI - recovery exists)", async function () {
      // State checks pass (recovery exists and is not executed), so it proceeds to isOwner
      await expect(
        module.connect(nonOwner).cancelRecovery(await wallet.getAddress(), recoveryHash)
      ).to.be.revertedWithCustomError(module, "NotAnOwner");
    });

    // CoverageGaps: cancel executed recovery rejection
    it("should reject cancellation of an executed recovery", async function () {
      // Approve and execute the recovery
      await module.connect(guardian1).approveRecovery(await wallet.getAddress(), recoveryHash);
      await module.connect(guardian2).approveRecovery(await wallet.getAddress(), recoveryHash);
      await time.increase(RECOVERY_PERIOD + 1);
      await module.connect(guardian1).executeRecovery(await wallet.getAddress(), recoveryHash);

      // After recovery, guardian1 is now an owner (newOwners was [guardian1.address])
      await expect(
        module.connect(guardian1).cancelRecovery(await wallet.getAddress(), recoveryHash)
      ).to.be.revertedWithCustomError(module, "RecoveryAlreadyExecuted");
    });
  });

  // ==================== View Functions (~2 tests) ====================

  describe("View Functions", function () {
    beforeEach(async function () {
      const guardians = [guardian1.address, guardian2.address];
      await setupRecoveryViaMultisig(guardians, 2, RECOVERY_PERIOD);
    });

    it("should return true for guardian", async function () {
      expect(await module.isGuardian(await wallet.getAddress(), guardian1.address)).to.be.true;
      expect(await module.isGuardian(await wallet.getAddress(), guardian2.address)).to.be.true;
    });

    it("should return false for non-guardian", async function () {
      expect(await module.isGuardian(await wallet.getAddress(), guardian3.address)).to.be.false;
      expect(await module.isGuardian(await wallet.getAddress(), nonOwner.address)).to.be.false;
    });

    // CoverageGaps: predictNextRecoveryHash
    it("should correctly predict the next recovery hash", async function () {
      const walletAddr = await wallet.getAddress();
      const newOwners = [guardian3.address];
      const newThreshold = 1;

      // Predict before initiating
      const predicted = await module.predictNextRecoveryHash(walletAddr, newOwners, newThreshold);

      // Initiate recovery
      const tx = await module.connect(guardian1).initiateRecovery(walletAddr, newOwners, newThreshold);
      const actualHash = await getRecoveryHash(module, tx);

      expect(predicted).to.equal(actualHash);
    });
  });

  // ==================== Edge Cases (~3 tests) ====================

  describe("Edge Cases", function () {
    it("should handle multiple pending recoveries", async function () {
      const guardians = [guardian1.address, guardian2.address];
      await setupRecoveryViaMultisig(guardians, 2, RECOVERY_PERIOD);

      // Initiate first recovery
      await module.connect(guardian1).initiateRecovery(await wallet.getAddress(), [guardian1.address], 1);

      // Cancel first recovery
      const pendingHashes = await module.getPendingRecoveryHashes(await wallet.getAddress());
      await module.connect(owner1).cancelRecovery(await wallet.getAddress(), pendingHashes[0]);

      // Now should allow config update via multisig
      await setupRecoveryViaMultisig([guardian2.address], 1, RECOVERY_PERIOD);

      // Verify new config
      const config = await module.getRecoveryConfig(await wallet.getAddress());
      expect(config.guardians).to.deep.equal([guardian2.address]);
    });

    it("should handle recovery with same owners", async function () {
      const guardians = [guardian1.address, guardian2.address];
      await setupRecoveryViaMultisig(guardians, 2, RECOVERY_PERIOD);

      // Initiate recovery with same owners (should still work)
      const currentOwners = [...await wallet.getOwners()];
      const tx = await module.connect(guardian1).initiateRecovery(await wallet.getAddress(), currentOwners, THRESHOLD);
      const recoveryHash = await getRecoveryHash(module, tx);

      await module.connect(guardian1).approveRecovery(await wallet.getAddress(), recoveryHash);
      await module.connect(guardian2).approveRecovery(await wallet.getAddress(), recoveryHash);

      await time.increase(RECOVERY_PERIOD);
      await module.connect(guardian1).executeRecovery(await wallet.getAddress(), recoveryHash);

      // Owners should remain the same
      const ownersAfter = await wallet.getOwners();
      expect(ownersAfter).to.deep.equal(currentOwners);
    });

    it("should lock threshold at recovery initiation time", async function () {
      const guardians = [guardian1.address, guardian2.address, guardian3.address];
      await setupRecoveryViaMultisig(guardians, 2, RECOVERY_PERIOD);

      const newOwners = [guardian1.address, guardian2.address];
      const tx = await module.connect(guardian1).initiateRecovery(await wallet.getAddress(), newOwners, 2);
      const recoveryHash = await getRecoveryHash(module, tx);

      const recovery = await module.getRecovery(await wallet.getAddress(), recoveryHash);
      expect(recovery.requiredThreshold).to.equal(2);

      // Config updates are blocked while recovery is pending (tested in setupRecovery tests)
      // Even if we could change config, recovery should still use old threshold

      // Get approvals with stored threshold (2)
      await module.connect(guardian1).approveRecovery(await wallet.getAddress(), recoveryHash);
      await module.connect(guardian2).approveRecovery(await wallet.getAddress(), recoveryHash);

      await time.increase(RECOVERY_PERIOD);

      // Should execute with 2 approvals (stored threshold at initiation)
      await module.connect(guardian3).executeRecovery(await wallet.getAddress(), recoveryHash);
      const executedRecovery = await module.getRecovery(await wallet.getAddress(), recoveryHash);
      expect(executedRecovery.executed).to.be.true;
    });
  });

  // ==================== M-1: Stale expired entries blocking new recovery ====================

  describe("M-1: Stale expired entries cleanup in setupRecovery", function () {
    it("should allow setupRecovery after all pending recoveries expire (cleans stale entries)", async function () {
      const guardians = [guardian1.address, guardian2.address, guardian3.address];
      await setupRecoveryViaMultisig(guardians, 2, RECOVERY_PERIOD);

      const walletAddr = await wallet.getAddress();

      // Fill pendingRecoveryHashes with MAX_GUARDIANS (20) expired recoveries
      // Use guardian1 to initiate all of them
      const recoveryHashes: string[] = [];
      for (let i = 0; i < 20; i++) {
        const newOwners = [guardian1.address, guardian2.address];
        const tx = await module.connect(guardian1).initiateRecovery(walletAddr, newOwners, 2);
        const receipt = await tx.wait();
        const event = receipt?.logs.find((log) => {
          try {
            return module.interface.parseLog(log as any)?.name === "RecoveryInitiated";
          } catch {
            return false;
          }
        });
        const parsed = module.interface.parseLog(event as any);
        recoveryHashes.push(parsed!.args.recoveryHash);
      }

      // Verify we're at MAX_GUARDIANS pending
      const pending = await module.getPendingRecoveryHashes(walletAddr);
      expect(pending.length).to.equal(20);

      // Trying to initiate another should fail (TooManyPendingRecoveries)
      await expect(
        module.connect(guardian1).initiateRecovery(walletAddr, [guardian1.address], 1)
      ).to.be.revertedWithCustomError(module, "TooManyPendingRecoveries");

      // Fast-forward past expiration (recoveryPeriod * 2 = execution wait + execution window)
      await time.increase(RECOVERY_PERIOD * 2 + 1);

      // hasPendingRecoveries should return false (all expired)
      expect(await module.hasPendingRecoveries(walletAddr)).to.be.false;

      // setupRecovery should succeed and clean up stale entries (M-1 fix)
      // Reconfigure with same guardians
      await setupRecoveryViaMultisig(guardians, 2, RECOVERY_PERIOD);

      // Verify stale entries were cleaned up
      const pendingAfter = await module.getPendingRecoveryHashes(walletAddr);
      expect(pendingAfter.length).to.equal(0);

      // Now initiateRecovery should work again
      const tx = await module.connect(guardian1).initiateRecovery(walletAddr, [guardian1.address, guardian2.address], 2);
      const receipt = await tx.wait();
      expect(receipt?.status).to.equal(1);

      const pendingFinal = await module.getPendingRecoveryHashes(walletAddr);
      expect(pendingFinal.length).to.equal(1);
    });
  });
});
