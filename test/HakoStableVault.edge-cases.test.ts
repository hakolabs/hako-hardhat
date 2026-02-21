import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { keccak256, parseUnits } from "viem";
import { deployFixture } from "./fixtures.js";
import { ZERO_ADDRESS, type VaultTestCtx, approveAndDeposit } from "./hakoStableVaultTestUtils.js";

describe("HakoStableVault edge cases and uncovered branches", () => {
  let ctx: VaultTestCtx;

  beforeEach(async () => {
    ctx = await deployFixture();
  });

  async function seedDeposit(amountUsdc: string = "1000") {
    await approveAndDeposit(ctx, {
      token: ctx.usdc,
      amount: parseUnits(amountUsdc, 6),
      receiver: ctx.user.account.address,
    });
  }

  it("requestWithdrawal reverts with VaultEmpty before first deposit", async () => {
    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "requestWithdrawal",
        args: [ctx.user.account.address, 8453n, ctx.usdc.address, parseUnits("10", 18), parseUnits("10", 18)],
      }),
      /VaultEmpty/,
    );
  });

  it("requestRedeem reverts with VaultEmpty before first deposit", async () => {
    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "requestRedeem",
        args: [ctx.user.account.address, 8453n, ctx.usdc.address, parseUnits("10", 18), parseUnits("10", 18)],
      }),
      /VaultEmpty/,
    );
  });

  it("requestRedeem rejects zero shares", async () => {
    await seedDeposit();

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "requestRedeem",
        args: [ctx.user.account.address, 8453n, ctx.usdc.address, 0n, 0n],
      }),
      /ZeroShares/,
    );
  });

  it("requestWithdrawal rejects when required shares exceed maxShares", async () => {
    await seedDeposit();

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "requestWithdrawal",
        args: [ctx.user.account.address, 8453n, ctx.usdc.address, parseUnits("100", 18), parseUnits("99", 18)],
      }),
      /SharesExceedMax/,
    );
  });

  it("requestRedeem rejects when minAmountNormalized is above computed amount", async () => {
    await seedDeposit();

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "requestRedeem",
        args: [ctx.user.account.address, 8453n, ctx.usdc.address, parseUnits("100", 18), parseUnits("101", 18)],
      }),
      /RedeemAmountBelowMinimum/,
    );
  });

  it("requestWithdrawal rejects non-allowlisted destination token", async () => {
    await seedDeposit();

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "requestWithdrawal",
        args: [ctx.user.account.address, 8453n, ctx.dai.address, parseUnits("10", 18), parseUnits("10", 18)],
      }),
      /DestinationTokenNotAllowed/,
    );
  });

  it("requestWithdrawalController rejects empty receiver bytes", async () => {
    await seedDeposit();

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "requestWithdrawalController",
        args: [ctx.user.account.address, "0x", 8453n, ctx.usdc.address, parseUnits("10", 18), parseUnits("10", 18), 0n],
      }),
      /InvalidReceiverData/,
    );
  });

  it("recordRemoteWithdrawalRequest rejects empty receiver bytes", async () => {
    await seedDeposit();

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "recordRemoteWithdrawalRequest",
        args: [keccak256("0x11112222"), ctx.user.account.address, "0x", 8453n, ctx.usdc.address, parseUnits("10", 18), parseUnits("10", 18)],
      }),
      /InvalidReceiverData/,
    );
  });

  it("completeWithdrawal and cancelWithdrawal revert when request is not pending", async () => {
    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "completeWithdrawal",
        args: [999n],
      }),
      /WithdrawalNotPending/,
    );

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "cancelWithdrawal",
        args: [999n],
      }),
      /WithdrawalNotPending/,
    );
  });

  it("cancelWithdrawal reverts for an already completed request", async () => {
    await seedDeposit();

    await ctx.user.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "requestWithdrawal",
      args: [ctx.user.account.address, 8453n, ctx.usdc.address, parseUnits("50", 18), parseUnits("50", 18)],
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "completeWithdrawal",
      args: [1n],
    });

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "cancelWithdrawal",
        args: [1n],
      }),
      /WithdrawalNotPending/,
    );
  });

  it("setPerformanceFee rejects values above max", async () => {
    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "setPerformanceFee",
        args: [3001n],
      }),
      /FeeTooHigh/,
    );
  });

  it("performance fee and recipient getters reflect updates", async () => {
    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "setPerformanceFee",
      args: [250n],
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "setFeeRecipient",
      args: [ctx.owner.account.address],
    });

    const [feeBps, recipient] = await Promise.all([
      ctx.publicClient.readContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "performanceFeeBps",
        args: [],
      }),
      ctx.publicClient.readContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "feeRecipient",
        args: [],
      }),
    ]);

    assert.equal(feeBps, 250n);
    assert.equal(recipient.toLowerCase(), ctx.owner.account.address.toLowerCase());
  });

  it("setFeeRecipient rejects zero address", async () => {
    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "setFeeRecipient",
        args: [ZERO_ADDRESS],
      }),
      /ZeroAddress/,
    );
  });

  it("setMinDeposit rejects zero value", async () => {
    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "setMinDeposit",
        args: [0n],
      }),
      /AmountZero/,
    );
  });

  it("transferOut validates zero addresses and zero amount", async () => {
    await seedDeposit("100");

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "transferOut",
        args: [keccak256("0x1001"), ZERO_ADDRESS, ctx.owner.account.address, parseUnits("1", 6), keccak256("0x01")],
      }),
      /ZeroAddress/,
    );

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "transferOut",
        args: [keccak256("0x1002"), ctx.usdc.address, ZERO_ADDRESS, parseUnits("1", 6), keccak256("0x01")],
      }),
      /ZeroAddress/,
    );

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "transferOut",
        args: [keccak256("0x1003"), ctx.usdc.address, ctx.owner.account.address, 0n, keccak256("0x01")],
      }),
      /AmountZero/,
    );
  });

  it("transferOut rejects non-allowlisted token and insufficient token balance", async () => {
    await seedDeposit("100");

    const otherToken = await ctx.viem.deployContract("MockERC20", ["Other", "OTH", 6], {
      client: { wallet: ctx.owner },
    });

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "transferOut",
        args: [keccak256("0x2001"), otherToken.address, ctx.owner.account.address, parseUnits("1", 6), keccak256("0x01")],
      }),
      /TokenNotAllowed/,
    );

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "transferOut",
        args: [keccak256("0x2002"), ctx.usdc.address, ctx.owner.account.address, parseUnits("101", 6), keccak256("0x01")],
      }),
      /ERC20InsufficientBalance/,
    );
  });

  it("config setters reject zero addresses where applicable", async () => {
    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "setDestinationAssetAllowed",
        args: [8453n, ZERO_ADDRESS, true],
      }),
      /ZeroAddress/,
    );

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "setExternalVaultAllowed",
        args: [ZERO_ADDRESS, true],
      }),
      /ZeroAddress/,
    );
  });

  it("addAllowedDepositToken rejects tokens with decimals > 18", async () => {
    const badToken = await ctx.viem.deployContract("MockERC20", ["Bad", "BAD", 19], {
      client: { wallet: ctx.owner },
    });

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "addAllowedDepositToken",
        args: [badToken.address],
      }),
      /DecimalsTooHigh/,
    );
  });

  it("deriveVirtualDestinationTokenAddress is deterministic and validates inputs", async () => {
    const [first, second] = await Promise.all([
      ctx.publicClient.readContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "deriveVirtualDestinationTokenAddress",
        args: [2423n, "USDC"],
      }),
      ctx.publicClient.readContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "deriveVirtualDestinationTokenAddress",
        args: [2423n, "USDC"],
      }),
    ]);

    assert.equal(first[0].toLowerCase(), second[0].toLowerCase());
    assert.equal(first[1].toLowerCase(), second[1].toLowerCase());

    await assert.rejects(
      ctx.publicClient.readContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "deriveVirtualDestinationTokenAddress",
        args: [0n, "USDC"],
      }),
      /InvalidChainId/,
    );

    await assert.rejects(
      ctx.publicClient.readContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "deriveVirtualDestinationTokenAddress",
        args: [2423n, ""],
      }),
      /InvalidTokenId/,
    );
  });

  it("getExternalVaultPositions returns normalized position after deposit", async () => {
    await seedDeposit("500");

    const externalVault = await ctx.viem.deployContract(
      "DummyERC4626",
      [ctx.usdc.address, "Dummy Vault Share", "dUSDC"],
      { client: { wallet: ctx.owner } },
    );

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "setExternalVaultAllowed",
      args: [externalVault.address, true],
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "depositIntoExternalVault",
      args: [externalVault.address, parseUnits("200", 6)],
    });

    const positions = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "getExternalVaultPositions",
      args: [],
    });

    assert.equal(positions.length, 1);
    assert.equal(positions[0].vault.toLowerCase(), externalVault.address.toLowerCase());
    assert.equal(positions[0].asset.toLowerCase(), ctx.usdc.address.toLowerCase());
    assert.equal(positions[0].assets, parseUnits("200", 6));
    assert.equal(positions[0].assetsNormalized, parseUnits("200", 18));
  });

  it("withdrawFromExternalVault and redeemFromExternalVault reject unknown vault", async () => {
    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "withdrawFromExternalVault",
        args: [ctx.usdc.address, parseUnits("1", 6), ZERO_ADDRESS],
      }),
      /ExternalVaultUnknown/,
    );

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "redeemFromExternalVault",
        args: [ctx.usdc.address, parseUnits("1", 6), ZERO_ADDRESS],
      }),
      /ExternalVaultUnknown/,
    );
  });

  it("withdraw/redeem external vault reject receiver other than zero or vault contract", async () => {
    await seedDeposit("500");

    const externalVault = await ctx.viem.deployContract(
      "DummyERC4626",
      [ctx.usdc.address, "Dummy Vault Share", "dUSDC"],
      { client: { wallet: ctx.owner } },
    );

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "setExternalVaultAllowed",
      args: [externalVault.address, true],
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "depositIntoExternalVault",
      args: [externalVault.address, parseUnits("200", 6)],
    });

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "withdrawFromExternalVault",
        args: [externalVault.address, parseUnits("1", 6), ctx.user.account.address],
      }),
      /ExternalReceiverNotAllowed/,
    );

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "redeemFromExternalVault",
        args: [externalVault.address, parseUnits("1", 6), ctx.user.account.address],
      }),
      /ExternalReceiverNotAllowed/,
    );
  });

  it("remote EVM deposit below min does not consume deposit id", async () => {
    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "setMinDeposit",
      args: [parseUnits("100", 18)],
    });

    const depositId = keccak256("0x9999");

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "recordRemoteDeposit",
        args: [depositId, ctx.user.account.address, parseUnits("10", 18)],
      }),
      /BelowMinDeposit/,
    );

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "recordRemoteDeposit",
      args: [depositId, ctx.user.account.address, parseUnits("100", 18)],
    });
  });

  it("remote non-EVM deposit below min does not consume deposit id", async () => {
    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "setMinDeposit",
      args: [parseUnits("100", 18)],
    });

    const depositId = keccak256("0x8888");

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "recordRemoteDepositNonEvm",
        args: [depositId, 2423n, "user.near", parseUnits("10", 18)],
      }),
      /BelowMinDeposit/,
    );

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "recordRemoteDepositNonEvm",
      args: [depositId, 2423n, "user.near", parseUnits("100", 18)],
    });
  });
});
