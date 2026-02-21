import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { parseUnits } from "viem";
import { deployGatewayFixture } from "./gatewayFixtures.js";
import {
  type GatewayTestCtx,
  approveAndDepositGateway,
  getGatewayEventArgs,
  readTokenBalance,
} from "./hakoStableGatewayTestUtils.js";

type GatewayWithdrawalRequestedArgs = {
  requestId: bigint;
  owner: `0x${string}`;
  receiver: `0x${string}`;
  token: `0x${string}`;
  amountToken: bigint;
  amountNormalized: bigint;
};

type GatewayWithdrawalCompletedArgs = {
  requestId: bigint;
  receiver: `0x${string}`;
  token: `0x${string}`;
  amountToken: bigint;
};

type GatewayWithdrawalCanceledArgs = {
  requestId: bigint;
  token: `0x${string}`;
  amountToken: bigint;
};

const STATUS_PENDING = 1;
const STATUS_COMPLETED = 2;
const STATUS_CANCELED = 3;

describe("HakoStableGateway withdrawal lifecycle", () => {
  let ctx: GatewayTestCtx;

  beforeEach(async () => {
    ctx = await deployGatewayFixture();
  });

  async function seedUsdc(amount = "1000") {
    await approveAndDepositGateway(ctx, {
      token: ctx.usdc,
      amount: parseUnits(amount, 6),
      receiver: ctx.user.account.address,
    });
  }

  async function readRequest(requestId: bigint) {
    const [owner, receiver, token, amountToken, amountNormalized, status] = await ctx.publicClient.readContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "getWithdrawalRequest",
      args: [requestId],
    });

    return { owner, receiver, token, amountToken, amountNormalized, status: Number(status) };
  }

  it("creates local withdrawal request and stores bytes receiver payload", async () => {
    await seedUsdc("600");

    const txHash = await ctx.user.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "requestWithdrawal",
      args: [ctx.usdc.address, parseUnits("125", 6), ctx.user.account.address],
    });

    const event = await getGatewayEventArgs<GatewayWithdrawalRequestedArgs>(ctx, txHash, "GatewayWithdrawalRequested");
    assert.equal(event.requestId, 1n);
    assert.equal(event.owner.toLowerCase(), ctx.user.account.address.toLowerCase());
    assert.equal(event.receiver.toLowerCase(), ctx.user.account.address.toLowerCase());
    assert.equal(event.token.toLowerCase(), ctx.usdc.address.toLowerCase());
    assert.equal(event.amountToken, parseUnits("125", 6));
    assert.equal(event.amountNormalized, parseUnits("125", 18));

    const req = await readRequest(1n);
    assert.equal(req.owner.toLowerCase(), ctx.user.account.address.toLowerCase());
    assert.equal(req.receiver.toLowerCase(), ctx.user.account.address.toLowerCase());
    assert.equal(req.token.toLowerCase(), ctx.usdc.address.toLowerCase());
    assert.equal(req.amountToken, parseUnits("125", 6));
    assert.equal(req.amountNormalized, parseUnits("125", 18));
    assert.equal(req.status, STATUS_PENDING);

    const receiverBytes = await ctx.publicClient.readContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "getWithdrawalReceiver",
      args: [1n],
    });
    assert.equal(receiverBytes.toLowerCase(), ctx.user.account.address.toLowerCase());
  });

  it("does not reserve liquidity; request can exceed current custody balance", async () => {
    await seedUsdc("100");

    await ctx.user.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "requestWithdrawal",
      args: [ctx.usdc.address, parseUnits("150", 6), ctx.user.account.address],
    });

    const req = await readRequest(1n);
    assert.equal(req.amountToken, parseUnits("150", 6));
    assert.equal(req.status, STATUS_PENDING);
  });

  it("completes pending withdrawal and transfers payout to receiver", async () => {
    await seedUsdc("500");

    await ctx.user.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "requestWithdrawal",
      args: [ctx.usdc.address, parseUnits("120", 6), ctx.user.account.address],
    });

    const userBalanceBefore = await readTokenBalance(ctx, ctx.usdc, ctx.user.account.address);
    const gatewayBalanceBefore = await readTokenBalance(ctx, ctx.usdc, ctx.gateway.address);

    const txHash = await ctx.owner.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "completeWithdrawal",
      args: [1n],
    });

    const event = await getGatewayEventArgs<GatewayWithdrawalCompletedArgs>(ctx, txHash, "GatewayWithdrawalCompleted");
    assert.equal(event.requestId, 1n);
    assert.equal(event.receiver.toLowerCase(), ctx.user.account.address.toLowerCase());
    assert.equal(event.token.toLowerCase(), ctx.usdc.address.toLowerCase());
    assert.equal(event.amountToken, parseUnits("120", 6));

    const [userBalanceAfter, gatewayBalanceAfter] = await Promise.all([
      readTokenBalance(ctx, ctx.usdc, ctx.user.account.address),
      readTokenBalance(ctx, ctx.usdc, ctx.gateway.address),
    ]);
    assert.equal(userBalanceAfter, userBalanceBefore + parseUnits("120", 6));
    assert.equal(gatewayBalanceAfter, gatewayBalanceBefore - parseUnits("120", 6));

    const req = await readRequest(1n);
    assert.equal(req.status, STATUS_COMPLETED);
  });

  it("completeWithdrawal reverts when gateway token balance is insufficient", async () => {
    await seedUsdc("100");

    await ctx.user.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "requestWithdrawal",
      args: [ctx.usdc.address, parseUnits("150", 6), ctx.user.account.address],
    });

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.gateway.address,
        abi: ctx.gateway.abi,
        functionName: "completeWithdrawal",
        args: [1n],
      }),
      /ERC20InsufficientBalance/,
    );
  });

  it("cancels pending withdrawal", async () => {
    await seedUsdc("500");

    await ctx.user.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "requestWithdrawal",
      args: [ctx.usdc.address, parseUnits("80", 6), ctx.user.account.address],
    });

    const txHash = await ctx.owner.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "cancelWithdrawal",
      args: [1n],
    });

    const event = await getGatewayEventArgs<GatewayWithdrawalCanceledArgs>(ctx, txHash, "GatewayWithdrawalCanceled");
    assert.equal(event.requestId, 1n);
    assert.equal(event.amountToken, parseUnits("80", 6));

    const req = await readRequest(1n);
    assert.equal(req.status, STATUS_CANCELED);
  });

  it("rejects complete and cancel on non-pending request", async () => {
    await seedUsdc("300");
    await ctx.user.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "requestWithdrawal",
      args: [ctx.usdc.address, parseUnits("20", 6), ctx.user.account.address],
    });

    await ctx.owner.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "cancelWithdrawal",
      args: [1n],
    });

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.gateway.address,
        abi: ctx.gateway.abi,
        functionName: "completeWithdrawal",
        args: [1n],
      }),
      /WithdrawalNotPending/,
    );

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.gateway.address,
        abi: ctx.gateway.abi,
        functionName: "cancelWithdrawal",
        args: [1n],
      }),
      /WithdrawalNotPending/,
    );
  });

  it("supports completing and canceling while paused", async () => {
    await seedUsdc("400");

    await ctx.user.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "requestWithdrawal",
      args: [ctx.usdc.address, parseUnits("100", 6), ctx.user.account.address],
    });
    await ctx.user.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "requestWithdrawal",
      args: [ctx.usdc.address, parseUnits("50", 6), ctx.user.account.address],
    });

    await ctx.owner.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "pause",
      args: [],
    });

    await ctx.owner.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "completeWithdrawal",
      args: [1n],
    });
    await ctx.owner.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "cancelWithdrawal",
      args: [2n],
    });

    const req1 = await readRequest(1n);
    const req2 = await readRequest(2n);
    assert.equal(req1.status, STATUS_COMPLETED);
    assert.equal(req2.status, STATUS_CANCELED);
  });
});
