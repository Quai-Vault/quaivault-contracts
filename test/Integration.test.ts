import { expect } from "chai";
import { ethers } from "hardhat";
import { QuaiVault, QuaiVaultFactory, SocialRecoveryModule } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("Integration Tests", function () {
  let implementation: QuaiVault;
  let factory: QuaiVaultFactory;
  let wallet: QuaiVault;
  let socialRecoveryModule: SocialRecoveryModule;
  let owner1: SignerWithAddress;
  let owner2: SignerWithAddress;
  let owner3: SignerWithAddress;
  let recipient: SignerWithAddress;
  let guardian1: SignerWithAddress;
  let guardian2: SignerWithAddress;

  const THRESHOLD = 2;

  beforeEach(async function () {
    [owner1, owner2, owner3, recipient, guardian1, guardian2] = await ethers.getSigners();

    // Deploy implementation
    const QuaiVault = await ethers.getContractFactory("QuaiVault");
    implementation = await QuaiVault.deploy();
    await implementation.waitForDeployment();

    // Deploy factory
    const QuaiVaultFactory = await ethers.getContractFactory("QuaiVaultFactory");
    factory = await QuaiVaultFactory.deploy(await implementation.getAddress());
    await factory.waitForDeployment();

    // Deploy modules
    const SocialRecoveryModule = await ethers.getContractFactory("SocialRecoveryModule");
    socialRecoveryModule = await SocialRecoveryModule.deploy();
    await socialRecoveryModule.waitForDeployment();

    // Create wallet through factory
    const owners = [owner1.address, owner2.address, owner3.address];
    const salt = ethers.randomBytes(32);
    const tx = await factory.connect(owner1).createWallet(owners, THRESHOLD, salt);
    const receipt = await tx.wait();

    const event = receipt?.logs.find(
      (log) => {
        try {
          return factory.interface.parseLog(log as any)?.name === "WalletCreated";
        } catch {
          return false;
        }
      }
    );
    const parsedEvent = factory.interface.parseLog(event as any);
    const walletAddress = parsedEvent?.args[0];
    wallet = QuaiVault.attach(walletAddress) as QuaiVault;

    // Fund wallet
    await owner1.sendTransaction({
      to: await wallet.getAddress(),
      value: ethers.parseEther("100.0"),
    });
  });

  /**
   * Helper to execute a transaction through multisig
   * Proposes, approves, and executes in one call
   */
  async function executeMultisig(to: string, value: bigint, data: string) {
    const proposeTx = await wallet.connect(owner1).proposeTransaction(to, value, data);
    const proposeReceipt = await proposeTx.wait();
    const proposeEvent = proposeReceipt?.logs.find(
      (log) => {
        try {
          return wallet.interface.parseLog(log as any)?.name === "TransactionProposed";
        } catch {
          return false;
        }
      }
    );
    const proposeParsed = wallet.interface.parseLog(proposeEvent as any);
    const txHash = proposeParsed?.args[0];

    await wallet.connect(owner1).approveTransaction(txHash);
    await wallet.connect(owner2).approveTransaction(txHash);
    await wallet.connect(owner3).executeTransaction(txHash);
  }

  async function enableModule(moduleAddress: string) {
    const enableModuleData = wallet.interface.encodeFunctionData("enableModule", [moduleAddress]);
    await executeMultisig(await wallet.getAddress(), 0n, enableModuleData);
  }

  /**
   * Helper to setup social recovery through multisig (H-2 fix)
   */
  async function setupRecoveryViaMultisig(guardians: string[], threshold: number, recoveryPeriod: number) {
    const setupData = socialRecoveryModule.interface.encodeFunctionData("setupRecovery", [
      await wallet.getAddress(),
      guardians,
      threshold,
      recoveryPeriod
    ]);
    await executeMultisig(await socialRecoveryModule.getAddress(), 0n, setupData);
  }

  describe("Factory → Wallet → Modules Flow", function () {
    it("should create wallet, enable module, and use it", async function () {
      // Verify wallet was created
      expect(await factory.isWallet(await wallet.getAddress())).to.be.true;
      const owners = await wallet.getOwners();
      expect(owners).to.have.lengthOf(3);

      // Enable SocialRecoveryModule
      await enableModule(await socialRecoveryModule.getAddress());

      // Verify module is enabled
      expect(await wallet.isModuleEnabled(await socialRecoveryModule.getAddress())).to.be.true;

      // Setup SocialRecoveryModule (H-2 fix: configuration now requires multisig approval)
      const guardians = [guardian1.address, guardian2.address];
      await setupRecoveryViaMultisig(guardians, 2, 1 * 24 * 60 * 60);

      const config = await socialRecoveryModule.getRecoveryConfig(await wallet.getAddress());
      expect(config.guardians).to.deep.equal(guardians);
    });

    it("should reject direct module configuration by single owner (H-2 security fix)", async function () {
      await enableModule(await socialRecoveryModule.getAddress());

      // Single owner should NOT be able to configure modules directly
      await expect(
        socialRecoveryModule.connect(owner1).setupRecovery(await wallet.getAddress(), [guardian1.address], 1, 86400)
      ).to.be.revertedWithCustomError(socialRecoveryModule, "MustBeCalledByWallet");
    });
  });

  describe("Social Recovery Full Flow", function () {
    beforeEach(async function () {
      await enableModule(await socialRecoveryModule.getAddress());
      const guardians = [guardian1.address, guardian2.address];
      // Setup recovery through multisig (H-2 fix)
      await setupRecoveryViaMultisig(guardians, 2, 1 * 24 * 60 * 60);
    });

    it("should complete full recovery flow (H-1 verification)", async function () {
      // This test verifies H-1: that execTransactionFromModule correctly
      // calls owner management functions on the wallet
      const newOwners = [guardian1.address, guardian2.address];

      // Initiate recovery
      const tx = await socialRecoveryModule.connect(guardian1).initiateRecovery(await wallet.getAddress(), newOwners, 2);
      const receipt = await tx.wait();
      const event = receipt?.logs.find(
        (log) => {
          try {
            return socialRecoveryModule.interface.parseLog(log as any)?.name === "RecoveryInitiated";
          } catch {
            return false;
          }
        }
      );
      const parsedEvent = socialRecoveryModule.interface.parseLog(event as any);
      const recoveryHash = parsedEvent?.args[1];

      // Approve recovery
      await socialRecoveryModule.connect(guardian1).approveRecovery(await wallet.getAddress(), recoveryHash);
      await socialRecoveryModule.connect(guardian2).approveRecovery(await wallet.getAddress(), recoveryHash);

      // Fast forward time
      await time.increase(1 * 24 * 60 * 60 + 1);

      // Execute recovery - this uses execTransactionFromModule to call
      // addOwner, removeOwner, and changeThreshold on the wallet
      await socialRecoveryModule.connect(guardian1).executeRecovery(await wallet.getAddress(), recoveryHash);

      // Verify owners changed - this proves execTransactionFromModule works correctly
      const owners = await wallet.getOwners();
      expect(owners).to.have.lengthOf(2);
      expect(owners).to.include.members(newOwners);
      expect(await wallet.threshold()).to.equal(2);

      // Verify old owners are removed
      expect(owners).to.not.include(owner1.address);
      expect(owners).to.not.include(owner2.address);
      expect(owners).to.not.include(owner3.address);
    });

    it("SR-H-1 regression: should recover 3-of-3 vault to 2-of-2 (high-threshold case)", async function () {
      // This is the exact case the SR-H-1 bug breaks.
      // Old order (Add→Remove→ChangeThreshold): removing the 3rd old owner fails because
      //   owners.length - 1 = 2 < threshold (3) at that point.
      // Fixed order (Add→ChangeThreshold→Remove): threshold lowered to 2 before removals,
      //   so all removeOwner calls satisfy owners.length - 1 >= newThreshold (2).

      // Create a separate 3-of-3 vault
      const owners3of3 = [owner1.address, owner2.address, owner3.address];
      const salt3 = ethers.randomBytes(32);
      const tx3 = await factory.connect(owner1).createWallet(owners3of3, 3, salt3);
      const receipt3 = await tx3.wait();
      const event3 = receipt3?.logs.find((log) => {
        try { return factory.interface.parseLog(log as any)?.name === "WalletCreated"; }
        catch { return false; }
      });
      const wallet3of3 = await ethers.getContractAt(
        "QuaiVault",
        factory.interface.parseLog(event3 as any)?.args[0]
      ) as QuaiVault;
      await owner1.sendTransaction({ to: await wallet3of3.getAddress(), value: ethers.parseEther("10") });

      // Helper: execute self-call through the 3-of-3 wallet (requires all 3 approvals)
      async function execSelfCall3(data: string) {
        const addr = await wallet3of3.getAddress();
        const ptx = await wallet3of3.connect(owner1).proposeTransaction(addr, 0, data);
        const prec = await ptx.wait();
        const pev = prec?.logs.find((log: any) => {
          try { return wallet3of3.interface.parseLog(log)?.name === "TransactionProposed"; }
          catch { return false; }
        });
        const ph = wallet3of3.interface.parseLog(pev as any)?.args[0];
        await wallet3of3.connect(owner1).approveTransaction(ph);
        await wallet3of3.connect(owner2).approveTransaction(ph);
        await wallet3of3.connect(owner3).approveTransaction(ph);
        await wallet3of3.connect(owner1).executeTransaction(ph);
      }

      // Enable social recovery module on the 3-of-3 wallet
      const enableData = wallet3of3.interface.encodeFunctionData("enableModule", [await socialRecoveryModule.getAddress()]);
      await execSelfCall3(enableData);

      // Setup recovery via the 3-of-3 wallet (H-2: must be called by wallet)
      const setupData = socialRecoveryModule.interface.encodeFunctionData("setupRecovery", [
        await wallet3of3.getAddress(),
        [guardian1.address, guardian2.address],
        2,       // guardian threshold
        86400,   // 1 day recovery period
      ]);
      const walletAddr3 = await wallet3of3.getAddress();
      const ptx2 = await wallet3of3.connect(owner1).proposeTransaction(await socialRecoveryModule.getAddress(), 0, setupData);
      const prec2 = await ptx2.wait();
      const pev2 = prec2?.logs.find((log: any) => {
        try { return wallet3of3.interface.parseLog(log)?.name === "TransactionProposed"; }
        catch { return false; }
      });
      const ph2 = wallet3of3.interface.parseLog(pev2 as any)?.args[0];
      await wallet3of3.connect(owner1).approveTransaction(ph2);
      await wallet3of3.connect(owner2).approveTransaction(ph2);
      await wallet3of3.connect(owner3).approveTransaction(ph2);
      await wallet3of3.connect(owner1).executeTransaction(ph2);

      // Initiate recovery: replace all 3 old owners with guardian1 + guardian2, threshold=2
      const newOwners = [guardian1.address, guardian2.address];
      const itx = await socialRecoveryModule.connect(guardian1).initiateRecovery(walletAddr3, newOwners, 2);
      const irec = await itx.wait();
      const iev = irec?.logs.find((log: any) => {
        try { return socialRecoveryModule.interface.parseLog(log)?.name === "RecoveryInitiated"; }
        catch { return false; }
      });
      const recoveryHash = socialRecoveryModule.interface.parseLog(iev as any)?.args[1];

      await socialRecoveryModule.connect(guardian1).approveRecovery(walletAddr3, recoveryHash);
      await socialRecoveryModule.connect(guardian2).approveRecovery(walletAddr3, recoveryHash);
      await time.increase(86401);

      // This call FAILS with the old Add→Remove→ChangeThreshold order because
      // the 3rd removeOwner call sees owners.length - 1 = 2 < threshold (3).
      // With the SR-H-1 fix (Add→ChangeThreshold→Remove) it succeeds.
      await socialRecoveryModule.connect(guardian1).executeRecovery(walletAddr3, recoveryHash);

      const finalOwners = await wallet3of3.getOwners();
      expect(finalOwners).to.have.lengthOf(2);
      expect(finalOwners).to.include.members(newOwners);
      expect(await wallet3of3.threshold()).to.equal(2);
      expect(await wallet3of3.isOwner(owner1.address)).to.be.false;
      expect(await wallet3of3.isOwner(owner2.address)).to.be.false;
      expect(await wallet3of3.isOwner(owner3.address)).to.be.false;
    });

    it("should handle partial owner replacement via execTransactionFromModule (H-1)", async function () {
      // Test case where some old owners remain and some are replaced
      // This validates the execTransactionFromModule pattern handles both
      // adding new owners and removing old ones
      const newOwners = [owner1.address, guardian1.address]; // Keep owner1, add guardian1

      // Initiate recovery
      const tx = await socialRecoveryModule.connect(guardian1).initiateRecovery(await wallet.getAddress(), newOwners, 2);
      const receipt = await tx.wait();
      const event = receipt?.logs.find(
        (log) => {
          try {
            return socialRecoveryModule.interface.parseLog(log as any)?.name === "RecoveryInitiated";
          } catch {
            return false;
          }
        }
      );
      const parsedEvent = socialRecoveryModule.interface.parseLog(event as any);
      const recoveryHash = parsedEvent?.args[1];

      // Approve recovery
      await socialRecoveryModule.connect(guardian1).approveRecovery(await wallet.getAddress(), recoveryHash);
      await socialRecoveryModule.connect(guardian2).approveRecovery(await wallet.getAddress(), recoveryHash);

      // Fast forward time
      await time.increase(1 * 24 * 60 * 60 + 1);

      // Execute recovery
      await socialRecoveryModule.connect(guardian1).executeRecovery(await wallet.getAddress(), recoveryHash);

      // Verify owner state
      const owners = await wallet.getOwners();
      expect(owners).to.have.lengthOf(2);
      expect(owners).to.include(owner1.address); // Kept
      expect(owners).to.include(guardian1.address); // Added
      expect(owners).to.not.include(owner2.address); // Removed
      expect(owners).to.not.include(owner3.address); // Removed
      expect(await wallet.threshold()).to.equal(2);
    });
  });
});
