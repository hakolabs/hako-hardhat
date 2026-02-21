import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { parseUnits, type Hex } from "viem";
import { buildGatewayDepositId, deployGatewayFixture } from "./gatewayFixtures.js";
import {
  ZERO_ADDRESS,
  type GatewayTestCtx,
  approveAndDepositGateway,
  getGatewayEventArgs,
  readTokenBalance,
} from "./hakoStableGatewayTestUtils.js";

type GatewayDepositRecordedArgs = {
  depositId: Hex;
  sender: `0x${string}`;
  token: `0x${string}`;
  amountToken: bigint;
  amountNormalized: bigint;
  receiver: `0x${string}`;
};

describe("HakoStableGateway deposits", () => {
  let ctx: GatewayTestCtx;

  beforeEach(async () => {
    ctx = await deployGatewayFixture();
  });

  it("records first USDC deposit with deterministic id and custody balance update", async () => {
    const amount = parseUnits("250", 6);
    const normalized = parseUnits("250", 18);

    const txHash = await approveAndDepositGateway(ctx, {
      token: ctx.usdc,
      amount,
      receiver: ctx.user.account.address,
    });

    const chainId = await ctx.publicClient.getChainId();
    const expectedDepositId = buildGatewayDepositId(ctx.gateway.address, BigInt(chainId), 1n);

    const event = await getGatewayEventArgs<GatewayDepositRecordedArgs>(ctx, txHash, "GatewayDepositRecorded");
    assert.equal(event.depositId.toLowerCase(), expectedDepositId.toLowerCase());
    assert.equal(event.sender.toLowerCase(), ctx.user.account.address.toLowerCase());
    assert.equal(event.token.toLowerCase(), ctx.usdc.address.toLowerCase());
    assert.equal(event.amountToken, amount);
    assert.equal(event.amountNormalized, normalized);
    assert.equal(event.receiver.toLowerCase(), ctx.user.account.address.toLowerCase());

    const gatewayUsdcBalance = await readTokenBalance(ctx, ctx.usdc, ctx.gateway.address);
    assert.equal(gatewayUsdcBalance, amount);
  });

  it("normalizes DAI deposit 1:1 (18 decimals)", async () => {
    const amount = parseUnits("42", 18);

    await approveAndDepositGateway(ctx, {
      token: ctx.dai,
      amount,
      receiver: ctx.user.account.address,
    });

    const gatewayDaiBalance = await readTokenBalance(ctx, ctx.dai, ctx.gateway.address);
    assert.equal(gatewayDaiBalance, amount);
  });

  it("rejects zero token", async () => {
    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.gateway.address,
        abi: ctx.gateway.abi,
        functionName: "deposit",
        args: [ZERO_ADDRESS, 1n, ctx.user.account.address],
      }),
      /ZeroAddress/,
    );
  });

  it("rejects zero amount", async () => {
    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.gateway.address,
        abi: ctx.gateway.abi,
        functionName: "deposit",
        args: [ctx.usdc.address, 0n, ctx.user.account.address],
      }),
      /AmountZero/,
    );
  });

  it("rejects zero receiver on deposit", async () => {
    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.gateway.address,
        abi: ctx.gateway.abi,
        functionName: "deposit",
        args: [ctx.usdc.address, 1n, ZERO_ADDRESS],
      }),
      /ZeroAddress/,
    );
  });

  it("rejects non-allowlisted token", async () => {
    const amount = parseUnits("5", 6);
    await ctx.user.writeContract({
      address: ctx.usdt.address,
      abi: ctx.usdt.abi,
      functionName: "approve",
      args: [ctx.gateway.address, amount],
    });

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.gateway.address,
        abi: ctx.gateway.abi,
        functionName: "deposit",
        args: [ctx.usdt.address, amount, ctx.user.account.address],
      }),
      /TokenNotAllowed/,
    );
  });

  it("enforces minDepositNormalized", async () => {
    await ctx.owner.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "setMinDeposit",
      args: [parseUnits("200", 18)],
    });

    const amount = parseUnits("50", 6);
    await ctx.user.writeContract({
      address: ctx.usdc.address,
      abi: ctx.usdc.abi,
      functionName: "approve",
      args: [ctx.gateway.address, amount],
    });

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.gateway.address,
        abi: ctx.gateway.abi,
        functionName: "deposit",
        args: [ctx.usdc.address, amount, ctx.user.account.address],
      }),
      /BelowMinDeposit/,
    );
  });

  it("pause blocks deposit flows and unpause re-enables", async () => {
    await ctx.owner.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "pause",
      args: [],
    });

    const amount = parseUnits("2", 6);
    await ctx.user.writeContract({
      address: ctx.usdc.address,
      abi: ctx.usdc.abi,
      functionName: "approve",
      args: [ctx.gateway.address, amount],
    });

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.gateway.address,
        abi: ctx.gateway.abi,
        functionName: "deposit",
        args: [ctx.usdc.address, amount, ctx.user.account.address],
      }),
      /(EnforcedPause|Pausable)/,
    );

    await ctx.owner.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "unpause",
      args: [],
    });

    await approveAndDepositGateway(ctx, {
      token: ctx.usdc,
      amount,
      receiver: ctx.user.account.address,
    });
  });

  it("remove/add allowlisted token updates deposit permissions", async () => {
    await ctx.owner.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "removeAllowedDepositToken",
      args: [ctx.usdc.address],
    });

    const amount = parseUnits("5", 6);
    await ctx.user.writeContract({
      address: ctx.usdc.address,
      abi: ctx.usdc.abi,
      functionName: "approve",
      args: [ctx.gateway.address, amount],
    });
    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.gateway.address,
        abi: ctx.gateway.abi,
        functionName: "deposit",
        args: [ctx.usdc.address, amount, ctx.user.account.address],
      }),
      /TokenNotAllowed/,
    );

    await ctx.owner.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "addAllowedDepositToken",
      args: [ctx.usdc.address],
    });

    await approveAndDepositGateway(ctx, {
      token: ctx.usdc,
      amount,
      receiver: ctx.user.account.address,
    });
  });

  it("rejects adding token with decimals greater than 18", async () => {
    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.gateway.address,
        abi: ctx.gateway.abi,
        functionName: "addAllowedDepositToken",
        args: [ctx.badDecimals.address],
      }),
      /DecimalsTooHigh/,
    );
  });
});
