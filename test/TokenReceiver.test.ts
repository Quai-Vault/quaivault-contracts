import { expect } from "chai";
import { ethers } from "hardhat";
import { QuaiVault, QuaiVaultFactory, MockERC721, MockERC1155 } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { getTxHash, executeSelfCall } from "./helpers";

describe("Token Receiver & Signature Interfaces", function () {
  let implementation: QuaiVault;
  let factory: QuaiVaultFactory;
  let wallet: QuaiVault;
  let wallet2: QuaiVault;
  let nft: MockERC721;
  let multiToken: MockERC1155;
  let owner1: SignerWithAddress;
  let owner2: SignerWithAddress;
  let owner3: SignerWithAddress;
  let nonOwner: SignerWithAddress;

  const THRESHOLD = 2;

  // Helper: propose, approve, and execute a transaction through the multisig
  async function executeMultisig(
    to: string,
    value: bigint,
    data: string
  ): Promise<string> {
    const proposeTx = await wallet
      .connect(owner1)
      .proposeTransaction(to, value, data);
    const proposeReceipt = await proposeTx.wait();

    const proposeEvent = proposeReceipt?.logs.find((log) => {
      try {
        return (
          wallet.interface.parseLog(log as any)?.name === "TransactionProposed"
        );
      } catch {
        return false;
      }
    });

    const parsedEvent = wallet.interface.parseLog(proposeEvent as any);
    const txHash = parsedEvent?.args[0];

    await wallet.connect(owner1).approveTransaction(txHash);
    await wallet.connect(owner2).approveTransaction(txHash);
    await wallet.connect(owner3).executeTransaction(txHash);

    return txHash;
  }

  beforeEach(async function () {
    [owner1, owner2, owner3, nonOwner] = await ethers.getSigners();

    // Deploy implementation
    const QuaiVaultContract = await ethers.getContractFactory("QuaiVault");
    implementation = await QuaiVaultContract.deploy();
    await implementation.waitForDeployment();

    // Deploy factory
    const QuaiVaultFactoryContract =
      await ethers.getContractFactory("QuaiVaultFactory");
    factory = await QuaiVaultFactoryContract.deploy(
      await implementation.getAddress()
    );
    await factory.waitForDeployment();

    // Create wallet 1
    const owners = [owner1.address, owner2.address, owner3.address];
    const salt1 = ethers.randomBytes(32);
    const tx1 = await factory
      .connect(owner1)
      .createWallet(owners, THRESHOLD, salt1);
    const receipt1 = await tx1.wait();
    const event1 = receipt1?.logs.find((log) => {
      try {
        return (
          factory.interface.parseLog(log as any)?.name === "WalletCreated"
        );
      } catch {
        return false;
      }
    });
    const walletAddress1 = factory.interface.parseLog(event1 as any)?.args[0];
    wallet = QuaiVaultContract.attach(walletAddress1) as QuaiVault;

    // Create wallet 2 (for cross-vault isolation tests)
    const salt2 = ethers.randomBytes(32);
    const tx2 = await factory
      .connect(owner1)
      .createWallet(owners, THRESHOLD, salt2);
    const receipt2 = await tx2.wait();
    const event2 = receipt2?.logs.find((log) => {
      try {
        return (
          factory.interface.parseLog(log as any)?.name === "WalletCreated"
        );
      } catch {
        return false;
      }
    });
    const walletAddress2 = factory.interface.parseLog(event2 as any)?.args[0];
    wallet2 = QuaiVaultContract.attach(walletAddress2) as QuaiVault;

    // Deploy mock tokens
    const MockERC721Contract = await ethers.getContractFactory("MockERC721");
    nft = await MockERC721Contract.deploy();
    await nft.waitForDeployment();

    const MockERC1155Contract = await ethers.getContractFactory("MockERC1155");
    multiToken = await MockERC1155Contract.deploy();
    await multiToken.waitForDeployment();
  });

  describe("ERC-721 Receiving", function () {
    it("should receive NFTs via safeTransferFrom", async function () {
      const walletAddr = await wallet.getAddress();
      const tokenId = 1;

      // Mint NFT to owner1
      await nft.mint(owner1.address, tokenId);
      expect(await nft.ownerOf(tokenId)).to.equal(owner1.address);

      // safeTransferFrom to vault
      await nft
        .connect(owner1)
      ["safeTransferFrom(address,address,uint256)"](
        owner1.address,
        walletAddr,
        tokenId
      );

      // Vault now owns the NFT
      expect(await nft.ownerOf(tokenId)).to.equal(walletAddr);
    });

    it("should receive NFTs via safeTransferFrom with data", async function () {
      const walletAddr = await wallet.getAddress();
      const tokenId = 2;

      await nft.mint(owner1.address, tokenId);

      await nft
        .connect(owner1)
      ["safeTransferFrom(address,address,uint256,bytes)"](
        owner1.address,
        walletAddr,
        tokenId,
        "0xdeadbeef"
      );

      expect(await nft.ownerOf(tokenId)).to.equal(walletAddr);
    });
  });

  describe("ERC-721 Sending via Multisig", function () {
    it("should send NFTs out of vault via multisig execution", async function () {
      const walletAddr = await wallet.getAddress();
      const tokenId = 1;

      // Mint NFT directly to vault (using regular transferFrom pattern)
      await nft.mint(walletAddr, tokenId);
      expect(await nft.ownerOf(tokenId)).to.equal(walletAddr);

      // Encode transferFrom call
      const transferData = nft.interface.encodeFunctionData("transferFrom", [
        walletAddr,
        nonOwner.address,
        tokenId,
      ]);

      // Execute via multisig
      await executeMultisig(await nft.getAddress(), 0n, transferData);

      // nonOwner now owns the NFT
      expect(await nft.ownerOf(tokenId)).to.equal(nonOwner.address);
    });
  });

  describe("ERC-1155 Receiving", function () {
    it("should receive ERC-1155 tokens via safeTransferFrom", async function () {
      const walletAddr = await wallet.getAddress();
      const tokenId = 1;
      const amount = 100;

      // Mint tokens to owner1
      await multiToken.mint(owner1.address, tokenId, amount, "0x");

      // safeTransferFrom to vault
      await multiToken
        .connect(owner1)
        .safeTransferFrom(owner1.address, walletAddr, tokenId, amount, "0x");

      // Vault holds the tokens
      expect(await multiToken.balanceOf(walletAddr, tokenId)).to.equal(amount);
    });

    it("should receive ERC-1155 tokens via safeBatchTransferFrom", async function () {
      const walletAddr = await wallet.getAddress();
      const ids = [1, 2, 3];
      const amounts = [100, 200, 300];

      // Mint batch to owner1
      for (let i = 0; i < ids.length; i++) {
        await multiToken.mint(owner1.address, ids[i], amounts[i], "0x");
      }

      // safeBatchTransferFrom to vault
      await multiToken
        .connect(owner1)
        .safeBatchTransferFrom(
          owner1.address,
          walletAddr,
          ids,
          amounts,
          "0x"
        );

      // Vault holds all tokens
      for (let i = 0; i < ids.length; i++) {
        expect(await multiToken.balanceOf(walletAddr, ids[i])).to.equal(
          amounts[i]
        );
      }
    });
  });

  describe("ERC-1155 Sending via Multisig", function () {
    it("should send ERC-1155 tokens out of vault via multisig execution", async function () {
      const walletAddr = await wallet.getAddress();
      const tokenId = 1;
      const amount = 50;

      // Mint directly to vault
      await multiToken.mint(walletAddr, tokenId, amount, "0x");

      // Encode safeTransferFrom call
      const transferData = multiToken.interface.encodeFunctionData(
        "safeTransferFrom",
        [walletAddr, nonOwner.address, tokenId, amount, "0x"]
      );

      // Execute via multisig
      await executeMultisig(await multiToken.getAddress(), 0n, transferData);

      // nonOwner now holds the tokens
      expect(await multiToken.balanceOf(nonOwner.address, tokenId)).to.equal(
        amount
      );
      expect(await multiToken.balanceOf(walletAddr, tokenId)).to.equal(0);
    });
  });

  describe("EIP-1271 Signature Validation", function () {
    it("should return 0xffffffff for unsigned hashes", async function () {
      const dataHash = ethers.keccak256(ethers.toUtf8Bytes("unsigned message"));
      const result = await wallet.isValidSignature(dataHash, "0x");
      expect(result).to.equal("0xffffffff");
    });

    it("should sign a message via multisig and validate with isValidSignature", async function () {
      const walletAddr = await wallet.getAddress();
      const messageData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32"],
        [ethers.keccak256(ethers.toUtf8Bytes("hello world"))]
      );

      // Encode signMessage call on the vault itself
      const signMessageData = wallet.interface.encodeFunctionData(
        "signMessage",
        [messageData]
      );

      // Execute signMessage via multisig (self-call)
      await executeMultisig(walletAddr, 0n, signMessageData);

      // Now validate the signature
      const dataHash = ethers.keccak256(ethers.toUtf8Bytes("hello world"));
      const result = await wallet.isValidSignature(dataHash, "0x");
      expect(result).to.equal("0x1626ba7e");
    });

    it("should emit MessageSigned event when signing", async function () {
      const walletAddr = await wallet.getAddress();
      const dataHash = ethers.keccak256(ethers.toUtf8Bytes("test message"));
      const messageData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32"],
        [dataHash]
      );

      const signMessageData = wallet.interface.encodeFunctionData(
        "signMessage",
        [messageData]
      );

      // Propose and approve
      const proposeTx = await wallet
        .connect(owner1)
        .proposeTransaction(walletAddr, 0n, signMessageData);
      const proposeReceipt = await proposeTx.wait();
      const proposeEvent = proposeReceipt?.logs.find((log) => {
        try {
          return (
            wallet.interface.parseLog(log as any)?.name ===
            "TransactionProposed"
          );
        } catch {
          return false;
        }
      });
      const txHash = wallet.interface.parseLog(proposeEvent as any)?.args[0];

      await wallet.connect(owner1).approveTransaction(txHash);
      await wallet.connect(owner2).approveTransaction(txHash);

      // Execute and check for MessageSigned event
      const execTx = await wallet.connect(owner3).executeTransaction(txHash);
      const execReceipt = await execTx.wait();

      const messageSignedEvent = execReceipt?.logs.find((log) => {
        try {
          return (
            wallet.interface.parseLog(log as any)?.name === "MessageSigned"
          );
        } catch {
          return false;
        }
      });

      expect(messageSignedEvent).to.not.be.undefined;
    });

    it("should prevent cross-vault replay (two vaults sign same data, only valid on the signing vault)", async function () {
      const wallet1Addr = await wallet.getAddress();
      const wallet2Addr = await wallet2.getAddress();

      const dataHash = ethers.keccak256(ethers.toUtf8Bytes("shared message"));
      const messageData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32"],
        [dataHash]
      );

      // Sign on wallet1 via multisig
      const signMessageData = wallet.interface.encodeFunctionData(
        "signMessage",
        [messageData]
      );
      await executeMultisig(wallet1Addr, 0n, signMessageData);

      // wallet1 validates it
      expect(await wallet.isValidSignature(dataHash, "0x")).to.equal(
        "0x1626ba7e"
      );

      // wallet2 does NOT validate it (cross-vault replay protection)
      expect(await wallet2.isValidSignature(dataHash, "0x")).to.equal(
        "0xffffffff"
      );
    });

    it("should reject direct signMessage calls (must go through multisig)", async function () {
      const messageData = ethers.toUtf8Bytes("direct call");

      await expect(
        wallet.connect(owner1).signMessage(messageData)
      ).to.be.revertedWithCustomError(wallet, "OnlySelf");
    });
  });

  describe("EIP-165 supportsInterface", function () {
    it("should support IERC165", async function () {
      // IERC165 interface ID: 0x01ffc9a7
      expect(await wallet.supportsInterface("0x01ffc9a7")).to.be.true;
    });

    it("should support IERC721Receiver", async function () {
      // IERC721Receiver interface ID: 0x150b7a02
      expect(await wallet.supportsInterface("0x150b7a02")).to.be.true;
    });

    it("should support IERC1155Receiver", async function () {
      // IERC1155Receiver interface ID: 0x4e2312e0
      expect(await wallet.supportsInterface("0x4e2312e0")).to.be.true;
    });

    it("should support IERC1271", async function () {
      // IERC1271 interface ID: 0x1626ba7e
      expect(await wallet.supportsInterface("0x1626ba7e")).to.be.true;
    });

    it("should not support random interface IDs", async function () {
      expect(await wallet.supportsInterface("0xdeadbeef")).to.be.false;
    });
  });

  describe("EIP-1271 Domain Separator", function () {
    it("should produce different domain separators for different vaults", async function () {
      const ds1 = await wallet.domainSeparator();
      const ds2 = await wallet2.domainSeparator();
      expect(ds1).to.not.equal(ds2);
    });

    it("should include vault address in domain separator", async function () {
      // Verify by computing expected domain separator
      // I-2 fix: typehash now includes name and version fields
      const walletAddr = await wallet.getAddress();
      const chainId = (await ethers.provider.getNetwork()).chainId;

      const expectedDs = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "bytes32", "bytes32", "uint256", "address"],
          [
            ethers.keccak256(
              ethers.toUtf8Bytes(
                "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
              )
            ),
            ethers.keccak256(ethers.toUtf8Bytes("QuaiVault")),
            ethers.keccak256(ethers.toUtf8Bytes("1")),
            chainId,
            walletAddr,
          ]
        )
      );

      expect(await wallet.domainSeparator()).to.equal(expectedDs);
    });
  });

  // ==================== EIP-1271 Message Unsigning (M-NEW-3) ====================

  describe("EIP-1271 Message Unsigning", function () { // Audit: M-NEW-3
    it("should unsign a previously signed message", async function () {
      const message = ethers.toUtf8Bytes("hello world");
      const messageHex = ethers.hexlify(message);

      // Sign the message through multisig
      const signData = wallet.interface.encodeFunctionData("signMessage", [messageHex]);
      await executeSelfCall(wallet, signData, [owner1, owner2, owner3], THRESHOLD);

      // Verify signed
      const msgHash = await wallet.getMessageHash(messageHex);
      expect(await wallet.signedMessages(msgHash)).to.be.true;

      // Unsign through multisig
      const unsignData = wallet.interface.encodeFunctionData("unsignMessage", [messageHex]);
      await executeSelfCall(wallet, unsignData, [owner1, owner2, owner3], THRESHOLD);

      // Verify unsigned
      expect(await wallet.signedMessages(msgHash)).to.be.false;
    });

    it("should emit MessageUnsigned event", async function () {
      const message = ethers.toUtf8Bytes("test message");
      const messageHex = ethers.hexlify(message);

      // Sign first
      const signData = wallet.interface.encodeFunctionData("signMessage", [messageHex]);
      await executeSelfCall(wallet, signData, [owner1, owner2, owner3], THRESHOLD);

      // Unsign — capture the event
      const unsignData = wallet.interface.encodeFunctionData("unsignMessage", [messageHex]);
      const walletAddr = await wallet.getAddress();
      const tx = await wallet.connect(owner1).proposeTransaction(walletAddr, 0, unsignData);
      const txHash = await getTxHash(wallet, tx);
      await wallet.connect(owner1).approveTransaction(txHash);
      await wallet.connect(owner2).approveTransaction(txHash);

      await expect(wallet.connect(owner3).executeTransaction(txHash))
        .to.emit(wallet, "MessageUnsigned");
    });

    it("should make isValidSignature return failure after unsigning", async function () {
      const dataHash = ethers.keccak256(ethers.toUtf8Bytes("some data"));
      const messageHex = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [dataHash]);

      // Sign
      const signData = wallet.interface.encodeFunctionData("signMessage", [messageHex]);
      await executeSelfCall(wallet, signData, [owner1, owner2, owner3], THRESHOLD);

      // Verify valid
      expect(await wallet.isValidSignature(dataHash, "0x")).to.equal("0x1626ba7e");

      // Unsign
      const unsignData = wallet.interface.encodeFunctionData("unsignMessage", [messageHex]);
      await executeSelfCall(wallet, unsignData, [owner1, owner2, owner3], THRESHOLD);

      // Verify invalid
      expect(await wallet.isValidSignature(dataHash, "0x")).to.equal("0xffffffff");
    });

    it("should revert when unsigning a message that was not signed", async function () {
      const message = ethers.toUtf8Bytes("never signed");
      const messageHex = ethers.hexlify(message);

      const unsignData = wallet.interface.encodeFunctionData("unsignMessage", [messageHex]);
      const walletAddr = await wallet.getAddress();
      const tx = await wallet.connect(owner1).proposeTransaction(walletAddr, 0, unsignData);
      const txHash = await getTxHash(wallet, tx);
      await wallet.connect(owner1).approveTransaction(txHash);
      await wallet.connect(owner2).approveTransaction(txHash);

      await expect(
        wallet.connect(owner3).executeTransaction(txHash)
      ).to.be.revertedWithCustomError(wallet, "MessageNotSigned");
    });
  });
});
