/**
 * Create a new QuaiVault wallet via QuaiVaultFactory
 *
 * Uses CREATE2 for deterministic deployment with a mined salt that produces
 * a valid shard-prefixed address (0x00 for cyprus1).
 *
 * Usage:
 *   npx hardhat run scripts/create-wallet.ts --network cyprus1
 *
 * Environment variables:
 *   CYPRUS1_PK - Private key for deployment
 *   QUAIVAULT_IMPLEMENTATION - QuaiVault implementation address
 *   QUAIVAULT_FACTORY - QuaiVaultFactory address
 *
 * Optional:
 *   WALLET_OWNERS - Comma-separated list of owner addresses (defaults to deployer)
 *   WALLET_THRESHOLD - Number of required approvals (defaults to 1)
 *   WALLET_MIN_DELAY - Minimum execution delay in seconds for external calls (defaults to 0 = simple quorum)
 */

import hre from "hardhat";
import * as quais from "quais";
import { HttpNetworkConfig } from "hardhat/types";

const QuaiVaultFactoryJson = require("../artifacts/contracts/QuaiVaultFactory.sol/QuaiVaultFactory.json");
const QuaiVaultJson = require("../artifacts/contracts/QuaiVault.sol/QuaiVault.json");
const QuaiVaultProxyJson = require("../artifacts/contracts/QuaiVaultProxy.sol/QuaiVaultProxy.json");

// Shard prefix for the target network
const TARGET_PREFIX = "0x00"; // cyprus1

// Maximum salt mining attempts
const MAX_MINING_ATTEMPTS = 100000;

/**
 * Mine for a CREATE2 salt that produces a valid Quai address with the target prefix.
 *
 * The salt must account for QuaiVaultFactory's internal salt computation:
 *   fullSalt = keccak256(abi.encodePacked(msg.sender, userSalt))
 *
 * The resulting address must:
 *   1. Start with the target shard prefix (e.g., 0x00 for cyprus1)
 *   2. Pass quais.isQuaiAddress() validation
 */
async function mineSalt(
  factoryAddress: string,
  senderAddress: string,
  implementation: string,
  owners: string[],
  threshold: number,
  minExecutionDelay: number = 0
): Promise<{ salt: string; expectedAddress: string }> {
  console.log(`Mining for valid Quai address with ${TARGET_PREFIX} prefix (max ${MAX_MINING_ATTEMPTS} attempts)...`);

  // ERC1967 constructor proxy creation code
  // bytecodeHash = keccak256(QuaiVaultProxy.creationCode ++ abi.encode(implementation, initData))
  const quaiVaultIface = new quais.Interface(QuaiVaultJson.abi);
  const initData = quaiVaultIface.encodeFunctionData("initialize", [
    owners, threshold, minExecutionDelay,
  ]);
  const abiCoder = quais.AbiCoder.defaultAbiCoder();
  const constructorArgs = abiCoder.encode(
    ["address", "bytes"],
    [implementation, initData]
  );
  const creationCode = QuaiVaultProxyJson.bytecode + constructorArgs.slice(2);
  const bytecodeHash = quais.keccak256(creationCode);

  const startTime = Date.now();

  for (let i = 0; i < MAX_MINING_ATTEMPTS; i++) {
    const userSalt = quais.hexlify(quais.randomBytes(32));

    // Compute full salt as QuaiVaultFactory does
    const fullSalt = quais.keccak256(
      quais.solidityPacked(["address", "bytes32"], [senderAddress, userSalt])
    );

    // Compute CREATE2 address
    const create2Address = quais.getCreate2Address(factoryAddress, fullSalt, bytecodeHash);

    // Check both prefix AND valid Quai address
    if (
      create2Address.toLowerCase().startsWith(TARGET_PREFIX.toLowerCase()) &&
      quais.isQuaiAddress(create2Address)
    ) {
      const elapsed = (Date.now() - startTime) / 1000;
      console.log(`Found valid salt after ${i + 1} attempts (${elapsed.toFixed(2)}s)`);
      return { salt: userSalt, expectedAddress: create2Address };
    }

    if ((i + 1) % 10000 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      console.log(`  ${i + 1} attempts, ${(i / elapsed).toFixed(0)} salts/sec...`);
    }
  }

  throw new Error(`Could not find valid salt after ${MAX_MINING_ATTEMPTS} attempts`);
}

