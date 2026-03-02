import hre from "hardhat";
import { decodeEventLog, getAddress, parseGwei, type Address, type Hash } from "viem";

const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

const UPGRADED_EVENT = {
  type: "event",
  name: "Upgraded",
  inputs: [{ indexed: true, name: "implementation", type: "address" }],
} as const;

function optionalGweiEnv(name: string): bigint | null {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) {
    return null;
  }
  return parseGwei(raw);
}

function getFeeOverrides(): {
  maxPriorityFeePerGas?: bigint;
  maxFeePerGas?: bigint;
} {
  const maxPriorityFeePerGas = optionalGweiEnv("HAKO_TX_MAX_PRIORITY_FEE_GWEI");
  const maxFeePerGas = optionalGweiEnv("HAKO_TX_MAX_FEE_GWEI");

  const feeOverrides: {
    maxPriorityFeePerGas?: bigint;
    maxFeePerGas?: bigint;
  } = {};
  if (maxPriorityFeePerGas !== null) {
    feeOverrides.maxPriorityFeePerGas = maxPriorityFeePerGas;
  }
  if (maxFeePerGas !== null) {
    feeOverrides.maxFeePerGas = maxFeePerGas;
  }
  return feeOverrides;
}

function parseImplementationSlot(value: `0x${string}`): Address {
  return getAddress(`0x${value.slice(-40)}`);
}

function optionalAddressEnv(name: string): Address | null {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) {
    return null;
  }
  return getAddress(raw as Address);
}

function requireAddressEnv(name: string): Address {
  const parsed = optionalAddressEnv(name);
  if (!parsed) {
    throw new Error(`Set ${name}`);
  }
  return parsed;
}

function getRelayerTargets(deployer: Address): Address[] {
  const relayerListRaw = (process.env.HAKO_GATEWAY_RELAYER_ADDRESSES ?? "").trim();
  if (!relayerListRaw) {
    return [deployer];
  }

  const parsed = relayerListRaw
    .split(",")
    .map((address_) => address_.trim())
    .filter((address_) => address_.length > 0)
    .map((address_) => getAddress(address_ as Address));

  if (parsed.length === 0) {
    return [deployer];
  }

  const deduped = new Map<string, Address>();
  for (const address_ of parsed) {
    deduped.set(address_.toLowerCase(), address_);
  }
  return [...deduped.values()];
}

async function main() {
  const connection = await hre.network.connect();
  const { viem } = connection;
  const feeOverrides = getFeeOverrides();

  const [deployer] = await viem.getWalletClients();
  if (!deployer) {
    throw new Error(
      "No deployer wallet available. Configure DEPLOYER_PRIVATE_KEY in .env",
    );
  }

  const proxyAddress = requireAddressEnv("HAKO_STABLE_GATEWAY_PROXY");
  const publicClient = await viem.getPublicClient();
  const { abi } = await hre.artifacts.readArtifact("HakoStableGateway");

  const upgraderRole = await publicClient.readContract({
    address: proxyAddress,
    abi,
    functionName: "UPGRADER_ROLE",
    args: [],
  });
  const hasUpgraderRole = await publicClient.readContract({
    address: proxyAddress,
    abi,
    functionName: "hasRole",
    args: [upgraderRole, deployer.account.address],
  });
  if (!hasUpgraderRole) {
    throw new Error(
      `Deployer ${deployer.account.address} does not have UPGRADER_ROLE on ${proxyAddress}`,
    );
  }

  const beforeSlot = await publicClient.getStorageAt({
    address: proxyAddress,
    slot: EIP1967_IMPLEMENTATION_SLOT,
  });
  const beforeImpl = parseImplementationSlot(beforeSlot);

  const newImplementation = await viem.deployContract("HakoStableGateway", [], {
    client: { wallet: deployer },
    ...feeOverrides,
  });

  const hash = await deployer.writeContract({
    address: proxyAddress,
    abi,
    functionName: "upgradeToAndCall",
    args: [newImplementation.address, "0x"],
    ...feeOverrides,
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
      continue;
    }
  }

  const afterSlot = await publicClient.getStorageAt({
    address: proxyAddress,
    slot: EIP1967_IMPLEMENTATION_SLOT,
  });
  const afterImpl = parseImplementationSlot(afterSlot);

  if (afterImpl !== getAddress(newImplementation.address)) {
    throw new Error(
      `Upgrade failed: implementation slot ${afterImpl} does not match deployed implementation ${newImplementation.address}`,
    );
  }

  const relayerRole = await publicClient.readContract({
    address: proxyAddress,
    abi,
    functionName: "RELAYER_ROLE",
    args: [],
  });

  const relayerTargets = getRelayerTargets(deployer.account.address);
  const relayerBootstrapReport: Array<{
    relayer: Address;
    preExisting: boolean;
    grantTxHash: Hash | null;
    finalHasRole: boolean;
  }> = [];

  for (const relayer of relayerTargets) {
    const hasRoleBefore = await publicClient.readContract({
      address: proxyAddress,
      abi,
      functionName: "hasRole",
      args: [relayerRole, relayer],
    });

    let grantTxHash: Hash | null = null;
    if (!hasRoleBefore) {
      grantTxHash = await deployer.writeContract({
        address: proxyAddress,
        abi,
        functionName: "grantRole",
        args: [relayerRole, relayer],
        ...feeOverrides,
      });
      await publicClient.waitForTransactionReceipt({ hash: grantTxHash });
    }

    const finalHasRole = await publicClient.readContract({
      address: proxyAddress,
      abi,
      functionName: "hasRole",
      args: [relayerRole, relayer],
    });

    if (!finalHasRole) {
      throw new Error(`RELAYER_ROLE bootstrap failed for ${relayer} on ${proxyAddress}`);
    }

    relayerBootstrapReport.push({
      relayer,
      preExisting: hasRoleBefore,
      grantTxHash,
      finalHasRole,
    });
  }

  console.log("Proxy:", proxyAddress);
  console.log("Deployer:", deployer.account.address);
  console.log(
    "Fee overrides:",
    Object.keys(feeOverrides).length > 0
      ? JSON.stringify({
          maxPriorityFeePerGas: feeOverrides.maxPriorityFeePerGas?.toString(),
          maxFeePerGas: feeOverrides.maxFeePerGas?.toString(),
        })
      : "none",
  );
  console.log("Implementation before:", beforeImpl);
  console.log("New implementation deployed:", newImplementation.address);
  console.log("Upgrade tx:", hash);
  console.log("Upgraded event impl:", eventImpl ?? "not found");
  console.log("Implementation after:", afterImpl);
  console.log("Relayer targets:", relayerTargets.join(", "));
  for (const row of relayerBootstrapReport) {
    console.log(
      `Relayer ${row.relayer} | preExisting=${row.preExisting} | grantTx=${row.grantTxHash ?? "n/a"} | finalHasRole=${row.finalHasRole}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
