import type { HardhatUserConfig } from "hardhat/config";

import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import hardhatVerify from "@nomicfoundation/hardhat-verify";
import dotenv from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: resolve(__dirname, ".env") });

let DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY ?? "";

if (DEPLOYER_PRIVATE_KEY) {
  if (!DEPLOYER_PRIVATE_KEY.startsWith("0x")) {
    DEPLOYER_PRIVATE_KEY = "0x" + DEPLOYER_PRIVATE_KEY;
  }

  if (!/^0x[a-fA-F0-9]{64}$/.test(DEPLOYER_PRIVATE_KEY)) {
    throw new Error(
      "Invalid DEPLOYER_PRIVATE_KEY format. Must be a 64-character hex string with 0x prefix."
    );
  }
}

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY ?? "";

const RPC_URL_ETHEREUM = process.env.RPC_URL_ETHEREUM ?? "https://ethereum-rpc.publicnode.com";
const RPC_URL_OPTIMISM = process.env.RPC_URL_OPTIMISM ?? "https://mainnet.optimism.io";
const RPC_URL_BASE = process.env.RPC_URL_BASE ?? "https://mainnet.base.org";
const RPC_URL_ARBITRUM = process.env.RPC_URL_ARBITRUM ?? "https://arb1.arbitrum.io/rpc";
const RPC_URL_POLYGON = process.env.RPC_URL_POLYGON ?? "https://polygon-rpc.com";
const RPC_URL_HYPEREVM = process.env.RPC_URL_HYPEREVM ?? "https://rpc.hyperliquid.xyz/evm";
const RPC_URL_MONAD = process.env.RPC_URL_MONAD ?? "https://rpc.monad.xyz";

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViemPlugin, hardhatVerify],
  verify: {
    etherscan: {
      apiKey: ETHERSCAN_API_KEY,
    },
    blockscout: {
      enabled: false,
    },
  },
  solidity: {
    profiles: {
      default: {
        version: "0.8.30",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
      production: {
        version: "0.8.30",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
    },
  },
  networks: {
    hardhat: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 31337,
    },
    ethereum: {
      type: "http",
      chainType: "l1",
      chainId: 1,
      url: RPC_URL_ETHEREUM,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
    optimism: {
      type: "http",
      chainType: "op",
      chainId: 10,
      url: RPC_URL_OPTIMISM,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
    base: {
      type: "http",
      chainType: "op",
      chainId: 8453,
      url: RPC_URL_BASE,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
    arbitrum: {
      type: "http",
      chainType: "generic",
      chainId: 42161,
      url: RPC_URL_ARBITRUM,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
    polygon: {
      type: "http",
      chainType: "l1",
      chainId: 137,
      url: RPC_URL_POLYGON,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
    hyperevm: {
      type: "http",
      chainType: "generic",
      chainId: 999,
      url: RPC_URL_HYPEREVM,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
    monad: {
      type: "http",
      chainType: "generic",
      chainId: 143,
      url: RPC_URL_MONAD,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
  },
};

export default config;
