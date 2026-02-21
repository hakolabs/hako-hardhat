import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { keccak256, parseUnits, type Hex } from "viem";
import { deployFixture } from "./fixtures.js";
import {
  type VaultTestCtx,
  approveAndDeposit,
  getEventArgs,
  pricePerShareX18,
  readSupplyAndAssets,
} from "./hakoStableVaultTestUtils.js";

type WithdrawalRequestedArgs = {
  requestId: bigint;
  owner: `0x${string}`;
  dstChainId: bigint;
  token: `0x${string}`;
  receiver: Hex;
  amountNormalized: bigint;
  sharesLocked: bigint;
};

type WithdrawalCompletedArgs = {
  requestId: bigint;
  owner: `0x${string}`;
  sharesBurned: bigint;
  amountNormalized: bigint;
};

type WithdrawalCanceledArgs = {
  requestId: bigint;
  owner: `0x${string}`;
  sharesUnlocked: bigint;
};

type WithdrawalRequestView = {
  owner: `0x${string}`;
  receiver: `0x${string}`;
  dstChainId: bigint;
  token: `0x${string}`;
  amountNormalized: bigint;
  sharesLocked: bigint;
  status: number;
};

const USDC_DECIMALS = 6;
const WITHDRAW_STATUS_PENDING = 1;
const WITHDRAW_STATUS_COMPLETED = 2;
const WITHDRAW_STATUS_CANCELED = 3;

function denormalizeToToken(amountNormalized: bigint, decimals: number): bigint {
  const factor = 10n ** BigInt(18 - decimals);
  return amountNormalized / factor;
}

