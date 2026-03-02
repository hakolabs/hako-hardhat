import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { keccak256, parseUnits } from "viem";
import { deployFixture } from "./fixtures.js";
import { type VaultTestCtx, approveAndDeposit } from "./hakoStableVaultTestUtils.js";

const STATUS_PENDING = 1;
const STATUS_COMPLETED = 2;

describe("HakoStableVault home-chain payout-on-complete", () => {
  let ctx: VaultTestCtx;
  let localChainId: bigint;
  let remoteChainId: bigint;

  beforeEach(async () => {
    ctx = await deployFixture();
    localChainId = BigInt(await ctx.publicClient.getChainId());
    remoteChainId = localChainId === 8453n ? 10n : 8453n;

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "setDestinationChainAllowed",
      args: [localChainId, true],
    });
    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "setDestinationAssetAllowed",
      args: [localChainId, ctx.usdc.address, true],
    });
  });

  async function seedDeposit(amount = "1000") {
    await approveAndDeposit(ctx, {
      token: ctx.usdc,
      amount: parseUnits(amount, 6),
      receiver: ctx.user.account.address,
    });
  }

  async function readRequestStatus(requestId: bigint): Promise<number> {
    const request = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "getWithdrawalRequest",
      args: [requestId],
    });

    return Number(request[6]);
  }

  it("marks pending local request for payout-on-complete", async () => {
    await seedDeposit("600");

    await ctx.user.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "requestWithdrawal",
      args: [
        ctx.user.account.address,
        localChainId,
        ctx.usdc.address,
        parseUnits("100", 18),
        parseUnits("100", 18),
      ],
    });

    const marked = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "isWithdrawalPayoutOnComplete",
      args: [1n],
    });

    assert.equal(marked, true);
    assert.equal(await readRequestStatus(1n), STATUS_PENDING);
  });

  it("does not auto-mark payout-on-complete when destination chain is remote", async () => {
    await seedDeposit("600");

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "setDestinationChainAllowed",
      args: [remoteChainId, true],
    });
    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "setDestinationAssetAllowed",
      args: [remoteChainId, ctx.usdc.address, true],
    });
    await ctx.user.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "requestWithdrawal",
      args: [
        ctx.user.account.address,
        remoteChainId,
        ctx.usdc.address,
        parseUnits("100", 18),
        parseUnits("100", 18),
      ],
    });

    const marked = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "isWithdrawalPayoutOnComplete",
      args: [1n],
    });
    assert.equal(marked, false);
  });

  it("completeWithdrawal pays receiver for auto-marked local requests", async () => {
    await seedDeposit("600");

    await ctx.user.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "requestWithdrawal",
      args: [
        ctx.user.account.address,
        localChainId,
        ctx.usdc.address,
        parseUnits("100", 18),
        parseUnits("100", 18),
      ],
    });

    const balanceBefore = await ctx.publicClient.readContract({
      address: ctx.usdc.address,
      abi: ctx.usdc.abi,
      functionName: "balanceOf",
      args: [ctx.user.account.address],
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "completeWithdrawal",
      args: [1n],
    });

    const balanceAfter = await ctx.publicClient.readContract({
      address: ctx.usdc.address,
      abi: ctx.usdc.abi,
      functionName: "balanceOf",
      args: [ctx.user.account.address],
    });

    assert.equal(balanceAfter - balanceBefore, parseUnits("100", 6));
    assert.equal(await readRequestStatus(1n), STATUS_COMPLETED);
  });

  it("keeps legacy completeWithdrawal behavior for non-marked remote requests", async () => {
    await seedDeposit("600");

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "setDestinationChainAllowed",
      args: [remoteChainId, true],
    });
    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "setDestinationAssetAllowed",
      args: [remoteChainId, ctx.usdc.address, true],
    });

    await ctx.user.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "requestWithdrawal",
      args: [
        ctx.user.account.address,
        remoteChainId,
        ctx.usdc.address,
        parseUnits("80", 18),
        parseUnits("80", 18),
      ],
    });

    const balanceBefore = await ctx.publicClient.readContract({
      address: ctx.usdc.address,
      abi: ctx.usdc.abi,
      functionName: "balanceOf",
      args: [ctx.user.account.address],
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "completeWithdrawal",
      args: [1n],
    });

    const balanceAfter = await ctx.publicClient.readContract({
      address: ctx.usdc.address,
      abi: ctx.usdc.abi,
      functionName: "balanceOf",
      args: [ctx.user.account.address],
    });

    assert.equal(balanceAfter, balanceBefore);
    assert.equal(await readRequestStatus(1n), STATUS_COMPLETED);
  });

  it("reverts completion for auto-marked local requests when vault lacks payout liquidity", async () => {
    await seedDeposit("250");

    await ctx.user.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "requestWithdrawal",
      args: [
        ctx.user.account.address,
        localChainId,
        ctx.usdc.address,
        parseUnits("200", 18),
        parseUnits("200", 18),
      ],
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "transferOut",
      args: [
        keccak256("0x1111"),
        ctx.usdc.address,
        ctx.owner.account.address,
        parseUnits("150", 6),
        keccak256("0x02"),
      ],
    });

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "completeWithdrawal",
        args: [1n],
      }),
      /ERC20InsufficientBalance/,
    );

    assert.equal(await readRequestStatus(1n), STATUS_PENDING);
  });
});
