import hre from "hardhat";
import { decodeEventLog, getAddress, type Address } from "viem";

const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

const UPGRADED_EVENT = {
  type: "event",
  name: "Upgraded",
  inputs: [{ indexed: true, name: "implementation", type: "address" }],
} as const;

function parseImplementationSlot(value: `0x${string}`): Address {
  return getAddress(`0x${value.slice(-40)}`);
}

async function main() {
  const connection = await hre.network.connect();
  const { viem } = connection;

  const [deployer] = await viem.getWalletClients();
  if (!deployer) {
    throw new Error("No deployer wallet available. Configure DEPLOYER_PRIVATE_KEY in .env");
  }

  const proxyAddress = getAddress(
    (process.env.HAKO_STABLE_VAULT_PROXY ?? "").trim() as Address,
  );

  if (!proxyAddress) {
    throw new Error("Set HAKO_STABLE_VAULT_PROXY");
  }

  const publicClient = await viem.getPublicClient();
  const { abi } = await hre.artifacts.readArtifact("HakoStableVault");

  const beforeSlot = await publicClient.getStorageAt({
    address: proxyAddress,
    slot: EIP1967_IMPLEMENTATION_SLOT,
  });
  const beforeImpl = parseImplementationSlot(beforeSlot);

  const newImplementation = await viem.deployContract("HakoStableVault", [], {
    client: { wallet: deployer },
  });

  const hash = await deployer.writeContract({
    address: proxyAddress,
    abi,
    functionName: "upgradeToAndCall",
    args: [newImplementation.address, "0x"],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  let eventImpl: Address | null = null;
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== proxyAddress) continue;
    try {
      const decoded = decodeEventLog({
        abi: [UPGRADED_EVENT],
        data: log.data,
        topics: log.topics,
      });
      eventImpl = getAddress(decoded.args.implementation);
      break;
    } catch {
      // ignore non-upgrade logs
    }
  }

  const afterSlot = await publicClient.getStorageAt({
    address: proxyAddress,
    slot: EIP1967_IMPLEMENTATION_SLOT,
  });
  const afterImpl = parseImplementationSlot(afterSlot);

  console.log("Proxy:", proxyAddress);
  console.log("Deployer:", deployer.account.address);
  console.log("Implementation before:", beforeImpl);
  console.log("New implementation deployed:", newImplementation.address);
  console.log("Upgrade tx:", hash);
  console.log("Upgraded event impl:", eventImpl ?? "not found");
  console.log("Implementation after:", afterImpl);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
