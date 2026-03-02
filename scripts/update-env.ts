import * as fs from "fs";
import * as path from "path";

const projectRoot = process.cwd();

/**
 * Update .env and .env.e2e files with contract addresses from the latest deployment.
 *
 * Usage:
 *   npx hardhat run scripts/update-env.ts
 *   npm run update-env
 *
 * By default reads the latest deployment-*.json from ./deployments/.
 * To specify a network prefix: DEPLOY_NETWORK=cyprus1 npm run update-env
 */

// Mapping from deployment JSON keys → env variable names (same for .env and .env.e2e)
const ENV_VARS: Record<string, string> = {
  QuaiVault: "QUAIVAULT_IMPLEMENTATION",
  QuaiVaultFactory: "QUAIVAULT_FACTORY",
  SocialRecoveryModule: "SOCIAL_RECOVERY_MODULE",
  MultiSend: "MULTISEND",
  MockModule: "MOCK_MODULE",
  MockERC721: "MOCK_ERC721",
  MockERC1155: "MOCK_ERC1155",
};

async function main() {
  const deploymentsDir = path.join(projectRoot, "deployments");

  if (!fs.existsSync(deploymentsDir)) {
    console.error("No deployments/ directory found. Run deploy first.");
    process.exit(1);
  }

  // Find the latest deployment file (any network)
  const networkFilter = process.env.DEPLOY_NETWORK || "";
  const prefix = networkFilter ? `deployment-${networkFilter}-` : "deployment-";

  const deploymentFiles = fs
    .readdirSync(deploymentsDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .sort()
    .reverse();

  if (deploymentFiles.length === 0) {
    console.error(
      networkFilter
        ? `No deployment files found for network '${networkFilter}'.`
        : "No deployment files found."
    );
    process.exit(1);
  }

  const latestFile = deploymentFiles[0];
  const latestDeploymentFile = path.join(deploymentsDir, latestFile);
  console.log(`Reading deployment from: ${latestFile}`);

  const deployment = JSON.parse(fs.readFileSync(latestDeploymentFile, "utf-8"));
  const { contracts } = deployment;

  // Update .env
  const envPath = path.join(projectRoot, ".env");
  console.log("\n📝 Updating .env...");
  console.log("-------------------");
  updateEnvFile(envPath, contracts, ENV_VARS);

  // Update .env.e2e
  const e2ePath = path.join(projectRoot, ".env.e2e");
  if (fs.existsSync(e2ePath)) {
    console.log("\n📝 Updating .env.e2e...");
    console.log("-------------------");
    updateEnvFile(e2ePath, contracts, ENV_VARS);
  } else {
    console.log("\n⏭️  Skipping .env.e2e (file does not exist)");
  }

  console.log("\n✅ Update complete!");
  console.log("\nContract Addresses:");
  console.log("-------------------");
  for (const [contractName, address] of Object.entries(contracts)) {
    console.log(`  ${contractName}: ${address}`);
  }
}

function updateEnvFile(
  envPath: string,
  contracts: Record<string, string>,
  varMap: Record<string, string>
) {
  let envContent = "";
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, "utf-8");
  }

  for (const [contractName, envVar] of Object.entries(varMap)) {
    const address = contracts[contractName];
    if (!address) continue; // contract not deployed (e.g., mock contracts)

    const regex = new RegExp(`^${envVar}=.*$`, "m");
    if (regex.test(envContent)) {
      envContent = envContent.replace(regex, `${envVar}=${address}`);
      console.log(`  Updated ${envVar}`);
    } else {
      envContent +=
        (envContent.endsWith("\n") ? "" : "\n") + `${envVar}=${address}\n`;
      console.log(`  Added ${envVar}`);
    }
  }

  fs.writeFileSync(envPath, envContent);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
