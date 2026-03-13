import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-verify";
import "@quai/hardhat-deploy-metadata";
import "hardhat-gas-reporter";
import "solidity-coverage";
import * as dotenv from "dotenv";
dotenv.config();

const rpcUrl = process.env.RPC_URL || "https://rpc.quai.network";
const chainId = Number(process.env.CHAIN_ID || "9000");

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",
  solidity: {
    compilers: [
      {
        version: "0.8.22",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1000,
          },
          evmVersion: "london",
          metadata: {
            bytecodeHash: "ipfs",
            useLiteralContent: true,
          },
        },
      },
    ],
  },
  networks: {
    hardhat: {
      chainId: 1337,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 1337,
    },
    // Quai Network zones - Cyprus region
    cyprus1: {
      url: rpcUrl,
      accounts: process.env.CYPRUS1_PK ? [process.env.CYPRUS1_PK] : [],
      chainId: chainId,
    },
    cyprus2: {
      url: rpcUrl,
      accounts: process.env.CYPRUS2_PK ? [process.env.CYPRUS2_PK] : [],
      chainId: chainId,
    },
    cyprus3: {
      url: rpcUrl,
      accounts: process.env.CYPRUS3_PK ? [process.env.CYPRUS3_PK] : [],
      chainId: chainId,
    },
    // Paxos region
    paxos1: {
      url: rpcUrl,
      accounts: process.env.PAXOS1_PK ? [process.env.PAXOS1_PK] : [],
      chainId: chainId,
    },
    paxos2: {
      url: rpcUrl,
      accounts: process.env.PAXOS2_PK ? [process.env.PAXOS2_PK] : [],
      chainId: chainId,
    },
    paxos3: {
      url: rpcUrl,
      accounts: process.env.PAXOS3_PK ? [process.env.PAXOS3_PK] : [],
      chainId: chainId,
    },
    // Hydra region
    hydra1: {
      url: rpcUrl,
      accounts: process.env.HYDRA1_PK ? [process.env.HYDRA1_PK] : [],
      chainId: chainId,
    },
    hydra2: {
      url: rpcUrl,
      accounts: process.env.HYDRA2_PK ? [process.env.HYDRA2_PK] : [],
      chainId: chainId,
    },
    hydra3: {
      url: rpcUrl,
      accounts: process.env.HYDRA3_PK ? [process.env.HYDRA3_PK] : [],
      chainId: chainId,
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
    outputFile: "gas-report.txt",
    noColors: true,
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
  mocha: {
    timeout: 20000,
  },
};

export default config;