describe("HakoStableVault withdrawal flows", () => {
  let ctx: VaultTestCtx;

  beforeEach(async () => {
    ctx = await deployFixture();
  });

  async function seedUserDeposit(amountUsdc: string) {
    await approveAndDeposit(ctx, {
      token: ctx.usdc,
      amount: parseUnits(amountUsdc, USDC_DECIMALS),
      receiver: ctx.user.account.address,
    });
  }

  async function requestByAmount(amountNormalized: bigint, maxShares: bigint) {
    return ctx.user.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "requestWithdrawal",
      args: [ctx.user.account.address, 8453n, ctx.usdc.address, amountNormalized, maxShares],
    });
  }

  async function readRequest(requestId: bigint): Promise<WithdrawalRequestView> {
    const [owner, receiver, dstChainId, token, amountNormalized, sharesLocked, status] =
      await ctx.publicClient.readContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "getWithdrawalRequest",
        args: [requestId],
      });

    return {
      owner,
      receiver,
      dstChainId,
      token,
      amountNormalized,
      sharesLocked,
      status: Number(status),
    };
  }

  it("stores amount-based request with expected lock and final token value", async () => {
    await seedUserDeposit("1000");

    const txHash = await requestByAmount(parseUnits("100", 18), parseUnits("100", 18));
    const event = await getEventArgs<WithdrawalRequestedArgs>(ctx, txHash, "WithdrawalRequested");

    assert.equal(event.amountNormalized, parseUnits("100", 18));
    assert.equal(event.sharesLocked, parseUnits("100", 18));

    const request = await readRequest(1n);
    assert.equal(request.owner.toLowerCase(), ctx.user.account.address.toLowerCase());
    assert.equal(request.receiver.toLowerCase(), ctx.user.account.address.toLowerCase());
    assert.equal(request.dstChainId, 8453n);
    assert.equal(request.token.toLowerCase(), ctx.usdc.address.toLowerCase());
    assert.equal(request.status, WITHDRAW_STATUS_PENDING);

    const rawUsdc = denormalizeToToken(request.amountNormalized, USDC_DECIMALS);
    assert.equal(rawUsdc, parseUnits("100", USDC_DECIMALS));

    const locked = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "lockedShares",
      args: [ctx.user.account.address],
    });
    assert.equal(locked, parseUnits("100", 18));
  });

  it("requestRedeem at non-1 PPS computes expected final token amount", async () => {
    await seedUserDeposit("1000");

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "adjustManagedAssets",
      args: [parseUnits("500", 18)],
    });

    const txHash = await ctx.user.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "requestRedeem",
      args: [ctx.user.account.address, 8453n, ctx.usdc.address, parseUnits("100", 18), parseUnits("150", 18)],
    });

    const event = await getEventArgs<WithdrawalRequestedArgs>(ctx, txHash, "WithdrawalRequested");
    assert.equal(event.sharesLocked, parseUnits("100", 18));
    assert.equal(event.amountNormalized, parseUnits("150", 18));

    const request = await readRequest(1n);
    assert.equal(request.amountNormalized, parseUnits("150", 18));
    assert.equal(denormalizeToToken(request.amountNormalized, USDC_DECIMALS), parseUnits("150", USDC_DECIMALS));
  });

  it("completeWithdrawal settles request and preserves 1.0 PPS when no PnL change", async () => {
    await seedUserDeposit("1000");
    await requestByAmount(parseUnits("120", 18), parseUnits("120", 18));

    const before = await readSupplyAndAssets(ctx);
    const ppsBefore = await pricePerShareX18(ctx);

    const txHash = await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "completeWithdrawal",
      args: [1n],
    });

    const event = await getEventArgs<WithdrawalCompletedArgs>(ctx, txHash, "WithdrawalCompleted");
    assert.equal(event.requestId, 1n);
    assert.equal(event.amountNormalized, parseUnits("120", 18));
    assert.equal(event.sharesBurned, parseUnits("120", 18));

    const request = await readRequest(1n);
    assert.equal(request.status, WITHDRAW_STATUS_COMPLETED);

    const after = await readSupplyAndAssets(ctx);
    assert.equal(after.supply, before.supply - parseUnits("120", 18));
    assert.equal(after.assets, before.assets - parseUnits("120", 18));

    const ppsAfter = await pricePerShareX18(ctx);
    assert.equal(ppsBefore, parseUnits("1", 18));
    assert.equal(ppsAfter, parseUnits("1", 18));
  });

  it("cancelWithdrawal unlocks shares and keeps amounts/supply unchanged", async () => {
    await seedUserDeposit("1000");
    await requestByAmount(parseUnits("90", 18), parseUnits("90", 18));

    const before = await readSupplyAndAssets(ctx);

    const txHash = await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "cancelWithdrawal",
      args: [1n],
    });

    const event = await getEventArgs<WithdrawalCanceledArgs>(ctx, txHash, "WithdrawalCanceled");
    assert.equal(event.requestId, 1n);
    assert.equal(event.sharesUnlocked, parseUnits("90", 18));

    const request = await readRequest(1n);
    assert.equal(request.status, WITHDRAW_STATUS_CANCELED);

    const locked = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "lockedShares",
      args: [ctx.user.account.address],
    });
    assert.equal(locked, 0n);

    const after = await readSupplyAndAssets(ctx);
    assert.equal(after.supply, before.supply);
    assert.equal(after.assets, before.assets);
  });

  it("supports multiple pending requests with cumulative locks", async () => {
    await seedUserDeposit("1000");

    await requestByAmount(parseUnits("100", 18), parseUnits("100", 18));
    await requestByAmount(parseUnits("150", 18), parseUnits("150", 18));

    const locked = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "lockedShares",
      args: [ctx.user.account.address],
    });
    assert.equal(locked, parseUnits("250", 18));

    const req1 = await readRequest(1n);
    const req2 = await readRequest(2n);
    assert.equal(req1.status, WITHDRAW_STATUS_PENDING);
    assert.equal(req2.status, WITHDRAW_STATUS_PENDING);
    assert.equal(req1.amountNormalized, parseUnits("100", 18));
    assert.equal(req2.amountNormalized, parseUnits("150", 18));
  });

  it("completes multiple pending requests in reverse order with correct totals", async () => {
    await seedUserDeposit("1000");

    await requestByAmount(parseUnits("100", 18), parseUnits("100", 18));
    await requestByAmount(parseUnits("150", 18), parseUnits("150", 18));

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "completeWithdrawal",
      args: [2n],
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "completeWithdrawal",
      args: [1n],
    });

    const req1 = await readRequest(1n);
    const req2 = await readRequest(2n);
    assert.equal(req1.status, WITHDRAW_STATUS_COMPLETED);
    assert.equal(req2.status, WITHDRAW_STATUS_COMPLETED);

    const locked = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "lockedShares",
      args: [ctx.user.account.address],
    });
    assert.equal(locked, 0n);

    const { supply, assets } = await readSupplyAndAssets(ctx);
    assert.equal(supply, parseUnits("750", 18));
    assert.equal(assets, parseUnits("750", 18));
    assert.equal(await pricePerShareX18(ctx), parseUnits("1", 18));
  });

  it("keeps pending request values unchanged while local and remote deposits happen", async () => {
    await seedUserDeposit("1000");
    await requestByAmount(parseUnits("200", 18), parseUnits("200", 18));

    await approveAndDeposit(ctx, {
      token: ctx.usdc,
      amount: parseUnits("300", USDC_DECIMALS),
      receiver: ctx.user.account.address,
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "recordRemoteDeposit",
      args: [keccak256("0xaaaabbbb"), ctx.owner.account.address, parseUnits("250", 18)],
    });

    const req = await readRequest(1n);
    assert.equal(req.amountNormalized, parseUnits("200", 18));
    assert.equal(req.sharesLocked, parseUnits("200", 18));

    const { supply, assets } = await readSupplyAndAssets(ctx);
    assert.equal(supply, parseUnits("1550", 18));
    assert.equal(assets, parseUnits("1550", 18));
    assert.equal(await pricePerShareX18(ctx), parseUnits("1", 18));
  });

  it("completes pending request correctly after local and remote deposits during pending", async () => {
    await seedUserDeposit("1000");
    await requestByAmount(parseUnits("200", 18), parseUnits("200", 18));

    await approveAndDeposit(ctx, {
      token: ctx.usdc,
      amount: parseUnits("300", USDC_DECIMALS),
      receiver: ctx.user.account.address,
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "recordRemoteDeposit",
      args: [keccak256("0xccccdddd"), ctx.owner.account.address, parseUnits("250", 18)],
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "completeWithdrawal",
      args: [1n],
    });

    const req = await readRequest(1n);
    assert.equal(req.status, WITHDRAW_STATUS_COMPLETED);

    const { supply, assets } = await readSupplyAndAssets(ctx);
    assert.equal(supply, parseUnits("1350", 18));
    assert.equal(assets, parseUnits("1350", 18));
    assert.equal(await pricePerShareX18(ctx), parseUnits("1", 18));
  });

  it("keeps state valid by reverting completion when assets are below pending request amount", async () => {
    await seedUserDeposit("1000");
    await requestByAmount(parseUnits("100", 18), parseUnits("100", 18));

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "adjustManagedAssets",
      args: [-parseUnits("950", 18)],
    });

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "completeWithdrawal",
        args: [1n],
      }),
      /ManagedAssetsUnderflow/,
    );

    const req = await readRequest(1n);
    assert.equal(req.status, WITHDRAW_STATUS_PENDING);

    const locked = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "lockedShares",
      args: [ctx.user.account.address],
    });
    assert.equal(locked, parseUnits("100", 18));
  });

  it("shows fixed-amount settlement effect: completion after profit increases PPS", async () => {
    await seedUserDeposit("1000");
    await requestByAmount(parseUnits("100", 18), parseUnits("100", 18));

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "adjustManagedAssets",
      args: [parseUnits("500", 18)],
    });

    const ppsBeforeComplete = await pricePerShareX18(ctx);

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "completeWithdrawal",
      args: [1n],
    });

    const ppsAfterComplete = await pricePerShareX18(ctx);
    assert.equal(ppsBeforeComplete, parseUnits("1.5", 18));
    assert.ok(ppsAfterComplete > ppsBeforeComplete);
  });

  it("shows fixed-amount settlement effect: completion after loss decreases PPS", async () => {
    await seedUserDeposit("1000");
    await requestByAmount(parseUnits("100", 18), parseUnits("100", 18));

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "adjustManagedAssets",
      args: [-parseUnits("500", 18)],
    });

    const ppsBeforeComplete = await pricePerShareX18(ctx);

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "completeWithdrawal",
      args: [1n],
    });

    const ppsAfterComplete = await pricePerShareX18(ctx);
    assert.equal(ppsBeforeComplete, parseUnits("0.5", 18));
    assert.ok(ppsAfterComplete < ppsBeforeComplete);
  });
});
