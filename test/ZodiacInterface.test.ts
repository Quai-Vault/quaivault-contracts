import { expect } from "chai";
import { ethers } from "hardhat";
import { QuaiVault, QuaiVaultFactory, MockModule, MultiSend } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { getTxHash, executeSelfCall } from "./helpers";

describe("ZodiacInterface", function () {
  let implementation: QuaiVault;
  let factory: QuaiVaultFactory;
  let wallet: QuaiVault;
  let mockModule: MockModule;
  let multiSend: MultiSend;
  let owner1: SignerWithAddress;
  let owner2: SignerWithAddress;
  let owner3: SignerWithAddress;
  let nonOwner: SignerWithAddress;
  let recipient: SignerWithAddress;

  const THRESHOLD = 2;
  const SENTINEL_MODULES = "0x0000000000000000000000000000000000000001";

  beforeEach(async function () {
    [owner1, owner2, owner3, nonOwner, recipient] = await ethers.getSigners();

    // Deploy implementation
    const QuaiVault = await ethers.getContractFactory("QuaiVault");
    implementation = await QuaiVault.deploy();
    await implementation.waitForDeployment();

    // Deploy factory
    const QuaiVaultFactory = await ethers.getContractFactory("QuaiVaultFactory");
    factory = await QuaiVaultFactory.deploy(await implementation.getAddress());
    await factory.waitForDeployment();

    // Create a wallet through factory
    const owners = [owner1.address, owner2.address, owner3.address];
    const salt = ethers.randomBytes(32);

    const tx = await factory.connect(owner1).createWallet(owners, THRESHOLD, salt);
    const receipt = await tx.wait();

    // Get wallet address from event
    const event = receipt?.logs.find((log) => {
      try {
        return factory.interface.parseLog(log as any)?.name === "WalletCreated";
      } catch {
        return false;
      }
    });

    const parsedEvent = factory.interface.parseLog(event as any);
    const walletAddress = parsedEvent?.args[0];

    // Connect to wallet instance
    wallet = QuaiVault.attach(walletAddress) as QuaiVault;

    // Deploy MockModule pointing to wallet
    const MockModuleFactory = await ethers.getContractFactory("MockModule");
    mockModule = await MockModuleFactory.deploy(walletAddress);
    await mockModule.waitForDeployment();

    // Deploy MultiSend
    const MultiSendFactory = await ethers.getContractFactory("MultiSend");
    multiSend = await MultiSendFactory.deploy();
    await multiSend.waitForDeployment();

    // Fund the wallet
    await owner1.sendTransaction({
      to: walletAddress,
      value: ethers.parseEther("10.0"),
    });
  });

  // Helper to execute wallet self-call through multisig
  async function executeWalletSelfCall(data: string) {
    const proposeTx = await wallet.connect(owner1).proposeTransaction(
      await wallet.getAddress(),
      0,
      data
    );
    const proposeReceipt = await proposeTx.wait();

    const proposeEvent = proposeReceipt?.logs.find((log) => {
      try {
        return wallet.interface.parseLog(log as any)?.name === "TransactionProposed";
      } catch {
        return false;
      }
    });

    const proposeParsed = wallet.interface.parseLog(proposeEvent as any);
    const txHash = proposeParsed?.args[0];

    await wallet.connect(owner1).approveTransaction(txHash);
    await wallet.connect(owner2).approveTransaction(txHash);
    const executeTx = await wallet.connect(owner3).executeTransaction(txHash);

    return { txHash, executeTx };
  }

  describe("Module Linked List Management", function () {
    describe("enableModule", function () {
      it("should enable a module successfully", async function () {
        const enableData = wallet.interface.encodeFunctionData("enableModule", [
          await mockModule.getAddress(),
        ]);

        const { executeTx } = await executeWalletSelfCall(enableData);

        await expect(executeTx)
          .to.emit(wallet, "EnabledModule")
          .withArgs(await mockModule.getAddress());

        expect(await wallet.isModuleEnabled(await mockModule.getAddress())).to.be.true;
      });

      it("should reject zero address", async function () {
        const enableData = wallet.interface.encodeFunctionData("enableModule", [
          ethers.ZeroAddress,
        ]);

        const proposeTx = await wallet.connect(owner1).proposeTransaction(
          await wallet.getAddress(),
          0,
          enableData
        );
        const proposeReceipt = await proposeTx.wait();
        const proposeEvent = proposeReceipt?.logs.find((log) => {
          try {
            return wallet.interface.parseLog(log as any)?.name === "TransactionProposed";
          } catch {
            return false;
          }
        });
        const proposeParsed = wallet.interface.parseLog(proposeEvent as any);
        const txHash = proposeParsed?.args[0];

        await wallet.connect(owner1).approveTransaction(txHash);
        await wallet.connect(owner2).approveTransaction(txHash);

        // Dispatch table propagates specific error from _enableModule
        await expect(wallet.connect(owner3).executeTransaction(txHash))
          .to.be.revertedWithCustomError(wallet, "InvalidModule");
      });

      it("should reject sentinel address", async function () {
        const enableData = wallet.interface.encodeFunctionData("enableModule", [
          SENTINEL_MODULES,
        ]);

        const proposeTx = await wallet.connect(owner1).proposeTransaction(
          await wallet.getAddress(),
          0,
          enableData
        );
        const proposeReceipt = await proposeTx.wait();
        const proposeEvent = proposeReceipt?.logs.find((log) => {
          try {
            return wallet.interface.parseLog(log as any)?.name === "TransactionProposed";
          } catch {
            return false;
          }
        });
        const proposeParsed = wallet.interface.parseLog(proposeEvent as any);
        const txHash = proposeParsed?.args[0];

        await wallet.connect(owner1).approveTransaction(txHash);
        await wallet.connect(owner2).approveTransaction(txHash);

        // Dispatch table propagates specific error from _enableModule
        await expect(wallet.connect(owner3).executeTransaction(txHash))
          .to.be.revertedWithCustomError(wallet, "InvalidModule");
      });

      it("should reject duplicate modules", async function () {
        // Enable module first
        const enableData = wallet.interface.encodeFunctionData("enableModule", [
          await mockModule.getAddress(),
        ]);
        await executeWalletSelfCall(enableData);

        // Try to enable again
        const proposeTx = await wallet.connect(owner1).proposeTransaction(
          await wallet.getAddress(),
          0,
          enableData
        );
        const proposeReceipt = await proposeTx.wait();
        const proposeEvent = proposeReceipt?.logs.find((log) => {
          try {
            return wallet.interface.parseLog(log as any)?.name === "TransactionProposed";
          } catch {
            return false;
          }
        });
        const proposeParsed = wallet.interface.parseLog(proposeEvent as any);
        const txHash = proposeParsed?.args[0];

        await wallet.connect(owner1).approveTransaction(txHash);
        await wallet.connect(owner2).approveTransaction(txHash);

        // Dispatch table propagates specific error from _enableModule
        await expect(wallet.connect(owner3).executeTransaction(txHash))
          .to.be.revertedWithCustomError(wallet, "ModuleAlreadyEnabled");
      });
    });

    describe("disableModule", function () {
      beforeEach(async function () {
        // Enable the module first
        const enableData = wallet.interface.encodeFunctionData("enableModule", [
          await mockModule.getAddress(),
        ]);
        await executeWalletSelfCall(enableData);
      });

      it("should disable a module with correct prevModule", async function () {
        // For first module, prevModule is SENTINEL
        const disableData = wallet.interface.encodeFunctionData("disableModule", [
          SENTINEL_MODULES,
          await mockModule.getAddress(),
        ]);

        const { executeTx } = await executeWalletSelfCall(disableData);

        await expect(executeTx)
          .to.emit(wallet, "DisabledModule")
          .withArgs(await mockModule.getAddress());

        expect(await wallet.isModuleEnabled(await mockModule.getAddress())).to.be.false;
      });

      it("should reject wrong prevModule", async function () {
        // Use owner1 address as wrong prevModule
        const disableData = wallet.interface.encodeFunctionData("disableModule", [
          owner1.address,
          await mockModule.getAddress(),
        ]);

        const proposeTx = await wallet.connect(owner1).proposeTransaction(
          await wallet.getAddress(),
          0,
          disableData
        );
        const proposeReceipt = await proposeTx.wait();
        const proposeEvent = proposeReceipt?.logs.find((log) => {
          try {
            return wallet.interface.parseLog(log as any)?.name === "TransactionProposed";
          } catch {
            return false;
          }
        });
        const proposeParsed = wallet.interface.parseLog(proposeEvent as any);
        const txHash = proposeParsed?.args[0];

        await wallet.connect(owner1).approveTransaction(txHash);
        await wallet.connect(owner2).approveTransaction(txHash);

        // Dispatch table propagates specific error from _disableModule
        await expect(wallet.connect(owner3).executeTransaction(txHash))
          .to.be.revertedWithCustomError(wallet, "InvalidPrevModule");
      });

      it("should reject disabling zero address", async function () {
        const disableData = wallet.interface.encodeFunctionData("disableModule", [
          SENTINEL_MODULES,
          ethers.ZeroAddress,
        ]);

        const proposeTx = await wallet.connect(owner1).proposeTransaction(
          await wallet.getAddress(),
          0,
          disableData
        );
        const proposeReceipt = await proposeTx.wait();
        const proposeEvent = proposeReceipt?.logs.find((log) => {
          try {
            return wallet.interface.parseLog(log as any)?.name === "TransactionProposed";
          } catch {
            return false;
          }
        });
        const proposeParsed = wallet.interface.parseLog(proposeEvent as any);
        const txHash = proposeParsed?.args[0];

        await wallet.connect(owner1).approveTransaction(txHash);
        await wallet.connect(owner2).approveTransaction(txHash);

        // Dispatch table propagates specific error from _disableModule
        await expect(wallet.connect(owner3).executeTransaction(txHash))
          .to.be.revertedWithCustomError(wallet, "InvalidModule");
      });
    });

    describe("isModuleEnabled", function () {
      it("should return false for sentinel address", async function () {
        expect(await wallet.isModuleEnabled(SENTINEL_MODULES)).to.be.false;
      });

      it("should return false for zero address", async function () {
        expect(await wallet.isModuleEnabled(ethers.ZeroAddress)).to.be.false;
      });

      it("should return false for non-enabled module", async function () {
        expect(await wallet.isModuleEnabled(await mockModule.getAddress())).to.be.false;
      });

      it("should return true for enabled module", async function () {
        const enableData = wallet.interface.encodeFunctionData("enableModule", [
          await mockModule.getAddress(),
        ]);
        await executeWalletSelfCall(enableData);

        expect(await wallet.isModuleEnabled(await mockModule.getAddress())).to.be.true;
      });
    });

    describe("getModulesPaginated", function () {
      it("should return empty array for no modules", async function () {
        const [modules, next] = await wallet.getModulesPaginated(SENTINEL_MODULES, 10);
        expect(modules).to.have.lengthOf(0);
        expect(next).to.equal(SENTINEL_MODULES);
      });

      it("should return all modules when pageSize is larger", async function () {
        // Enable 3 modules
        const MockModuleFactory = await ethers.getContractFactory("MockModule");
        const module2 = await MockModuleFactory.deploy(await wallet.getAddress());
        const module3 = await MockModuleFactory.deploy(await wallet.getAddress());

        const enableData1 = wallet.interface.encodeFunctionData("enableModule", [
          await mockModule.getAddress(),
        ]);
        await executeWalletSelfCall(enableData1);

        const enableData2 = wallet.interface.encodeFunctionData("enableModule", [
          await module2.getAddress(),
        ]);
        await executeWalletSelfCall(enableData2);

        const enableData3 = wallet.interface.encodeFunctionData("enableModule", [
          await module3.getAddress(),
        ]);
        await executeWalletSelfCall(enableData3);

        const [modules, next] = await wallet.getModulesPaginated(SENTINEL_MODULES, 10);
        expect(modules).to.have.lengthOf(3);
        expect(next).to.equal(SENTINEL_MODULES);
      });

      it("should paginate correctly when pageSize is smaller", async function () {
        // Enable 3 modules
        const MockModuleFactory = await ethers.getContractFactory("MockModule");
        const module2 = await MockModuleFactory.deploy(await wallet.getAddress());
        const module3 = await MockModuleFactory.deploy(await wallet.getAddress());

        const enableData1 = wallet.interface.encodeFunctionData("enableModule", [
          await mockModule.getAddress(),
        ]);
        await executeWalletSelfCall(enableData1);

        const enableData2 = wallet.interface.encodeFunctionData("enableModule", [
          await module2.getAddress(),
        ]);
        await executeWalletSelfCall(enableData2);

        const enableData3 = wallet.interface.encodeFunctionData("enableModule", [
          await module3.getAddress(),
        ]);
        await executeWalletSelfCall(enableData3);

        // Get first page of 2
        const [page1, next1] = await wallet.getModulesPaginated(SENTINEL_MODULES, 2);
        expect(page1).to.have.lengthOf(2);
        expect(next1).to.not.equal(SENTINEL_MODULES);

        // Get second page using next pointer
        const [page2, next2] = await wallet.getModulesPaginated(page1[1], 2);
        expect(page2).to.have.lengthOf(1);
        expect(next2).to.equal(SENTINEL_MODULES);
      });
    });

    describe("getModules", function () {
      it("should return empty array for no modules", async function () {
        const modules = await wallet.getModules();
        expect(modules).to.have.lengthOf(0);
      });

      it("should return all modules", async function () {
        const enableData = wallet.interface.encodeFunctionData("enableModule", [
          await mockModule.getAddress(),
        ]);
        await executeWalletSelfCall(enableData);

        const modules = await wallet.getModules();
        expect(modules).to.have.lengthOf(1);
        expect(modules[0]).to.equal(await mockModule.getAddress());
      });
    });
  });

  describe("Module Execution", function () {
    beforeEach(async function () {
      // Enable the module
      const enableData = wallet.interface.encodeFunctionData("enableModule", [
        await mockModule.getAddress(),
      ]);
      await executeWalletSelfCall(enableData);
    });

    describe("execTransactionFromModule (4-param)", function () {
      it("should execute Call operation successfully", async function () {
        const amount = ethers.parseEther("1.0");
        const balanceBefore = await ethers.provider.getBalance(recipient.address);

        // Call exec on MockModule which calls execTransactionFromModule on wallet
        await expect(
          mockModule.exec(recipient.address, amount, "0x", 0) // 0 = Call
        ).to.emit(wallet, "ExecutionFromModuleSuccess");

        const balanceAfter = await ethers.provider.getBalance(recipient.address);
        expect(balanceAfter - balanceBefore).to.equal(amount);
      });

      it("should execute DelegateCall operation successfully", async function () {
        // DelegateCall to MultiSend with empty transactions
        const multiSendData = multiSend.interface.encodeFunctionData("multiSend", ["0x"]);

        await expect(
          mockModule.exec(
            await multiSend.getAddress(),
            0,
            multiSendData,
            1 // 1 = DelegateCall
          )
        ).to.emit(wallet, "ExecutionFromModuleSuccess");
      });

      it("should emit ExecutionFromModuleFailure on failed call", async function () {
        // Try to send more ETH than wallet has
        const amount = ethers.parseEther("1000.0");

        await expect(
          mockModule.exec(recipient.address, amount, "0x", 0)
        ).to.emit(wallet, "ExecutionFromModuleFailure");
      });

      it("should return false for zero address destination", async function () {
        // MockModule returns success boolean - check it returns false
        const result = await mockModule.exec.staticCall(ethers.ZeroAddress, 0, "0x", 0);
        expect(result).to.be.false;
      });
    });

    describe("execTransactionFromModule (3-param legacy)", function () {
      it("should execute Call operation successfully", async function () {
        const amount = ethers.parseEther("1.0");
        const balanceBefore = await ethers.provider.getBalance(recipient.address);

        await expect(
          mockModule.execLegacy(recipient.address, amount, "0x")
        ).to.emit(wallet, "ExecutionFromModuleSuccess");

        const balanceAfter = await ethers.provider.getBalance(recipient.address);
        expect(balanceAfter - balanceBefore).to.equal(amount);
      });

      it("should work when called from 4-param function", async function () {
        // The 3-param version should delegate to 4-param with Call operation
        const amount = ethers.parseEther("0.5");
        const balanceBefore = await ethers.provider.getBalance(recipient.address);

        await mockModule.execLegacy(recipient.address, amount, "0x");

        const balanceAfter = await ethers.provider.getBalance(recipient.address);
        expect(balanceAfter - balanceBefore).to.equal(amount);
      });
    });

    describe("execTransactionFromModuleReturnData", function () {
      it("should return call data on success", async function () {
        // Call a view function that returns data
        const thresholdData = wallet.interface.encodeFunctionData("threshold");

        const tx = await mockModule.execReturnData(
          await wallet.getAddress(),
          0,
          thresholdData,
          0 // Call
        );
        const receipt = await tx.wait();

        // Should succeed and emit success event
        expect(receipt?.logs.some((log) => {
          try {
            const parsed = wallet.interface.parseLog(log as any);
            return parsed?.name === "ExecutionFromModuleSuccess";
          } catch {
            return false;
          }
        })).to.be.true;
      });

      it("should return failure data when call fails", async function () {
        // Try to execute with too much ETH
        const amount = ethers.parseEther("1000.0");

        const tx = await mockModule.execReturnData(
          recipient.address,
          amount,
          "0x",
          0
        );
        const receipt = await tx.wait();

        // Should emit failure event
        expect(receipt?.logs.some((log) => {
          try {
            const parsed = wallet.interface.parseLog(log as any);
            return parsed?.name === "ExecutionFromModuleFailure";
          } catch {
            return false;
          }
        })).to.be.true;
      });
    });

    describe("Non-module caller rejection", function () {
      it("should reject calls from non-modules", async function () {
        // Try to call execTransactionFromModule directly without being a module
        await expect(
          wallet.connect(nonOwner)["execTransactionFromModule(address,uint256,bytes,uint8)"](
            recipient.address,
            ethers.parseEther("1.0"),
            "0x",
            0
          )
        ).to.be.revertedWithCustomError(wallet, "NotAnAuthorizedModule");
      });

      it("should reject 3-param calls from non-modules", async function () {
        await expect(
          wallet.connect(nonOwner)["execTransactionFromModule(address,uint256,bytes)"](
            recipient.address,
            ethers.parseEther("1.0"),
            "0x"
          )
        ).to.be.revertedWithCustomError(wallet, "NotAnAuthorizedModule");
      });
    });
  });

  describe("MultiSend Integration", function () {
    beforeEach(async function () {
      // Enable the module
      const enableData = wallet.interface.encodeFunctionData("enableModule", [
        await mockModule.getAddress(),
      ]);
      await executeWalletSelfCall(enableData);
    });

    // Helper to encode a transaction for MultiSend
    function encodeMultiSendTransaction(
      operation: number,
      to: string,
      value: bigint,
      data: string
    ): string {
      const dataBytes = ethers.getBytes(data);
      return ethers.solidityPacked(
        ["uint8", "address", "uint256", "uint256", "bytes"],
        [operation, to, value, dataBytes.length, data]
      );
    }

    it("should execute batched transactions via DelegateCall", async function () {
      const amount = ethers.parseEther("0.5");

      // Encode two simple ETH transfers
      const tx1 = encodeMultiSendTransaction(0, recipient.address, amount, "0x");
      const tx2 = encodeMultiSendTransaction(0, nonOwner.address, amount, "0x");

      const transactions = ethers.concat([tx1, tx2]);
      const multiSendData = multiSend.interface.encodeFunctionData("multiSend", [transactions]);

      const recipientBalanceBefore = await ethers.provider.getBalance(recipient.address);
      const nonOwnerBalanceBefore = await ethers.provider.getBalance(nonOwner.address);

      await mockModule.exec(
        await multiSend.getAddress(),
        0,
        multiSendData,
        1 // DelegateCall
      );

      const recipientBalanceAfter = await ethers.provider.getBalance(recipient.address);
      const nonOwnerBalanceAfter = await ethers.provider.getBalance(nonOwner.address);

      expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(amount);
      expect(nonOwnerBalanceAfter - nonOwnerBalanceBefore).to.equal(amount);
    });

    it("should rollback all transactions if one fails in batch", async function () {
      const amount = ethers.parseEther("0.5");
      const tooMuch = ethers.parseEther("1000.0");

      // First tx will succeed, second will fail
      const tx1 = encodeMultiSendTransaction(0, recipient.address, amount, "0x");
      const tx2 = encodeMultiSendTransaction(0, nonOwner.address, tooMuch, "0x");

      const transactions = ethers.concat([tx1, tx2]);
      const multiSendData = multiSend.interface.encodeFunctionData("multiSend", [transactions]);

      const recipientBalanceBefore = await ethers.provider.getBalance(recipient.address);

      // Execute will fail, should emit failure event
      await expect(
        mockModule.exec(
          await multiSend.getAddress(),
          0,
          multiSendData,
          1 // DelegateCall
        )
      ).to.emit(wallet, "ExecutionFromModuleFailure");

      // First transfer should have been rolled back
      const recipientBalanceAfter = await ethers.provider.getBalance(recipient.address);
      expect(recipientBalanceAfter).to.equal(recipientBalanceBefore);
    });
  });

  describe("Initialize", function () {
    it("should initialize modules linked list with sentinel", async function () {
      // Verify the linked list was initialized by checking getModules returns empty
      const modules = await wallet.getModules();
      expect(modules).to.have.lengthOf(0);

      // And isModuleEnabled returns false for sentinel
      expect(await wallet.isModuleEnabled(SENTINEL_MODULES)).to.be.false;
    });
  });

  // ==================== Module Count & Limits (L-3) ====================

  describe("Module Count & Limits", function () {
    it("should track moduleCount on enable/disable", async function () { // Audit: L-3
      expect(await wallet.moduleCount()).to.equal(0);

      // Enable a module
      const enableData = wallet.interface.encodeFunctionData("enableModule", [
        await mockModule.getAddress(),
      ]);
      await executeWalletSelfCall(enableData);
      expect(await wallet.moduleCount()).to.equal(1);

      // Disable it
      const disableData = wallet.interface.encodeFunctionData("disableModule", [
        SENTINEL_MODULES,
        await mockModule.getAddress(),
      ]);
      await executeWalletSelfCall(disableData);
      expect(await wallet.moduleCount()).to.equal(0);
    });

    it("should reject enabling module when MAX_MODULES (50) reached", async function () {
      // Enable 50 modules, then try the 51st
      for (let i = 0; i < 50; i++) {
        const moduleAddr = ethers.Wallet.createRandom().address;
        const data = wallet.interface.encodeFunctionData("enableModule", [moduleAddr]);
        await executeWalletSelfCall(data);
      }

      // 51st should fail
      const oneMore = ethers.Wallet.createRandom().address;
      const data = wallet.interface.encodeFunctionData("enableModule", [oneMore]);

      const proposeTx = await wallet.connect(owner1).proposeTransaction(
        await wallet.getAddress(), 0, data
      );
      const proposeReceipt = await proposeTx.wait();
      const proposeEvent = proposeReceipt?.logs.find((log: any) => {
        try { return wallet.interface.parseLog(log)?.name === "TransactionProposed"; }
        catch { return false; }
      });
      const txHash = wallet.interface.parseLog(proposeEvent as any)?.args[0];
      await wallet.connect(owner1).approveTransaction(txHash);
      await wallet.connect(owner2).approveTransaction(txHash);

      await expect(
        wallet.connect(owner3).executeTransaction(txHash)
      ).to.be.revertedWithCustomError(wallet, "MaxModulesReached");
    });

    it("should reject disableModule with sentinel address as module", async function () {
      const data = wallet.interface.encodeFunctionData("disableModule", [
        ethers.ZeroAddress,
        SENTINEL_MODULES,
      ]);

      const proposeTx = await wallet.connect(owner1).proposeTransaction(
        await wallet.getAddress(), 0, data
      );
      const proposeReceipt = await proposeTx.wait();
      const proposeEvent = proposeReceipt?.logs.find((log: any) => {
        try { return wallet.interface.parseLog(log)?.name === "TransactionProposed"; }
        catch { return false; }
      });
      const txHash = wallet.interface.parseLog(proposeEvent as any)?.args[0];
      await wallet.connect(owner1).approveTransaction(txHash);
      await wallet.connect(owner2).approveTransaction(txHash);

      await expect(
        wallet.connect(owner3).executeTransaction(txHash)
      ).to.be.revertedWithCustomError(wallet, "InvalidModule");
    });
  });

  // ==================== Module Security ====================

  describe("Module Security", function () {
    it("should reject execTransactionFromModuleReturnData with DelegateCall to zero address", async function () {
      // Enable a signer as a module to test
      const enableData = wallet.interface.encodeFunctionData("enableModule", [nonOwner.address]);
      await executeWalletSelfCall(enableData);

      await expect(
        wallet.connect(nonOwner).execTransactionFromModuleReturnData(
          ethers.ZeroAddress, 0, "0x", 1 // DelegateCall
        )
      ).to.be.revertedWithCustomError(wallet, "InvalidDestinationAddress");
    });

    it("module can enable another module via execTransactionFromModule (Zodiac trust model)", async function () {
      // Enable mockModule
      const enableData = wallet.interface.encodeFunctionData("enableModule", [await mockModule.getAddress()]);
      await executeWalletSelfCall(enableData);
      expect(await wallet.isModuleEnabled(await mockModule.getAddress())).to.be.true;

      // Deploy a second module
      const MockModuleFactory = await ethers.getContractFactory("MockModule");
      const secondModule = await MockModuleFactory.deploy(await wallet.getAddress());
      await secondModule.waitForDeployment();
      const secondModuleAddr = await secondModule.getAddress();

      // mockModule calls execTransactionFromModule to enable secondModule
      // This works because the call goes: mockModule -> wallet.execTransactionFromModule(wallet, 0, enableModule(secondModule))
      // which becomes wallet.call(enableModule(secondModule)) where msg.sender == wallet == address(this)
      const result = await mockModule.tryEnableModule(secondModuleAddr);
      const receipt = await result.wait();
      expect(receipt?.status).to.equal(1);

      // Second module should now be enabled — this is by-design Zodiac trust model
      expect(await wallet.isModuleEnabled(secondModuleAddr)).to.be.true;
    });

    it("module can disable another module via execTransactionFromModule (Zodiac trust model)", async function () {
      // Enable two modules
      const mockModuleAddr = await mockModule.getAddress();
      const MockModuleFactory = await ethers.getContractFactory("MockModule");
      const secondModule = await MockModuleFactory.deploy(await wallet.getAddress());
      await secondModule.waitForDeployment();
      const secondModuleAddr = await secondModule.getAddress();

      const enableData1 = wallet.interface.encodeFunctionData("enableModule", [mockModuleAddr]);
      await executeWalletSelfCall(enableData1);
      const enableData2 = wallet.interface.encodeFunctionData("enableModule", [secondModuleAddr]);
      await executeWalletSelfCall(enableData2);

      expect(await wallet.isModuleEnabled(secondModuleAddr)).to.be.true;

      // Linked list order: SENTINEL -> secondModule -> mockModule
      // To remove secondModule, prevModule must be SENTINEL
      const SENTINEL = "0x0000000000000000000000000000000000000001";
      const result = await mockModule.tryDisableModule(SENTINEL, secondModuleAddr);
      const receipt = await result.wait();
      expect(receipt?.status).to.equal(1);

      expect(await wallet.isModuleEnabled(secondModuleAddr)).to.be.false;
      // mockModule should still be enabled
      expect(await wallet.isModuleEnabled(mockModuleAddr)).to.be.true;
    });

    it("module can call addOwner (required by SocialRecoveryModule)", async function () {
      // Enable nonOwner as a module
      const enableData = wallet.interface.encodeFunctionData("enableModule", [nonOwner.address]);
      await executeWalletSelfCall(enableData);
      expect(await wallet.isModuleEnabled(nonOwner.address)).to.be.true;

      const newAddr = ethers.Wallet.createRandom().address;
      const addNewData = wallet.interface.encodeFunctionData("addOwner", [newAddr]);
      await wallet.connect(nonOwner)["execTransactionFromModule(address,uint256,bytes,uint8)"](
        await wallet.getAddress(), 0n, addNewData, 0
      );
      expect(await wallet.isOwner(newAddr)).to.be.true;
    });
  });
});
