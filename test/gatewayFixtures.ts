import hre from "hardhat";
import type { Address } from "viem";
import { encodeFunctionData, encodePacked, keccak256, parseUnits } from "viem";

export function buildGatewayDepositId(gateway: Address, chainId: bigint, localId: bigint) {
  return keccak256(
    encodePacked(
      ["uint256", "address", "uint256"],
      [chainId, gateway, localId],
    ),
  );
}

export async function deployGatewayFixture() {
  const connection = await hre.network.connect();
  const { viem } = connection;

  const [owner, user, operator] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const usdc = await viem.deployContract("MockERC20", ["USD Coin", "USDC", 6], {
    client: { wallet: owner },
  });
  const dai = await viem.deployContract("MockERC20", ["Dai Stablecoin", "DAI", 18], {
    client: { wallet: owner },
  });
  const usdt = await viem.deployContract("MockERC20", ["Tether USD", "USDT", 6], {
    client: { wallet: owner },
  });
  const badDecimals = await viem.deployContract("MockERC20", ["Bad Decimals", "BAD19", 19], {
    client: { wallet: owner },
  });

  const gatewayImpl = await viem.deployContract("HakoStableGateway", [], {
    client: { wallet: owner },
  });

  const initData = encodeFunctionData({
    abi: gatewayImpl.abi,
    functionName: "initialize",
    args: [
      owner.account.address,
      [usdc.address, dai.address],
      parseUnits("1", 18),
    ],
  });

  const proxy = await viem.deployContract("HakoProxy", [gatewayImpl.address, initData], {
    client: { wallet: owner },
  });

  const gateway = {
    address: proxy.address,
    abi: gatewayImpl.abi,
  };

  const initialUsdc = 20_000n * 10n ** 6n;
  const initialDai = 20_000n * 10n ** 18n;
  const initialUsdt = 20_000n * 10n ** 6n;

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
  await owner.writeContract({
    address: usdt.address,
    abi: usdt.abi,
    functionName: "mint",
    args: [user.account.address, initialUsdt],
  });

  return {
    owner,
    user,
    operator,
    publicClient,
    gateway,
    usdc,
    dai,
    usdt,
    badDecimals,
    viem,
  };
}
