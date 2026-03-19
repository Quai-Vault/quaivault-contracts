import hre from "hardhat";
import * as quais from "quais";
import * as fs from "fs";
import * as path from "path";
import * as deployMetadata from "@quai/hardhat-deploy-metadata";
import { HttpNetworkConfig } from "hardhat/types";

// Import compiled contract artifacts
const QuaiVaultJson = require("../artifacts/contracts/QuaiVault.sol/QuaiVault.json");
const QuaiVaultFactoryJson = require("../artifacts/contracts/QuaiVaultFactory.sol/QuaiVaultFactory.json");
const SocialRecoveryModuleJson = require("../artifacts/contracts/modules/SocialRecoveryModule.sol/SocialRecoveryModule.json");
const MultiSendCallOnlyJson = require("../artifacts/contracts/libraries/MultiSendCallOnly.sol/MultiSendCallOnly.json");

// Optional: deploy MockModule for on-chain testing (set DEPLOY_MOCK_MODULE=true)
const DEPLOY_MOCK_MODULE = process.env.DEPLOY_MOCK_MODULE === "true";

async function main() {
  console.log("Starting deployment to Quai Network...\n");
  console.log("Network:", hre.network.name);

  const networkConfig = hre.network.config as HttpNetworkConfig;
  console.log("RPC URL:", networkConfig.url);

  // Set up provider and wallet
  const provider = new quais.JsonRpcProvider(
    networkConfig.url,
    undefined,
    { usePathing: true }
  );

  const accounts = networkConfig.accounts as string[];
  
  if (!accounts || accounts.length === 0 || !accounts[0]) {
    throw new Error(
      "CYPRUS1_PK not set in .env file. Please set CYPRUS1_PK=your_private_key in the root .env file."
    );
  }
  
  // Ensure private key is properly formatted (remove any whitespace, ensure it starts with 0x)
  let privateKey = accounts[0].trim();
  if (!privateKey.startsWith('0x')) {
    privateKey = '0x' + privateKey;
  }
  
  if (privateKey.length !== 66) {
    throw new Error(
      `Invalid private key length: ${privateKey.length} (expected 66 characters including 0x prefix). ` +
      `Please check your CYPRUS1_PK in the .env file.`
    );
  }
  
  const wallet = new quais.Wallet(
    privateKey,
    provider
  );

  console.log("Deploying with account:", wallet.address);

  const balance = await provider.getBalance(wallet.address);
  console.log("Account balance:", quais.formatQuai(balance), "QUAI\n");

  // Deploy QuaiVault implementation
  console.log("Deploying QuaiVault implementation...");

  // Get IPFS hash from bytecode before deployment
  const implementationIpfsHash = await hre.deployMetadata.pushMetadataToIPFSWithBytecode(
    QuaiVaultJson.bytecode
  );
  console.log("Metadata IPFS hash:", implementationIpfsHash);

  const QuaiVault = new quais.ContractFactory(
    QuaiVaultJson.abi,
    QuaiVaultJson.bytecode,
    wallet,
    implementationIpfsHash
  );

  const implementation = await QuaiVault.deploy();
  await implementation.waitForDeployment();
  const implementationAddress = await implementation.getAddress();
  console.log("Transaction hash:", implementation.deploymentTransaction()?.hash);
  console.log("QuaiVault implementation deployed to:", implementationAddress);

  // Deploy QuaiVaultFactory
  console.log("\nDeploying QuaiVaultFactory...");

  const factoryIpfsHash = await hre.deployMetadata.pushMetadataToIPFSWithBytecode(
    QuaiVaultFactoryJson.bytecode
  );
  console.log("Metadata IPFS hash:", factoryIpfsHash);

  const QuaiVaultFactory = new quais.ContractFactory(
    QuaiVaultFactoryJson.abi,
    QuaiVaultFactoryJson.bytecode,
    wallet,
    factoryIpfsHash
  );

  const factory = await QuaiVaultFactory.deploy(implementationAddress);
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log("Transaction hash:", factory.deploymentTransaction()?.hash);
  console.log("QuaiVaultFactory deployed to:", factoryAddress);

  // Deploy SocialRecoveryModule
  console.log("\nDeploying SocialRecoveryModule...");

  const socialRecoveryIpfsHash = await hre.deployMetadata.pushMetadataToIPFSWithBytecode(
    SocialRecoveryModuleJson.bytecode
  );
  console.log("Metadata IPFS hash:", socialRecoveryIpfsHash);

  const SocialRecoveryModule = new quais.ContractFactory(
    SocialRecoveryModuleJson.abi,
    SocialRecoveryModuleJson.bytecode,
    wallet,
    socialRecoveryIpfsHash
  );

  const socialRecovery = await SocialRecoveryModule.deploy();
  await socialRecovery.waitForDeployment();
  const socialRecoveryAddress = await socialRecovery.getAddress();
  console.log("Transaction hash:", socialRecovery.deploymentTransaction()?.hash);
  console.log("SocialRecoveryModule deployed to:", socialRecoveryAddress);

  // Deploy MultiSendCallOnly (Call-only batching — no nested DelegateCall)
  console.log("\nDeploying MultiSendCallOnly...");

  const multiSendCallOnlyIpfsHash = await hre.deployMetadata.pushMetadataToIPFSWithBytecode(
    MultiSendCallOnlyJson.bytecode
  );
  console.log("Metadata IPFS hash:", multiSendCallOnlyIpfsHash);

  const MultiSendCallOnly = new quais.ContractFactory(
    MultiSendCallOnlyJson.abi,
    MultiSendCallOnlyJson.bytecode,
    wallet,
    multiSendCallOnlyIpfsHash
  );

  const multiSendCallOnly = await MultiSendCallOnly.deploy();
  await multiSendCallOnly.waitForDeployment();
  const multiSendCallOnlyAddress = await multiSendCallOnly.getAddress();
  console.log("Transaction hash:", multiSendCallOnly.deploymentTransaction()?.hash);
  console.log("MultiSendCallOnly deployed to:", multiSendCallOnlyAddress);

  // Deploy test contracts (optional — for on-chain testing only, set DEPLOY_MOCK_MODULE=true)
  let mockModuleAddress = "";
  let mockModuleIpfsHash = "";
  let mockERC721Address = "";
  let mockERC721IpfsHash = "";
  let mockERC1155Address = "";
  let mockERC1155IpfsHash = "";
  if (DEPLOY_MOCK_MODULE) {
    // MockModule
    console.log("\nDeploying MockModule (testing)...");
    const MockModuleJson = require("../artifacts/contracts/test/MockModule.sol/MockModule.json");

    mockModuleIpfsHash = await hre.deployMetadata.pushMetadataToIPFSWithBytecode(
      MockModuleJson.bytecode
    );
    console.log("Metadata IPFS hash:", mockModuleIpfsHash);

    const MockModule = new quais.ContractFactory(
      MockModuleJson.abi,
      MockModuleJson.bytecode,
      wallet,
      mockModuleIpfsHash
    );

    // MockModule requires a target address - use deployer as placeholder
    const mockModule = await MockModule.deploy(wallet.address);
    await mockModule.waitForDeployment();
    mockModuleAddress = await mockModule.getAddress();
    console.log("Transaction hash:", mockModule.deploymentTransaction()?.hash);
    console.log("MockModule deployed to:", mockModuleAddress);

    // MockERC721
    console.log("\nDeploying MockERC721 (testing)...");
    const MockERC721Json = require("../artifacts/contracts/test/MockERC721.sol/MockERC721.json");

    mockERC721IpfsHash = await hre.deployMetadata.pushMetadataToIPFSWithBytecode(
      MockERC721Json.bytecode
    );
    console.log("Metadata IPFS hash:", mockERC721IpfsHash);

    const MockERC721 = new quais.ContractFactory(
      MockERC721Json.abi,
      MockERC721Json.bytecode,
      wallet,
      mockERC721IpfsHash
    );

    const mockERC721 = await MockERC721.deploy();
    await mockERC721.waitForDeployment();
    mockERC721Address = await mockERC721.getAddress();
    console.log("Transaction hash:", mockERC721.deploymentTransaction()?.hash);
    console.log("MockERC721 deployed to:", mockERC721Address);

    // MockERC1155
    console.log("\nDeploying MockERC1155 (testing)...");
    const MockERC1155Json = require("../artifacts/contracts/test/MockERC1155.sol/MockERC1155.json");

    mockERC1155IpfsHash = await hre.deployMetadata.pushMetadataToIPFSWithBytecode(
      MockERC1155Json.bytecode
    );
    console.log("Metadata IPFS hash:", mockERC1155IpfsHash);

    const MockERC1155 = new quais.ContractFactory(
      MockERC1155Json.abi,
      MockERC1155Json.bytecode,
      wallet,
      mockERC1155IpfsHash
    );

    const mockERC1155 = await MockERC1155.deploy();
    await mockERC1155.waitForDeployment();
    mockERC1155Address = await mockERC1155.getAddress();
    console.log("Transaction hash:", mockERC1155.deploymentTransaction()?.hash);
    console.log("MockERC1155 deployed to:", mockERC1155Address);
  }

  // Save deployment addresses
  const deployment: any = {
    network: hre.network.name,
    chainId: (await provider.getNetwork()).chainId.toString(),
    deployer: wallet.address,
    timestamp: new Date().toISOString(),
    contracts: {
      QuaiVault: implementationAddress,
      QuaiVaultFactory: factoryAddress,
      SocialRecoveryModule: socialRecoveryAddress,
      MultiSendCallOnly: multiSendCallOnlyAddress,
    },
    ipfsHashes: {
      QuaiVault: implementationIpfsHash,
      QuaiVaultFactory: factoryIpfsHash,
      SocialRecoveryModule: socialRecoveryIpfsHash,
      MultiSendCallOnly: multiSendCallOnlyIpfsHash,
    },
  };

  // Add test contracts to deployment if deployed
  if (DEPLOY_MOCK_MODULE) {
    if (mockModuleAddress) {
      deployment.contracts.MockModule = mockModuleAddress;
      deployment.ipfsHashes.MockModule = mockModuleIpfsHash;
    }
    if (mockERC721Address) {
      deployment.contracts.MockERC721 = mockERC721Address;
      deployment.ipfsHashes.MockERC721 = mockERC721IpfsHash;
    }
    if (mockERC1155Address) {
      deployment.contracts.MockERC1155 = mockERC1155Address;
      deployment.ipfsHashes.MockERC1155 = mockERC1155IpfsHash;
    }
  }

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir);
  }

  const deploymentFile = path.join(
    deploymentsDir,
    `deployment-${hre.network.name}-${Date.now()}.json`
  );
  fs.writeFileSync(deploymentFile, JSON.stringify(deployment, null, 2));

  console.log("\n✅ Deployment complete!");
  console.log("Deployment details saved to:", deploymentFile);
  console.log("\nContract Addresses:");
  console.log("-------------------");
  console.log("QuaiVault Implementation:", implementationAddress);
  console.log("QuaiVaultFactory:", factoryAddress);
  console.log("SocialRecoveryModule:", socialRecoveryAddress);
  console.log("MultiSendCallOnly:", multiSendCallOnlyAddress);
  if (DEPLOY_MOCK_MODULE) {
    if (mockModuleAddress) console.log("MockModule:", mockModuleAddress);
    if (mockERC721Address) console.log("MockERC721:", mockERC721Address);
    if (mockERC1155Address) console.log("MockERC1155:", mockERC1155Address);
  }

  console.log("\n📝 Run 'npm run update-env' to sync .env and .env.e2e");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
