import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
dotenv.config();

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: { optimizer: { enabled: true, runs: 200 } }
  },
  networks: {
    bscTestnet: {
      url: process.env.BSC_TESTNET_RPC || "",
      accounts: process.env.PRIVATE_KEY? [process.env.PRIVATE_KEY] : [],
      chainId: 97
    },
    bsc: {
      url: process.env.BSC_RPC || "",
      accounts: process.env.PRIVATE_KEY? [process.env.PRIVATE_KEY] : [],
      chainId: 56
    }
  },
  etherscan: {
    apiKey: process.env.BSCSCAN_API_KEY
  }
};
export default config;
