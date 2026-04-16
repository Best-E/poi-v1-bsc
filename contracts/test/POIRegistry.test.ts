import { expect } from "chai";
import { ethers } from "hardhat";
import { POIRegistry } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("POIRegistry v1.0.0", function () {
  let registry: POIRegistry;
  let owner: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let agent: SignerWithAddress;
  let feeCollector: SignerWithAddress;
  let mockPriceFeed: any;

  const ZERO_ADDRESS = "0x0000000000000000000000000000";
  const CCIP_ROUTER = "0x34A1D3fff3958CAA7cd4E429a0521794b92B9AaD";

  async function deployMockPriceFeed(bnbPrice: number) {
    const MockV3 = await ethers.getContractFactory("MockV3Aggregator");
    return await MockV3.deploy(8, bnbPrice * 1e8);
  }

  async function signRegister(signer: SignerWithAddress, username: string) {
    const domain = {
      name: "POI v1.0.0",
      version: "1",
      chainId: 31337,
      verifyingContract: await registry.getAddress()
    };
    const types = {
      POIRegister: [
        { name: "owner", type: "address" },
        { name: "username", type: "string" },
        { name: "nonce", type: "uint256" }
      ]
    };
    const nonce = await registry.nonces(signer.address);
    const value = { owner: signer.address, username: username.toLowerCase(), nonce };
    return await signer.signTypedData(domain, types, value);
  }

  async function signRegisterAgent(signer: SignerWithAddress, agentId: string) {
    const domain = {
      name: "POI v1.0.0",
      version: "1",
      chainId: 31337,
      verifyingContract: await registry.getAddress()
    };
    const types = {
      POIRegisterAgent: [
        { name: "owner", type: "address" },
        { name: "agentId", type: "string" },
        { name: "nonce", type: "uint256" }
      ]
    };
    const nonce = await registry.nonces(signer.address);
    const value = { owner: signer.address, agentId, nonce };
    return await signer.signTypedData(domain, types, value);
  }

  beforeEach(async function () {
    [owner, user1, user2, agent, feeCollector] = await ethers.getSigners();
    mockPriceFeed = await deployMockPriceFeed(600); // $600 BNB

    const POIRegistry = await ethers.getContractFactory("POIRegistry");
    registry = await POIRegistry.deploy(
      await mockPriceFeed.getAddress(),
      feeCollector.address,
      CCIP_ROUTER
    );
  });

  describe("Human Registration", function () {
    it("Registers free @username with 7+ chars", async function () {
      const sig = await signRegister(user1, "@john_lagos");
      await expect(registry.connect(user1).register("@john_lagos", sig))
      .to.emit(registry, "IdentityRegistered")
      .withArgs(user1.address, "@john_lagos", 1, 0, await time.latest() + 1 + 730 * 86400);

      const [identifier, idType,, expired] = await registry.resolveAddress(user1.address);
      expect(identifier).to.eq("@john_lagos");
      expect(idType).to.eq(1); // Human
      expect(expired).to.be.false;
    });

    it("Charges correct BNB for 3-char @name", async function () {
      const sig = await signRegister(user1, "@eth");
      const priceWei = await registry.getPriceWei("@eth");
      // $1000 / $600 = 1.666 BNB
      expect(priceWei).to.be.closeTo(ethers.parseEther("1.666"), ethers.parseEther("0.01"));

      await expect(registry.connect(user1).register("@eth", sig, { value: priceWei }))
      .to.emit(registry, "IdentityRegistered")
      .withArgs(user1.address, "@eth", 1, priceWei, await time.latest() + 1 + 730 * 86400);
    });

    it("Refunds excess BNB", async function () {
      const sig = await signRegister(user1, "@eth");
      const price = await registry.getPriceWei("@eth");
      const overpay = price + ethers.parseEther("0.5");
      await expect(registry.connect(user1).register("@eth", sig, { value: overpay }))
      .to.changeEtherBalance(user1, -price);
    });

    it("Fails if @name taken", async function () {
      const sig1 = await signRegister(user1, "@test");
      await registry.connect(user1).register("@test", sig1);
      const sig2 = await signRegister(user2, "@test");
      await expect(registry.connect(user2).register("@test", sig2)).to.be.revertedWith("Taken");
    });

    it("Fails if address already registered as agent", async function () {
      const agentId = "#agent_" + (await agent.getAddress()).slice(2, 10);
      const sigAgent = await signRegisterAgent(agent, agentId);
      await registry.connect(agent).registerAgent(sigAgent);

      const sigHuman = await signRegister(agent, "@human");
      await expect(registry.connect(agent).register("@human", sigHuman))
      .to.be.revertedWith("Address already registered");
    });

    it("Fails if missing @ prefix", async function () {
      const sig = await signRegister(user1, "test");
      await expect(registry.connect(user1).register("test", sig))
      .to.be.revertedWith("Humans use @");
    });

    it("Fails with bad signature", async function () {
      const sig = await signRegister(user2, "@test");
      await expect(registry.connect(user1).register("@test", sig))
      .to.be.revertedWith("Invalid signature");
    });
  });

  describe("Agent Registration", function () {
    it("Registers #agentID free and permanent", async function () {
      const agentId = "#agent_" + (await agent.getAddress()).slice(2, 10);
      const sig = await signRegisterAgent(agent, agentId);

      await expect(registry.connect(agent).registerAgent(sig))
      .to.emit(registry, "IdentityRegistered")
      .withArgs(agent.address, agentId, 2, 0, 0);

      const [identifier, idType,, expired] = await registry.resolveAddress(agent.address);
      expect(identifier).to.eq(agentId);
      expect(idType).to.eq(2); // Agent
      expect(expired).to.be.false;
    });

    it("AgentID is deterministic", async function () {
      const hash = ethers.keccak256(ethers.solidityPacked(["address", "uint256"], [agent.address, 31337]));
      const expectedId = "#agent_" + hash.slice(2, 10);
      const sig = await signRegisterAgent(agent, expectedId);
      await registry.connect(agent).registerAgent(sig);
      const [identifier] = await registry.resolveAddress(agent.address);
      expect(identifier).to.eq(expectedId);
    });

    it("Fails if address already registered as human", async function () {
      const sigHuman = await signRegister(user1, "@test");
      await registry.connect(user1).register("@test", sigHuman);

      const agentId = "#agent_" + (await user1.getAddress()).slice(2, 10);
      const sigAgent = await signRegisterAgent(user1, agentId);
      await expect(registry.connect(user1).registerAgent(sigAgent))
      .to.be.revertedWith("Already registered");
    });
  });

  describe("verifyPair", function () {
    beforeEach(async function () {
      const sig1 = await signRegister(user1, "@john");
      await registry.connect(user1).register("@john", sig1);

      const agentId = "#agent_" + (await agent.getAddress()).slice(2, 10);
      const sig2 = await signRegisterAgent(agent, agentId);
      await registry.connect(agent).registerAgent(sig2);
    });

    it("Returns match for correct human pair", async function () {
      const [match, actualId, idType] = await registry.verifyPair(user1.address, "@john");
      expect(match).to.be.true;
      expect(actualId).to.eq("@john");
      expect(idType).to.eq(1);
    });

    it("Returns match for correct agent pair", async function () {
      const [identifier] = await registry.resolveAddress(agent.address);
      const [match,, idType] = await registry.verifyPair(agent.address, identifier);
      expect(match).to.be.true;
      expect(idType).to.eq(2);
    });

    it("Returns mismatch for wrong identifier", async function () {
      const [match, actualId] = await registry.verifyPair(user1.address, "@wrong");
      expect(match).to.be.false;
      expect(actualId).to.eq("@john");
    });

    it("Returns type mismatch: @ vs agent", async function () {
      const [match,, idType] = await registry.verifyPair(agent.address, "@john");
      expect(match).to.be.false;
      expect(idType).to.eq(2); // Actual is Agent
    });

    it("Returns expired after 2 years + grace", async function () {
      await time.increase(730 * 86400 + 90 * 86400 + 1);
      const [,,, expired] = await registry.verifyPair(user1.address, "@john");
      expect(expired).to.be.true;
    });
  });

  describe("Renewal", function () {
    beforeEach(async function () {
      const sig = await signRegister(user1, "@eth");
      const price = await registry.getPriceWei("@eth");
      await registry.connect(user1).register("@eth", sig, { value: price });
    });

    it("Renews at 50% discount", async function () {
      const fullPrice = await registry.getPriceWei("@eth");
      const renewPrice = fullPrice / 2n;
      await expect(registry.connect(user1).renew("@eth", { value: renewPrice }))
      .to.emit(registry, "Renewed");
    });

    it("Fails for agents", async function () {
      const agentId = "#agent_" + (await agent.getAddress()).slice(2, 10);
      const sig = await signRegisterAgent(agent, agentId);
      await registry.connect(agent).registerAgent(sig);
      await expect(registry.connect(agent).renew(agentId))
      .to.be.revertedWith("Agents permanent");
    });
  });

  describe("Withdraw", function () {
    it("Owner withdraws BNB to feeCollector", async function () {
      const sig = await signRegister(user1, "@eth");
      const price = await registry.getPriceWei("@eth");
      await registry.connect(user1).register("@eth", sig, { value: price });

      await expect(registry.connect(owner).withdraw(ZERO_ADDRESS, price))
      .to.changeEtherBalance(feeCollector, price);
    });

    it("Fails if not owner", async function () {
      await expect(registry.connect(user1).withdraw(ZERO_ADDRESS, 1))
      .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });
  });

  describe("Gas", function () {
    it("register human < 120k gas", async function () {
      const sig = await signRegister(user1, "@test123");
      const tx = await registry.connect(user1).register("@test123", sig);
      const receipt = await tx.wait();
      expect(receipt!.gasUsed).to.be.lt(120000);
    });

    it("registerAgent < 100k gas", async function () {
      const agentId = "#agent_" + (await agent.getAddress()).slice(2, 10);
      const sig = await signRegisterAgent(agent, agentId);
      const tx = await registry.connect(agent).registerAgent(sig);
      const receipt = await tx.wait();
      expect(receipt!.gasUsed).to.be.lt(100000);
    });
  });
});
