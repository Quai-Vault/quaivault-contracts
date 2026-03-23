import { expect } from "chai";
import { ethers } from "hardhat";
import { QuaiVaultFactory, QuaiVault } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { deployWalletViaFactory } from "./helpers";

describe("QuaiVaultFactory", function () {
  let implementation: QuaiVault;
  let factory: QuaiVaultFactory;
  let owner1: SignerWithAddress;
  let owner2: SignerWithAddress;
  let owner3: SignerWithAddress;
  let nonOwner: SignerWithAddress;

  const THRESHOLD = 2;

  beforeEach(async function () {
    [owner1, owner2, owner3, nonOwner] = await ethers.getSigners();

    // Deploy implementation
    const QuaiVault = await ethers.getContractFactory("QuaiVault");
    implementation = await QuaiVault.deploy();
    await implementation.waitForDeployment();

    // Deploy factory
    const QuaiVaultFactory = await ethers.getContractFactory("QuaiVaultFactory");
    factory = await QuaiVaultFactory.deploy(await implementation.getAddress());
    await factory.waitForDeployment();
  });

  describe("Deployment", function () {
    it("should set implementation address correctly", async function () {
      expect(await factory.implementation()).to.equal(await implementation.getAddress());
    });

    it("should reject zero address implementation", async function () {
      const QuaiVaultFactory = await ethers.getContractFactory("QuaiVaultFactory");
      await expect(
        QuaiVaultFactory.deploy(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(factory, "InvalidImplementationAddress");
    });

    it("should initialize with empty wallet list", async function () {
      expect(await factory.getWalletCount()).to.equal(0);
    });
  });

  describe("createWallet", function () {
    it("should create wallet with correct owners and threshold", async function () {
      const owners = [owner1.address, owner2.address, owner3.address];
      const salt = ethers.randomBytes(32);

      const tx = await factory.connect(owner1).createWallet(owners, THRESHOLD, salt);
      const receipt = await tx.wait();

      // Check event
      const event = receipt?.logs.find(
        (log) => {
          try {
            return factory.interface.parseLog(log as any)?.name === "WalletCreated";
          } catch {
            return false;
          }
        }
      );
      expect(event).to.not.be.undefined;

      const parsedEvent = factory.interface.parseLog(event as any);
      const walletAddress = parsedEvent?.args[0];
      expect(parsedEvent?.args[1]).to.deep.equal(owners);
      expect(parsedEvent?.args[2]).to.equal(THRESHOLD);
      expect(parsedEvent?.args[3]).to.equal(owner1.address);

      // Connect to wallet and verify
      const wallet = await ethers.getContractAt("QuaiVault", walletAddress) as QuaiVault;
      const walletOwners = await wallet.getOwners();
      expect(walletOwners).to.have.lengthOf(3);
      expect(walletOwners).to.include.members(owners);
      expect(await wallet.threshold()).to.equal(THRESHOLD);
    });

    it("should register wallet in factory", async function () {
      const owners = [owner1.address, owner2.address];
      const salt = ethers.randomBytes(32);

      const tx = await factory.connect(owner1).createWallet(owners, 2, salt);
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

      expect(await factory.isWallet(walletAddress)).to.be.true;
      expect(await factory.getWalletCount()).to.equal(1);
      expect(await factory.deployedWallets(0)).to.equal(walletAddress);
    });

    it("should reject empty owners array", async function () {
      const salt = ethers.randomBytes(32);
      await expect(
        factory.connect(owner1).createWallet([], THRESHOLD, salt)
      ).to.be.revertedWithCustomError(factory, "OwnersRequired");
    });

    it("should reject zero threshold", async function () {
      const owners = [owner1.address, owner2.address];
      const salt = ethers.randomBytes(32);
      await expect(
        factory.connect(owner1).createWallet(owners, 0, salt)
      ).to.be.revertedWithCustomError(factory, "InvalidThreshold");
    });

    it("should reject threshold greater than owners", async function () {
      const owners = [owner1.address, owner2.address];
      const salt = ethers.randomBytes(32);
      await expect(
        factory.connect(owner1).createWallet(owners, 3, salt)
      ).to.be.revertedWithCustomError(factory, "InvalidThreshold");
    });

    it("should create multiple wallets", async function () {
      const owners1 = [owner1.address, owner2.address];
      const owners2 = [owner2.address, owner3.address];
      const salt1 = ethers.randomBytes(32);
      const salt2 = ethers.randomBytes(32);

      await factory.connect(owner1).createWallet(owners1, 2, salt1);
      await factory.connect(owner2).createWallet(owners2, 2, salt2);

      expect(await factory.getWalletCount()).to.equal(2);
    });

    it("should use different salts for different wallets", async function () {
      const owners = [owner1.address, owner2.address];
      const salt1 = ethers.randomBytes(32);
      const salt2 = ethers.randomBytes(32);

      const tx1 = await factory.connect(owner1).createWallet(owners, 2, salt1);
      const receipt1 = await tx1.wait();
      const event1 = receipt1?.logs.find(
        (log) => {
          try {
            return factory.interface.parseLog(log as any)?.name === "WalletCreated";
          } catch {
            return false;
          }
        }
      );
      const parsedEvent1 = factory.interface.parseLog(event1 as any);
      const walletAddress1 = parsedEvent1?.args[0];

      const tx2 = await factory.connect(owner1).createWallet(owners, 2, salt2);
      const receipt2 = await tx2.wait();
      const event2 = receipt2?.logs.find(
        (log) => {
          try {
            return factory.interface.parseLog(log as any)?.name === "WalletCreated";
          } catch {
            return false;
          }
        }
      );
      const parsedEvent2 = factory.interface.parseLog(event2 as any);
      const walletAddress2 = parsedEvent2?.args[0];

      expect(walletAddress1).to.not.equal(walletAddress2);
      expect(await factory.getWalletCount()).to.equal(2);
    });

    it("should reject too many owners (>MAX_OWNERS)", async function () {
      // MAX_OWNERS = 20, create array of 21
      const tooManyOwners: string[] = [];
      for (let i = 0; i < 21; i++) {
        tooManyOwners.push(ethers.Wallet.createRandom().address);
      }
      const salt = ethers.randomBytes(32);
      await expect(
        factory.connect(owner1).createWallet(tooManyOwners, 1, salt)
      ).to.be.revertedWithCustomError(factory, "TooManyOwners");
    });

    it("should reject duplicate owners", async function () {
      const salt = ethers.randomBytes(32);
      await expect(
        factory.connect(owner1).createWallet(
          [owner1.address, owner2.address, owner1.address],
          2,
          salt
        )
      ).to.be.revertedWithCustomError(factory, "DuplicateOwner");
    });

    it("should reject zero-address owner", async function () {
      const salt = ethers.randomBytes(32);
      await expect(
        factory.connect(owner1).createWallet(
          [owner1.address, ethers.ZeroAddress],
          1,
          salt
        )
      ).to.be.revertedWithCustomError(factory, "InvalidOwnerAddress");
    });

    // BB-M-2: Factory must also reject SENTINEL as owner
    it("should reject SENTINEL address as owner (BB-M-2)", async function () {
      const SENTINEL = "0x0000000000000000000000000000000000000001";
      const salt = ethers.randomBytes(32);
      await expect(
        factory.connect(owner1).createWallet(
          [owner1.address, SENTINEL],
          1,
          salt
        )
      ).to.be.revertedWithCustomError(factory, "InvalidOwnerAddress");
    });
  });

  describe("createWallet with minExecutionDelay", function () {
    it("should create wallet with 4-param overload (with minExecutionDelay)", async function () {
      const salt = ethers.randomBytes(32);
      const tx = await factory.connect(owner1)
        ["createWallet(address[],uint256,bytes32,uint32)"](
          [owner1.address, owner2.address],
          1,
          salt,
          3600
        );
      const receipt = await tx.wait();

      const event = receipt?.logs.find((log) => {
        try {
          return factory.interface.parseLog(log as any)?.name === "WalletCreated";
        } catch {
          return false;
        }
      });
      const walletAddr = factory.interface.parseLog(event as any)?.args[0];
      const QV = await ethers.getContractFactory("QuaiVault");
      const newWallet = QV.attach(walletAddr) as QuaiVault;

      expect(await newWallet.minExecutionDelay()).to.equal(3600);
    });
  });

  describe("createWallet with initialModules and DelegateCall whitelist (CR-1)", function () {
    it("should create wallet with DelegateCall target whitelisted via 6-param overload", async function () {
      const salt = ethers.randomBytes(32);
      const multiSendAddr = owner3.address; // placeholder target
      const tx = await factory.connect(owner1)
        ["createWallet(address[],uint256,bytes32,uint32,address[],address[])"](
          [owner1.address, owner2.address],
          1,
          salt,
          0,
          [],
          [multiSendAddr]
        );
      const receipt = await tx.wait();

      const event = receipt?.logs.find((log) => {
        try {
          return factory.interface.parseLog(log as any)?.name === "WalletCreated";
        } catch {
          return false;
        }
      });
      const walletAddr = factory.interface.parseLog(event as any)?.args[0];
      const QV = await ethers.getContractFactory("QuaiVault");
      const newWallet = QV.attach(walletAddr) as QuaiVault;

      // Verify state
      expect(await newWallet.delegatecallAllowed(multiSendAddr)).to.equal(true);
      expect(await newWallet.delegatecallAllowed(owner1.address)).to.equal(false);

      // Verify DelegatecallTargetAdded event was emitted during initialization
      const targetAddedEvent = receipt?.logs.find((log) => {
        try {
          return newWallet.interface.parseLog(log as any)?.name === "DelegatecallTargetAdded";
        } catch {
          return false;
        }
      });
      expect(targetAddedEvent).to.not.be.undefined;
      const parsed = newWallet.interface.parseLog(targetAddedEvent as any);
      expect(parsed?.args[0]).to.equal(multiSendAddr);
    });

    it("should create wallet with no DelegateCall targets (empty whitelist)", async function () {
      const salt = ethers.randomBytes(32);
      const tx = await factory.connect(owner1)
        ["createWallet(address[],uint256,bytes32,uint32,address[],address[])"](
          [owner1.address],
          1,
          salt,
          0,
          [],
          []
        );
      const receipt = await tx.wait();

      const event = receipt?.logs.find((log) => {
        try {
          return factory.interface.parseLog(log as any)?.name === "WalletCreated";
        } catch {
          return false;
        }
      });
      const walletAddr = factory.interface.parseLog(event as any)?.args[0];
      const QV = await ethers.getContractFactory("QuaiVault");
      const newWallet = QV.attach(walletAddr) as QuaiVault;

      expect(await newWallet.delegatecallAllowed(owner1.address)).to.equal(false);
    });

    it("3-param and 4-param overloads default to empty DelegateCall whitelist", async function () {
      const salt1 = ethers.randomBytes(32);
      const tx1 = await factory.connect(owner1).createWallet([owner1.address], 1, salt1);
      const receipt1 = await tx1.wait();
      const event1 = receipt1?.logs.find((log) => {
        try { return factory.interface.parseLog(log as any)?.name === "WalletCreated"; } catch { return false; }
      });
      const addr1 = factory.interface.parseLog(event1 as any)?.args[0];
      const QV = await ethers.getContractFactory("QuaiVault");
      const wallet1 = QV.attach(addr1) as QuaiVault;
      expect(await wallet1.delegatecallAllowed(owner1.address)).to.equal(false);

      const salt2 = ethers.randomBytes(32);
      const tx2 = await factory.connect(owner1)
        ["createWallet(address[],uint256,bytes32,uint32)"]([owner1.address], 1, salt2, 3600);
      const receipt2 = await tx2.wait();
      const event2 = receipt2?.logs.find((log) => {
        try { return factory.interface.parseLog(log as any)?.name === "WalletCreated"; } catch { return false; }
      });
      const addr2 = factory.interface.parseLog(event2 as any)?.args[0];
      const wallet2 = QV.attach(addr2) as QuaiVault;
      expect(await wallet2.delegatecallAllowed(owner1.address)).to.equal(false);
    });

    it("should create wallet with initial modules via 5-param overload", async function () {
      const salt = ethers.randomBytes(32);
      const moduleAddr = owner3.address; // placeholder module
      const tx = await factory.connect(owner1)
        ["createWallet(address[],uint256,bytes32,uint32,address[])"](
          [owner1.address, owner2.address],
          1,
          salt,
          0,
          [moduleAddr]
        );
      const receipt = await tx.wait();

      const event = receipt?.logs.find((log) => {
        try {
          return factory.interface.parseLog(log as any)?.name === "WalletCreated";
        } catch {
          return false;
        }
      });
      const walletAddr = factory.interface.parseLog(event as any)?.args[0];
      const QV = await ethers.getContractFactory("QuaiVault");
      const newWallet = QV.attach(walletAddr) as QuaiVault;

      expect(await newWallet.isModuleEnabled(moduleAddr)).to.equal(true);

      // Verify EnabledModule event was emitted during initialization
      const enabledEvent = receipt?.logs.find((log) => {
        try {
          return newWallet.interface.parseLog(log as any)?.name === "EnabledModule";
        } catch {
          return false;
        }
      });
      expect(enabledEvent).to.not.be.undefined;
      const parsed = newWallet.interface.parseLog(enabledEvent as any);
      expect(parsed?.args[0]).to.equal(moduleAddr);
    });
  });

  describe("registerWallet", function () {
    let wallet: QuaiVault;

    beforeEach(async function () {
      // Create a wallet through factory first
      const owners = [owner1.address, owner2.address];
      const salt = ethers.randomBytes(32);
      const tx = await factory.connect(owner1).createWallet(owners, 2, salt);
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
      wallet = await ethers.getContractAt("QuaiVault", walletAddress) as QuaiVault;
    });

    it("should allow owner to register wallet", async function () {
      // Deploy a wallet through a second factory (simulates external deployment)
      const QuaiVaultFactoryContract = await ethers.getContractFactory("QuaiVaultFactory");
      const factory2 = await QuaiVaultFactoryContract.deploy(await implementation.getAddress());
      await factory2.waitForDeployment();

      const owners = [owner1.address, owner2.address];
      const salt = ethers.randomBytes(32);
      const tx2 = await factory2.connect(owner1).createWallet(owners, 2, salt);
      const receipt2 = await tx2.wait();
      const event2 = receipt2?.logs.find((log) => {
        try {
          return factory2.interface.parseLog(log as any)?.name === "WalletCreated";
        } catch { return false; }
      });
      const newWalletAddress = factory2.interface.parseLog(event2 as any)?.args[0];

      // Verify it's not registered on the first factory
      expect(await factory.isWallet(newWalletAddress)).to.be.false;

      // Register it
      const tx = await factory.connect(owner1).registerWallet(newWalletAddress);
      await expect(tx)
        .to.emit(factory, "WalletRegistered")
        .withArgs(newWalletAddress, owner1.address);

      expect(await factory.isWallet(newWalletAddress)).to.be.true;
      // Verify via deployedWallets array (M-1: getWallets() removed)
      const walletCount = await factory.getWalletCount();
      expect(await factory.deployedWallets(Number(walletCount) - 1)).to.equal(newWalletAddress);
    });

    it("should reject registration from non-owner", async function () {
      // Deploy a wallet through a second factory (simulates external deployment)
      const QuaiVaultFactoryContract = await ethers.getContractFactory("QuaiVaultFactory");
      const factory2 = await QuaiVaultFactoryContract.deploy(await implementation.getAddress());
      await factory2.waitForDeployment();

      const owners = [owner1.address, owner2.address];
      const salt = ethers.randomBytes(32);
      const tx2 = await factory2.connect(owner1).createWallet(owners, 2, salt);
      const receipt2 = await tx2.wait();
      const event2 = receipt2?.logs.find((log) => {
        try {
          return factory2.interface.parseLog(log as any)?.name === "WalletCreated";
        } catch { return false; }
      });
      const newWalletAddress = factory2.interface.parseLog(event2 as any)?.args[0];

      await expect(
        factory.connect(nonOwner).registerWallet(newWalletAddress)
      ).to.be.revertedWithCustomError(factory, "CallerIsNotAnOwner");
    });

    it("should reject zero address", async function () {
      await expect(
        factory.connect(owner1).registerWallet(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(factory, "InvalidWalletAddress");
    });

    it("should reject already registered wallet", async function () {
      const walletAddress = await wallet.getAddress();
      await expect(
        factory.connect(owner1).registerWallet(walletAddress)
      ).to.be.revertedWithCustomError(factory, "WalletAlreadyRegistered");
    });
  });

  // M-2: getWalletsByCreator() removed — use WalletCreated event indexing

  describe("registerWallet implementation verification", function () { // Audit: M-3
    it("should reject non-ERC1967-proxy of our implementation", async function () { // Audit: M-3
      // The standalone implementation has no ERC1967 slot / getImplementation() will fail or return wrong value
      const standaloneAddr = await implementation.getAddress();

      // registerWallet checks ERC1967 implementation slot before isOwner
      await expect(
        factory.connect(owner1).registerWallet(standaloneAddr)
      ).to.be.revertedWithCustomError(factory, "InvalidWalletImplementation");
    });

    it("should accept valid ERC1967 proxy from different factory", async function () { // Audit: M-3
      // Create a proxy through a second factory (uses same implementation)
      const QuaiVaultFactoryContract = await ethers.getContractFactory("QuaiVaultFactory");
      const factory2 = await QuaiVaultFactoryContract.deploy(await implementation.getAddress());
      await factory2.waitForDeployment();

      const owners = [owner1.address, owner2.address];
      const salt = ethers.randomBytes(32);
      const tx = await factory2.connect(owner1).createWallet(owners, 2, salt);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log) => {
        try {
          return factory2.interface.parseLog(log as any)?.name === "WalletCreated";
        } catch { return false; }
      });
      const proxyAddr = factory2.interface.parseLog(event as any)?.args[0];

      // This is a valid ERC1967 proxy pointing to our implementation — should succeed
      await expect(factory.connect(owner1).registerWallet(proxyAddr))
        .to.emit(factory, "WalletRegistered");
    });
  });

  describe("predictWalletAddress", function () {
    it("should return deterministic address before creation", async function () {
      const salt = ethers.randomBytes(32);
      const owners = [owner1.address, owner2.address];
      const threshold = 1;
      const minExecutionDelay = 0;

      // Predict address with owners/threshold/delay (needed for constructor proxy bytecodeHash)
      const predicted = await factory.predictWalletAddress(
        owner1.address, salt, owners, threshold, minExecutionDelay, [], []
      );

      // Actually create the wallet using the same salt
      const tx = await factory.connect(owner1).createWallet(owners, threshold, salt);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log) => {
        try {
          return factory.interface.parseLog(log as any)?.name === "WalletCreated";
        } catch {
          return false;
        }
      });
      const actual = factory.interface.parseLog(event as any)?.args[0];

      expect(predicted).to.equal(actual);
    });
  });

  describe("getWalletCount", function () {
    it("should track deployments across multiple creates", async function () {
      const initialCount = await factory.getWalletCount();

      const salt1 = ethers.randomBytes(32);
      await factory.connect(owner1).createWallet([owner1.address], 1, salt1);

      const salt2 = ethers.randomBytes(32);
      await factory.connect(owner1).createWallet([owner2.address], 1, salt2);

      expect(await factory.getWalletCount()).to.equal(initialCount + 2n);
    });
  });
});
