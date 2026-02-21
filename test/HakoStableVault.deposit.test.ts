import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { keccak256, parseUnits, type Hex } from "viem";
import { buildDepositId, deployFixture, derivePseudoAddress } from "./fixtures.js";
import {
  ZERO_ADDRESS,
  type VaultTestCtx,
  approveAndDeposit,
  expectTotals,
  getEventArgs,
} from "./hakoStableVaultTestUtils.js";

type DepositRecordedArgs = {
  depositId: Hex;
  receiver: `0x${string}`;
  amountNormalized: bigint;
  sharesMinted: bigint;
  remote: boolean;
};

type NonEvmDepositRecordedArgs = {
  depositId: Hex;
  chainId: bigint;
  accountId: string;
  pseudoReceiver: `0x${string}`;
  amountNormalized: bigint;
  sharesMinted: bigint;
};

describe("HakoStableVault deposits", () => {
  let ctx: VaultTestCtx;

  beforeEach(async () => {
    ctx = await deployFixture();
  });

  it("mints normalized shares on first USDC deposit", async () => {
    const amount = parseUnits("500", 6);
    const normalized = parseUnits("500", 18);

    await approveAndDeposit(ctx, {
      token: ctx.usdc,
      amount,
      receiver: ctx.user.account.address,
    });

    const [balance, locked] = await Promise.all([
      ctx.publicClient.readContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "balanceOf",
        args: [ctx.user.account.address],
      }),
      ctx.publicClient.readContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "lockedShares",
        args: [ctx.user.account.address],
      }),
    ]);

    assert.equal(balance, normalized);
    assert.equal(locked, 0n);
    await expectTotals(ctx, normalized, normalized);
  });

  it("mints normalized shares on first DAI deposit (18 decimals)", async () => {
    const amount = parseUnits("123", 18);

    await approveAndDeposit(ctx, {
      token: ctx.dai,
      amount,
      receiver: ctx.user.account.address,
    });

    const balance = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "balanceOf",
      args: [ctx.user.account.address],
    });

    assert.equal(balance, amount);
    await expectTotals(ctx, amount, amount);
  });

  it("mints to receiver distinct from sender", async () => {
    const amount = parseUnits("50", 6);
    const normalized = parseUnits("50", 18);

    const userBalanceBefore = await ctx.publicClient.readContract({
      address: ctx.usdc.address,
      abi: ctx.usdc.abi,
      functionName: "balanceOf",
      args: [ctx.user.account.address],
    });

    await approveAndDeposit(ctx, {
      token: ctx.usdc,
      amount,
      receiver: ctx.owner.account.address,
    });

    const [userUsdcAfter, senderShares, receiverShares] = await Promise.all([
      ctx.publicClient.readContract({
        address: ctx.usdc.address,
        abi: ctx.usdc.abi,
        functionName: "balanceOf",
        args: [ctx.user.account.address],
      }),
      ctx.publicClient.readContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "balanceOf",
        args: [ctx.user.account.address],
      }),
      ctx.publicClient.readContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "balanceOf",
        args: [ctx.owner.account.address],
      }),
    ]);

    assert.equal(userUsdcAfter, userBalanceBefore - amount);
    assert.equal(senderShares, 0n);
    assert.equal(receiverShares, normalized);
    await expectTotals(ctx, normalized, normalized);
  });

  it("emits DepositRecorded with remote=false and expected depositId", async () => {
    const amount = parseUnits("10", 6);
    const normalized = parseUnits("10", 18);

    const txHash = await approveAndDeposit(ctx, {
      token: ctx.usdc,
      amount,
      receiver: ctx.user.account.address,
    });

    const chainId = await ctx.publicClient.getChainId();
    const expectedDepositId = buildDepositId(ctx.stableVault.address, BigInt(chainId), 1n);

    const args = await getEventArgs<DepositRecordedArgs>(ctx, txHash, "DepositRecorded");

    assert.equal(args.depositId.toLowerCase(), expectedDepositId.toLowerCase());
    assert.equal(args.receiver.toLowerCase(), ctx.user.account.address.toLowerCase());
    assert.equal(args.amountNormalized, normalized);
    assert.equal(args.sharesMinted, normalized);
    assert.equal(args.remote, false);
  });

  it("rejects zero token address", async () => {
    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "deposit",
        args: [ZERO_ADDRESS, 1n, ctx.user.account.address],
      }),
      /ZeroAddress/,
    );
  });

  it("rejects zero receiver address", async () => {
    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "deposit",
        args: [ctx.usdc.address, 1n, ZERO_ADDRESS],
      }),
      /ZeroAddress/,
    );
  });

  it("rejects zero amount", async () => {
    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "deposit",
        args: [ctx.usdc.address, 0n, ctx.user.account.address],
      }),
      /AmountZero/,
    );
  });

  it("rejects non-allowlisted token", async () => {
    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "removeAllowedDepositToken",
      args: [ctx.usdc.address],
    });

    const amount = parseUnits("1", 6);
    await ctx.user.writeContract({
      address: ctx.usdc.address,
      abi: ctx.usdc.abi,
      functionName: "approve",
      args: [ctx.stableVault.address, amount],
    });

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "deposit",
        args: [ctx.usdc.address, amount, ctx.user.account.address],
      }),
      /TokenNotAllowed/,
    );
  });

  it("rejects deposit below minDepositNormalized", async () => {
    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "setMinDeposit",
      args: [parseUnits("1000", 18)],
    });

    const amount = parseUnits("1", 6);
    await ctx.user.writeContract({
      address: ctx.usdc.address,
      abi: ctx.usdc.abi,
      functionName: "approve",
      args: [ctx.stableVault.address, amount],
    });

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "deposit",
        args: [ctx.usdc.address, amount, ctx.user.account.address],
      }),
      /BelowMinDeposit/,
    );
  });

  it("reverts deposit when paused", async () => {
    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "pause",
      args: [],
    });

    const amount = parseUnits("1", 6);
    await ctx.user.writeContract({
      address: ctx.usdc.address,
      abi: ctx.usdc.abi,
      functionName: "approve",
      args: [ctx.stableVault.address, amount],
    });

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "deposit",
        args: [ctx.usdc.address, amount, ctx.user.account.address],
      }),
      /(EnforcedPause|Pausable)/,
    );
  });

  it("mints shares and emits DepositRecorded with remote=true", async () => {
    const amountNormalized = parseUnits("77", 18);
    const depositId = keccak256("0xaaaa");

    const txHash = await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "recordRemoteDeposit",
      args: [depositId, ctx.user.account.address, amountNormalized],
    });

    const balance = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "balanceOf",
      args: [ctx.user.account.address],
    });

    assert.equal(balance, amountNormalized);
    await expectTotals(ctx, amountNormalized, amountNormalized);

    const args = await getEventArgs<DepositRecordedArgs>(ctx, txHash, "DepositRecorded");
    assert.equal(args.depositId.toLowerCase(), depositId.toLowerCase());
    assert.equal(args.receiver.toLowerCase(), ctx.user.account.address.toLowerCase());
    assert.equal(args.amountNormalized, amountNormalized);
    assert.equal(args.sharesMinted, amountNormalized);
    assert.equal(args.remote, true);
  });

  it("rejects remote EVM deposit from non-relayer", async () => {
    const depositId = keccak256("0xbbbb");

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "recordRemoteDeposit",
        args: [depositId, ctx.user.account.address, parseUnits("1", 18)],
      }),
      /AccessControl/,
    );
  });

  it("rejects remote EVM deposit with zero receiver", async () => {
    const depositId = keccak256("0xcccc");

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "recordRemoteDeposit",
        args: [depositId, ZERO_ADDRESS, parseUnits("1", 18)],
      }),
      /ZeroAddress/,
    );
  });

  it("rejects replayed remote EVM depositId", async () => {
    const depositId = keccak256("0xdddd");
    const amountNormalized = parseUnits("2", 18);

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "recordRemoteDeposit",
      args: [depositId, ctx.user.account.address, amountNormalized],
    });

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "recordRemoteDeposit",
        args: [depositId, ctx.user.account.address, amountNormalized],
      }),
      /DepositAlreadyProcessed/,
    );
  });

  it("failed remote EVM deposit does not consume depositId", async () => {
    const depositId = keccak256("0xeeee");

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "recordRemoteDeposit",
        args: [depositId, ctx.user.account.address, 0n],
      }),
      /AmountZero/,
    );

    const amountNormalized = parseUnits("9", 18);
    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "recordRemoteDeposit",
      args: [depositId, ctx.user.account.address, amountNormalized],
    });

    const balance = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "balanceOf",
      args: [ctx.user.account.address],
    });
    assert.equal(balance, amountNormalized);
  });

  it("registers pseudo address deterministically and mints shares for non-EVM deposit", async () => {
    const depositId = keccak256("0x1111");
    const receiverChainId = 2423n;
    const receiver = "Alice.NEAR";
    const amountNormalized = parseUnits("100", 18);

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "recordRemoteDepositNonEvm",
      args: [depositId, receiverChainId, receiver, amountNormalized],
    });

    const pseudoReceiver = derivePseudoAddress(receiverChainId, receiver);
    const balance = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "balanceOf",
      args: [pseudoReceiver],
    });

    assert.equal(balance, amountNormalized);
    await expectTotals(ctx, amountNormalized, amountNormalized);
  });

  it("emits NonEvmDepositRecorded and DepositRecorded(remote=true)", async () => {
    const depositId = keccak256("0x2222");
    const receiverChainId = 2423n;
    const receiver = "vault.user.near";
    const amountNormalized = parseUnits("33", 18);

    const txHash = await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "recordRemoteDepositNonEvm",
      args: [depositId, receiverChainId, receiver, amountNormalized],
    });

    const pseudoReceiver = derivePseudoAddress(receiverChainId, receiver);

    const depositArgs = await getEventArgs<DepositRecordedArgs>(ctx, txHash, "DepositRecorded");
    assert.equal(depositArgs.depositId.toLowerCase(), depositId.toLowerCase());
    assert.equal(depositArgs.receiver.toLowerCase(), pseudoReceiver.toLowerCase());
    assert.equal(depositArgs.amountNormalized, amountNormalized);
    assert.equal(depositArgs.sharesMinted, amountNormalized);
    assert.equal(depositArgs.remote, true);

    const nonEvmArgs = await getEventArgs<NonEvmDepositRecordedArgs>(ctx, txHash, "NonEvmDepositRecorded");
    assert.equal(nonEvmArgs.depositId.toLowerCase(), depositId.toLowerCase());
    assert.equal(nonEvmArgs.chainId, receiverChainId);
    assert.equal(nonEvmArgs.accountId, receiver);
    assert.equal(nonEvmArgs.pseudoReceiver.toLowerCase(), pseudoReceiver.toLowerCase());
    assert.equal(nonEvmArgs.amountNormalized, amountNormalized);
    assert.equal(nonEvmArgs.sharesMinted, amountNormalized);
  });

  it("rejects remote non-EVM deposit from non-relayer", async () => {
    const depositId = keccak256("0x3333");

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "recordRemoteDepositNonEvm",
        args: [depositId, 2423n, "alice.near", parseUnits("1", 18)],
      }),
      /AccessControl/,
    );
  });

  it("rejects replayed remote non-EVM depositId", async () => {
    const depositId = keccak256("0x4444");
    const amountNormalized = parseUnits("2", 18);

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "recordRemoteDepositNonEvm",
      args: [depositId, 2423n, "alice.near", amountNormalized],
    });

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "recordRemoteDepositNonEvm",
        args: [depositId, 2423n, "alice.near", amountNormalized],
      }),
      /DepositAlreadyProcessed/,
    );
  });

  it("rejects remote non-EVM deposit with invalid receiverChainId", async () => {
    const depositId = keccak256("0x5555");

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "recordRemoteDepositNonEvm",
        args: [depositId, 0n, "alice.near", parseUnits("1", 18)],
      }),
      /InvalidChainId/,
    );
  });

  it("rejects remote non-EVM deposit with empty receiver id", async () => {
    const depositId = keccak256("0x6666");

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "recordRemoteDepositNonEvm",
        args: [depositId, 2423n, "", parseUnits("1", 18)],
      }),
      /InvalidAccountId/,
    );
  });

  it("failed remote non-EVM deposit does not consume depositId", async () => {
    const depositId = keccak256("0x7777");

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "recordRemoteDepositNonEvm",
        args: [depositId, 2423n, "retry.near", 0n],
      }),
      /AmountZero/,
    );

    const amountNormalized = parseUnits("5", 18);
    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "recordRemoteDepositNonEvm",
      args: [depositId, 2423n, "retry.near", amountNormalized],
    });

    const pseudoReceiver = derivePseudoAddress(2423n, "retry.near");
    const balance = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "balanceOf",
      args: [pseudoReceiver],
    });

    assert.equal(balance, amountNormalized);
  });
});
