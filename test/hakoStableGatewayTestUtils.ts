import assert from "node:assert/strict";
import { decodeEventLog, type Hex } from "viem";
import { deployGatewayFixture } from "./gatewayFixtures.js";

export type GatewayTestCtx = Awaited<ReturnType<typeof deployGatewayFixture>>;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

type TokenContract = {
  address: `0x${string}`;
  abi: readonly unknown[];
};

export async function approveAndDepositGateway(
  ctx: GatewayTestCtx,
  params: {
    token: TokenContract;
    amount: bigint;
    receiver: `0x${string}`;
    sender?: GatewayTestCtx["user"] | GatewayTestCtx["owner"] | GatewayTestCtx["operator"];
  },
) {
  const sender = params.sender ?? ctx.user;

  await sender.writeContract({
    address: params.token.address,
    abi: params.token.abi,
    functionName: "approve",
    args: [ctx.gateway.address, params.amount],
  });

  return sender.writeContract({
    address: ctx.gateway.address,
    abi: ctx.gateway.abi,
    functionName: "deposit",
    args: [params.token.address, params.amount, params.receiver],
  });
}

export async function readTokenBalance(
  ctx: GatewayTestCtx,
  token: TokenContract,
  holder: `0x${string}`,
) {
  return ctx.publicClient.readContract({
    address: token.address,
    abi: token.abi,
    functionName: "balanceOf",
    args: [holder],
  });
}

export async function getGatewayEventArgs<T>(
  ctx: GatewayTestCtx,
  txHash: `0x${string}`,
  eventName: string,
): Promise<T> {
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
  const gatewayAddress = ctx.gateway.address.toLowerCase();

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== gatewayAddress) continue;

    try {
      const decoded = decodeEventLog({
        abi: ctx.gateway.abi,
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
