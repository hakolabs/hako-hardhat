import hre from "hardhat";
import type { Address } from "viem";
import {
  encodePacked,
  encodeFunctionData,
  keccak256,
} from "viem";

export function buildDepositId(vault: Address, chainId: bigint, localId: bigint) {
  return keccak256(
    encodePacked(
      ["uint256", "address", "uint256"],
      [chainId, vault, localId],
    ),
  );
}


export function derivePseudoAddress(chainId: bigint, accountId: string): Address {
  let hash = keccak256(
    encodePacked(
      ["string", "uint64", "string", "string"],
      ["hako:", chainId, ":", accountId],
    ),
  );
  let addr = (`0x${hash.slice(-40)}` as Address).toLowerCase() as Address;

  if (addr === "0x0000000000000000000000000000000000000000") {
    hash = keccak256(
      encodePacked(
        ["string", "uint64", "string", "string", "string"],
        ["hako:", chainId, ":", accountId, ":1"],
      ),
    );
    addr = (`0x${hash.slice(-40)}` as Address).toLowerCase() as Address;
  }

  return addr;
}

export async function deployFixture() {
  const connection = await hre.network.connect();
  const { viem } = connection;

  const [owner, user] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const usdc = await viem.deployContract("MockERC20", ["USD Coin", "USDC", 6], {
    client: { wallet: owner },
  });
  const dai = await viem.deployContract("MockERC20", ["Dai Stablecoin", "DAI", 18], {
    client: { wallet: owner },
  });

  const stableImpl = await viem.deployContract("HakoStableVault", [], {
    client: { wallet: owner },
  });

  const initData = encodeFunctionData({
    abi: stableImpl.abi,
    functionName: "initialize",
    args: [
      "Hako Stable",
      "hSTBL",
      owner.account.address,
      [usdc.address, dai.address],
    ],
  });

  const proxy = await viem.deployContract("HakoProxy", [stableImpl.address, initData], {
    client: { wallet: owner },
  });

  const stableVault = {
    address: proxy.address,
    abi: stableImpl.abi,
  };

  await owner.writeContract({
    address: stableVault.address,
    abi: stableVault.abi,
    functionName: "setDestinationChainAllowed",
    args: [8453n, true],
  });
  await owner.writeContract({
    address: stableVault.address,
    abi: stableVault.abi,
    functionName: "setDestinationAssetAllowed",
    args: [8453n, usdc.address, true],
  });

  const initialUsdc = 10_000n * 10n ** 6n;
  const initialDai = 10_000n * 10n ** 18n;

  await owner.writeContract({
    address: usdc.address,
    abi: usdc.abi,
    functionName: "mint",
    args: [user.account.address, initialUsdc],
  });

  await owner.writeContract({
    address: dai.address,
    abi: dai.abi,
    functionName: "mint",
    args: [user.account.address, initialDai],
  });

  return { owner, user, publicClient, stableVault, usdc, dai, viem };
}
