import { ethers } from "hardhat";

async function main() {
  const priceFeed = process.env.PRICE_FEED_BNB_USD;
  const feeCollector = process.env.FEE_COLLECTOR;
  const ccipRouter = process.env.CCIP_ROUTER_BSC;

  const POIRegistry = await ethers.getContractFactory("POIRegistry");
  const registry = await POIRegistry.deploy(priceFeed, feeCollector, ccipRouter);
  await registry.waitForDeployment();
  console.log(`POIRegistry deployed to: ${await registry.getAddress()}`);
}
main();
