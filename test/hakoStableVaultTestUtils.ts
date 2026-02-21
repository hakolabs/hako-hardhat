import assert from "node:assert/strict";
import { decodeEventLog, type Hex } from "viem";
import { deployFixture } from "./fixtures.js";

export type VaultTestCtx = Awaited<ReturnType<typeof deployFixture>>;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

type TokenContract = {
  address: `0x${string}`;
  abi: readonly unknown[];
};

export async function approveAndDeposit(
  ctx: VaultTestCtx,
  params: {
    token: TokenContract;
    amount: bigint;
    receiver: `0x${string}`;
    sender?: VaultTestCtx["user"] | VaultTestCtx["owner"];
  },
): Promise<`0x${string}`> {
  const sender = params.sender ?? ctx.user;

  await sender.writeContract({
    address: params.token.address,
    abi: params.token.abi,
    functionName: "approve",
    args: [ctx.stableVault.address, params.amount],
  });

  return sender.writeContract({
    address: ctx.stableVault.address,
    abi: ctx.stableVault.abi,
    functionName: "deposit",
    args: [params.token.address, params.amount, params.receiver],
  });
}

export async function readSupplyAndAssets(ctx: VaultTestCtx): Promise<{ supply: bigint; assets: bigint }> {
  const [supply, assets] = await Promise.all([
    ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "totalSupply",
      args: [],
    }),
    ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "totalAssets",
      args: [],
    }),
  ]);

  return { supply, assets };
}

export async function pricePerShareX18(ctx: VaultTestCtx): Promise<bigint> {
  const { supply, assets } = await readSupplyAndAssets(ctx);
  if (supply === 0n) return 0n;
  return (assets * 10n ** 18n) / supply;
}

export async function expectTotals(ctx: VaultTestCtx, expectedSupply: bigint, expectedAssets: bigint): Promise<void> {
  const { supply, assets } = await readSupplyAndAssets(ctx);
  assert.equal(supply, expectedSupply);
  assert.equal(assets, expectedAssets);
}

export async function getEventArgs<T>(
  ctx: VaultTestCtx,
  txHash: `0x${string}`,
  eventName: string,
): Promise<T> {
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
  const vaultAddress = ctx.stableVault.address.toLowerCase();

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== vaultAddress) continue;

    try {
      const decoded = decodeEventLog({
        abi: ctx.stableVault.abi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        strict: false,
      });

      if (decoded.eventName === eventName) {
        return decoded.args as T;
      }
    } catch {}
  }

  assert.fail(`Event not found: ${eventName}`);
}