async function main() {
  console.log("Creating new QuaiVault wallet...\n");
  console.log("Network:", hre.network.name);

  const networkConfig = hre.network.config as HttpNetworkConfig;
  const provider = new quais.JsonRpcProvider(
    networkConfig.url,
    undefined,
    { usePathing: true }
  );

  const accounts = networkConfig.accounts as string[];
  if (!accounts || !accounts[0]) {
    throw new Error("No account configured. Set CYPRUS1_PK in .env");
  }

  const wallet = new quais.Wallet(accounts[0].trim(), provider);
  console.log("Deployer:", wallet.address);

  const implAddress = process.env.QUAIVAULT_IMPLEMENTATION;
  const factoryAddress = process.env.QUAIVAULT_FACTORY;

  if (!implAddress) {
    throw new Error("QUAIVAULT_IMPLEMENTATION not set in .env");
  }
  if (!factoryAddress) {
    throw new Error("QUAIVAULT_FACTORY not set in .env");
  }

  console.log("Implementation:", implAddress);
  console.log("QuaiVaultFactory:", factoryAddress);

  // Parse owners from env or use deployer as single owner
  const ownersEnv = process.env.WALLET_OWNERS;
  const owners = ownersEnv
    ? ownersEnv.split(",").map(a => a.trim())
    : [wallet.address];

  // Parse threshold from env or default to 1
  const threshold = parseInt(process.env.WALLET_THRESHOLD || "1");

  // Parse minimum execution delay from env or default to 0 (simple quorum)
  const minExecutionDelay = parseInt(process.env.WALLET_MIN_DELAY || "0");

  console.log("\nWallet Configuration:");
  console.log("  Owners:", owners);
  console.log("  Threshold:", threshold);
  console.log("  Min Execution Delay:", minExecutionDelay > 0 ? `${minExecutionDelay}s` : "0 (simple quorum)");

  // Validate
  if (owners.length === 0) {
    throw new Error("At least one owner required");
  }
  if (threshold === 0 || threshold > owners.length) {
    throw new Error(`Invalid threshold: ${threshold} (owners: ${owners.length})`);
  }

  // Warn about non-cyprus1 owners
  for (const owner of owners) {
    if (!owner.toLowerCase().startsWith("0x00")) {
      console.warn(`  Warning: Owner ${owner} may not be on cyprus1`);
    }
  }

  // Mine for valid salt
  console.log("\n--- Mining CREATE2 Salt ---");
  const { salt, expectedAddress } = await mineSalt(
    factoryAddress,
    wallet.address,
    implAddress,
    owners,
    threshold,
    minExecutionDelay
  );

  console.log("Salt:", salt);
  console.log("Expected address:", expectedAddress);
  console.log("Valid Quai Address? ", quais.isQuaiAddress(expectedAddress));

  // Deploy via QuaiVaultFactory
  console.log("\n--- Creating Wallet via QuaiVaultFactory ---");

  const factory = new quais.Contract(factoryAddress, QuaiVaultFactoryJson.abi, wallet);

  // Estimate gas (for reporting only)
  console.log("\nEstimating gas...");
  try {
    let estimatedGas;
    if (minExecutionDelay > 0) {
      estimatedGas = await factory["createWallet(address[],uint256,bytes32,uint32)"].estimateGas(
        owners, threshold, salt, minExecutionDelay
      );
    } else {
      estimatedGas = await factory.createWallet.estimateGas(owners, threshold, salt);
    }
    console.log("Estimated gas:", estimatedGas.toString());
  } catch (err: any) {
    console.warn("Gas estimation failed:", err.message || err);
  }

  console.log("\nSending transaction...");
  let tx;
  if (minExecutionDelay > 0) {
    tx = await factory["createWallet(address[],uint256,bytes32,uint32)"](
      owners, threshold, salt, minExecutionDelay
    );
  } else {
    tx = await factory.createWallet(owners, threshold, salt);
  }

  console.log("TX hash:", tx.hash);
  console.log("Waiting for confirmation...");

  const receipt = await tx.wait();

  if (receipt?.status !== 1) {
    throw new Error(`Transaction failed with status: ${receipt?.status}`);
  }

  console.log("Gas used:", receipt.gasUsed.toString());

  // Parse WalletCreated event
  let walletAddress = "";
  for (const log of receipt.logs) {
    try {
      const parsed = factory.interface.parseLog(log as any);
      if (parsed?.name === "WalletCreated") {
        walletAddress = parsed.args[0];
        break;
      }
    } catch {}
  }

  if (!walletAddress) {
    throw new Error("Could not find WalletCreated event in receipt");
  }

  console.log("\nWallet created:", walletAddress);
  console.log("Matches expected:", walletAddress.toLowerCase() === expectedAddress.toLowerCase());

  // Verify the wallet
  console.log("\n--- Verifying Wallet ---");
  const vault = new quais.Contract(walletAddress, QuaiVaultJson.abi, provider);

  const vaultOwners = await vault.getOwners();
  const vaultThreshold = await vault.threshold();
  const vaultNonce = await vault.nonce();
  const vaultDelay = await vault.minExecutionDelay();
  const isRegistered = await factory.isWallet(walletAddress);
  const totalWallets = await factory.getWalletCount();

  console.log("  Owners:", vaultOwners.join(", "));
  console.log("  Threshold:", vaultThreshold.toString());
  console.log("  Min Execution Delay:", vaultDelay.toString(), "seconds");
  console.log("  Nonce:", vaultNonce.toString());
  console.log("  Registered in factory:", isRegistered);
  console.log("  Total factory wallets:", totalWallets.toString());

  // Verify address prefix
  if (walletAddress.toLowerCase().startsWith("0x00")) {
    console.log("  Address prefix: 0x00 (cyprus1)");
  } else {
    console.warn(`  Warning: Unexpected prefix ${walletAddress.substring(0, 4)}`);
  }

  console.log("\n🎉 Done!");
  console.log("\nYour new QuaiVault:");
  console.log(`  Address: ${walletAddress}`);
  console.log(`  Owners: ${owners.join(", ")}`);
  console.log(`  Threshold: ${threshold}`);
  if (minExecutionDelay > 0) {
    console.log(`  Min Execution Delay: ${minExecutionDelay}s`);
  }

  return walletAddress;
}

main()
  .then((address) => {
    console.log(`\nWALLET_ADDRESS=${address}`);
    process.exit(0);
  })
  .catch((error) => {
    console.error("\nError:", error.message || error);
    process.exit(1);
  });
