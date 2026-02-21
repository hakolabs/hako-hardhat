import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { keccak256, parseUnits, type Hex } from "viem";
import { deployFixture, derivePseudoAddress } from "./fixtures.js";
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

type DepositRecordedArgs = {
  depositId: Hex;
  receiver: `0x${string}`;
  amountNormalized: bigint;
  sharesMinted: bigint;
  remote: boolean;
};

describe("HakoStableVault share-price evolution", () => {
  let ctx: VaultTestCtx;

  beforeEach(async () => {
    ctx = await deployFixture();
  });

  it("starts at 1.0 PPS after first local deposit", async () => {
    await approveAndDeposit(ctx, { token: ctx.usdc, amount: parseUnits("1000", 6), receiver: ctx.user.account.address });

    const pps = await pricePerShareX18(ctx);
    assert.equal(pps, parseUnits("1", 18));
  });

  it("keeps PPS constant across proportional local deposits", async () => {
    await approveAndDeposit(ctx, { token: ctx.usdc, amount: parseUnits("1000", 6), receiver: ctx.user.account.address });
    const ppsBefore = await pricePerShareX18(ctx);

    await approveAndDeposit(ctx, { token: ctx.usdc, amount: parseUnits("250", 6), receiver: ctx.owner.account.address });
    const ppsAfter = await pricePerShareX18(ctx);

    assert.equal(ppsBefore, parseUnits("1", 18));
    assert.equal(ppsAfter, parseUnits("1", 18));
  });

  it("increases PPS after profit and mints fewer shares for next local deposit", async () => {
    await approveAndDeposit(ctx, { token: ctx.usdc, amount: parseUnits("1000", 6), receiver: ctx.user.account.address });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "adjustManagedAssets",
      args: [parseUnits("500", 18)],
    });

    const ppsAfterProfit = await pricePerShareX18(ctx);
    assert.equal(ppsAfterProfit, parseUnits("1.5", 18));

    await approveAndDeposit(ctx, { token: ctx.usdc, amount: parseUnits("300", 6), receiver: ctx.owner.account.address });

    const ownerShares = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "balanceOf",
      args: [ctx.owner.account.address],
    });

    assert.equal(ownerShares, parseUnits("200", 18));

    const { supply, assets } = await readSupplyAndAssets(ctx);
    assert.equal(supply, parseUnits("1200", 18));
    assert.equal(assets, parseUnits("1800", 18));
    assert.equal(await pricePerShareX18(ctx), parseUnits("1.5", 18));
  });

  it("decreases PPS after loss and mints more shares for next local deposit", async () => {
    await approveAndDeposit(ctx, { token: ctx.usdc, amount: parseUnits("1000", 6), receiver: ctx.user.account.address });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "adjustManagedAssets",
      args: [-parseUnits("250", 18)],
    });

    const ppsAfterLoss = await pricePerShareX18(ctx);
    assert.equal(ppsAfterLoss, parseUnits("0.75", 18));

    await approveAndDeposit(ctx, { token: ctx.usdc, amount: parseUnits("150", 6), receiver: ctx.owner.account.address });

    const ownerShares = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "balanceOf",
      args: [ctx.owner.account.address],
    });

    assert.equal(ownerShares, parseUnits("200", 18));

    const { supply, assets } = await readSupplyAndAssets(ctx);
    assert.equal(supply, parseUnits("1200", 18));
    assert.equal(assets, parseUnits("900", 18));
    assert.equal(await pricePerShareX18(ctx), parseUnits("0.75", 18));
  });

  it("uses same mint math for remote EVM deposit at non-1 PPS", async () => {
    await approveAndDeposit(ctx, { token: ctx.usdc, amount: parseUnits("1000", 6), receiver: ctx.user.account.address });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "adjustManagedAssets",
      args: [parseUnits("500", 18)],
    });

    const txHash = await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "recordRemoteDeposit",
      args: [keccak256("0xabcdef"), ctx.owner.account.address, parseUnits("300", 18)],
    });

    const args = await getEventArgs<DepositRecordedArgs>(ctx, txHash, "DepositRecorded");
    assert.equal(args.sharesMinted, parseUnits("200", 18));
    assert.equal(args.remote, true);

    assert.equal(await pricePerShareX18(ctx), parseUnits("1.5", 18));
  });

  it("uses same mint math for remote non-EVM deposit at non-1 PPS", async () => {
    await approveAndDeposit(ctx, { token: ctx.usdc, amount: parseUnits("1000", 6), receiver: ctx.user.account.address });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "adjustManagedAssets",
      args: [-parseUnits("250", 18)],
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "recordRemoteDepositNonEvm",
      args: [keccak256("0x123456"), 2423n, "user.near", parseUnits("150", 18)],
    });

    const pseudo = derivePseudoAddress(2423n, "user.near");
    const pseudoBalance = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "balanceOf",
      args: [pseudo],
    });

    assert.equal(pseudoBalance, parseUnits("200", 18));
    assert.equal(await pricePerShareX18(ctx), parseUnits("0.75", 18));
  });

  it("locks shares on requestWithdrawal without changing supply/assets/PPS", async () => {
    await approveAndDeposit(ctx, { token: ctx.usdc, amount: parseUnits("1000", 6), receiver: ctx.user.account.address });

    const before = await readSupplyAndAssets(ctx);
    const ppsBefore = await pricePerShareX18(ctx);

    const txHash = await ctx.user.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "requestWithdrawal",
      args: [ctx.user.account.address, 8453n, ctx.usdc.address, parseUnits("100", 18), parseUnits("100", 18)],
    });

    const req = await getEventArgs<WithdrawalRequestedArgs>(ctx, txHash, "WithdrawalRequested");
    assert.equal(req.sharesLocked, parseUnits("100", 18));

    const locked = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "lockedShares",
      args: [ctx.user.account.address],
    });
    assert.equal(locked, parseUnits("100", 18));

    const after = await readSupplyAndAssets(ctx);
    const ppsAfter = await pricePerShareX18(ctx);

    assert.equal(after.supply, before.supply);
    assert.equal(after.assets, before.assets);
    assert.equal(ppsAfter, ppsBefore);
  });

  it("locks exact shares on requestRedeem without changing supply/assets/PPS", async () => {
    await approveAndDeposit(ctx, { token: ctx.usdc, amount: parseUnits("1000", 6), receiver: ctx.user.account.address });

    const before = await readSupplyAndAssets(ctx);

    const txHash = await ctx.user.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "requestRedeem",
      args: [ctx.user.account.address, 8453n, ctx.usdc.address, parseUnits("250", 18), parseUnits("250", 18)],
    });

    const req = await getEventArgs<WithdrawalRequestedArgs>(ctx, txHash, "WithdrawalRequested");
    assert.equal(req.sharesLocked, parseUnits("250", 18));
    assert.equal(req.amountNormalized, parseUnits("250", 18));

    const after = await readSupplyAndAssets(ctx);
    assert.equal(after.supply, before.supply);
    assert.equal(after.assets, before.assets);
    assert.equal(await pricePerShareX18(ctx), parseUnits("1", 18));
  });

  it("cancelWithdrawal unlocks shares only and preserves PPS", async () => {
    await approveAndDeposit(ctx, { token: ctx.usdc, amount: parseUnits("1000", 6), receiver: ctx.user.account.address });

    await ctx.user.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "requestWithdrawal",
      args: [ctx.user.account.address, 8453n, ctx.usdc.address, parseUnits("120", 18), parseUnits("120", 18)],
    });

    const beforeCancel = await readSupplyAndAssets(ctx);
    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "cancelWithdrawal",
      args: [1n],
    });

    const locked = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "lockedShares",
      args: [ctx.user.account.address],
    });
    assert.equal(locked, 0n);

    const afterCancel = await readSupplyAndAssets(ctx);
    assert.equal(afterCancel.supply, beforeCancel.supply);
    assert.equal(afterCancel.assets, beforeCancel.assets);
    assert.equal(await pricePerShareX18(ctx), parseUnits("1", 18));
  });

  it("completeWithdrawal updates supply/assets consistently with locked request", async () => {
    await approveAndDeposit(ctx, { token: ctx.usdc, amount: parseUnits("1000", 6), receiver: ctx.user.account.address });
    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "adjustManagedAssets",
      args: [parseUnits("500", 18)],
    });

    const txHash = await ctx.user.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "requestWithdrawal",
      args: [ctx.user.account.address, 8453n, ctx.usdc.address, parseUnits("100", 18), parseUnits("67", 18)],
    });

    const req = await getEventArgs<WithdrawalRequestedArgs>(ctx, txHash, "WithdrawalRequested");
    assert.equal(req.sharesLocked, parseUnits("66.666666666666666667", 18));

    const beforeComplete = await readSupplyAndAssets(ctx);

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "completeWithdrawal",
      args: [1n],
    });

    const afterComplete = await readSupplyAndAssets(ctx);

    assert.equal(afterComplete.supply, beforeComplete.supply - req.sharesLocked);
    assert.equal(afterComplete.assets, beforeComplete.assets - parseUnits("100", 18));

    const left = afterComplete.assets * beforeComplete.supply;
    const right = beforeComplete.assets * afterComplete.supply;
    assert.ok(left >= right);
  });

  it("enforces locked-share transfer limit without changing PPS", async () => {
    await approveAndDeposit(ctx, { token: ctx.usdc, amount: parseUnits("1000", 6), receiver: ctx.user.account.address });

    await ctx.user.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "requestWithdrawal",
      args: [ctx.user.account.address, 8453n, ctx.usdc.address, parseUnits("100", 18), parseUnits("100", 18)],
    });

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "transfer",
        args: [ctx.owner.account.address, parseUnits("901", 18)],
      }),
      /InsufficientUnlockedShares/,
    );

    await ctx.user.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "transfer",
      args: [ctx.owner.account.address, parseUnits("900", 18)],
    });

    const pps = await pricePerShareX18(ctx);
    assert.equal(pps, parseUnits("1", 18));
  });

  it("does not mint performance fee shares while PPS stays below HWM", async () => {
    await approveAndDeposit(ctx, { token: ctx.usdc, amount: parseUnits("1000", 6), receiver: ctx.user.account.address });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "setPerformanceFee",
      args: [1_000n],
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "setFeeRecipient",
      args: [ctx.owner.account.address],
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "adjustManagedAssets",
      args: [-parseUnits("200", 18)],
    });

    const ownerSharesBeforeRecovery = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "balanceOf",
      args: [ctx.owner.account.address],
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "adjustManagedAssets",
      args: [parseUnits("100", 18)],
    });

    const ownerSharesAfterRecovery = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "balanceOf",
      args: [ctx.owner.account.address],
    });

    assert.equal(ownerSharesAfterRecovery, ownerSharesBeforeRecovery);
    assert.equal(await pricePerShareX18(ctx), parseUnits("0.9", 18));

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "adjustManagedAssets",
      args: [parseUnits("200", 18)],
    });

    const ownerSharesAfterCrossing = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "balanceOf",
      args: [ctx.owner.account.address],
    });

    const hwm = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "highWaterMark",
      args: [],
    });

    assert.ok(ownerSharesAfterCrossing > ownerSharesAfterRecovery);
    assert.ok(hwm > parseUnits("1", 18));
  });
});
