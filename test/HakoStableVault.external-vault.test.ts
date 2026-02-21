import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { parseUnits } from "viem";
import { deployFixture } from "./fixtures.js";
import { ZERO_ADDRESS, type VaultTestCtx, approveAndDeposit, getEventArgs } from "./hakoStableVaultTestUtils.js";

type ExternalVaultDepositArgs = {
  vault: `0x${string}`;
  asset: `0x${string}`;
  assets: bigint;
  sharesMinted: bigint;
};

type ExternalVaultWithdrawArgs = {
  vault: `0x${string}`;
  asset: `0x${string}`;
  assets: bigint;
  sharesBurned: bigint;
  receiver: `0x${string}`;
};

type ExternalVaultRedeemArgs = {
  vault: `0x${string}`;
  asset: `0x${string}`;
  sharesBurned: bigint;
  assetsReceived: bigint;
  receiver: `0x${string}`;
};

describe("HakoStableVault external vault integration", () => {
  let ctx: VaultTestCtx;

  beforeEach(async () => {
    ctx = await deployFixture();
  });

  async function seedUsdcVault(amount: string = "1000") {
    await approveAndDeposit(ctx, {
      token: ctx.usdc,
      amount: parseUnits(amount, 6),
      receiver: ctx.user.account.address,
    });
  }

  async function seedDaiVault(amount: string = "1000") {
    await approveAndDeposit(ctx, {
      token: ctx.dai,
      amount: parseUnits(amount, 18),
      receiver: ctx.user.account.address,
    });
  }

  async function deployExternalVaultForUsdc() {
    const externalVault = await ctx.viem.deployContract(
      "DummyERC4626",
      [ctx.usdc.address, "USDC External Vault", "xUSDC"],
      { client: { wallet: ctx.owner } },
    );

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "setExternalVaultAllowed",
      args: [externalVault.address, true],
    });

    return externalVault;
  }

  async function deployExternalVaultForDai() {
    const externalVault = await ctx.viem.deployContract(
      "DummyERC4626",
      [ctx.dai.address, "DAI External Vault", "xDAI"],
      { client: { wallet: ctx.owner } },
    );

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "setExternalVaultAllowed",
      args: [externalVault.address, true],
    });

    return externalVault;
  }

  it("moves assets into external vault and can fully unwind by withdraw+redeem", async () => {
    await seedUsdcVault("1000");
    const externalVault = await deployExternalVaultForUsdc();

    const totalAssetsBefore = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "totalAssets",
      args: [],
    });

    const depositTx = await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "depositIntoExternalVault",
      args: [externalVault.address, parseUnits("300", 6)],
    });

    const depositEvent = await getEventArgs<ExternalVaultDepositArgs>(ctx, depositTx, "ExternalVaultDeposit");
    assert.equal(depositEvent.assets, parseUnits("300", 6));
    assert.equal(depositEvent.sharesMinted, parseUnits("300", 6));

    const [vaultUsdcAfterDeposit, extUsdcAfterDeposit, extSharesAfterDeposit] = await Promise.all([
      ctx.publicClient.readContract({
        address: ctx.usdc.address,
        abi: ctx.usdc.abi,
        functionName: "balanceOf",
        args: [ctx.stableVault.address],
      }),
      ctx.publicClient.readContract({
        address: ctx.usdc.address,
        abi: ctx.usdc.abi,
        functionName: "balanceOf",
        args: [externalVault.address],
      }),
      ctx.publicClient.readContract({
        address: externalVault.address,
        abi: externalVault.abi,
        functionName: "balanceOf",
        args: [ctx.stableVault.address],
      }),
    ]);

    assert.equal(vaultUsdcAfterDeposit, parseUnits("700", 6));
    assert.equal(extUsdcAfterDeposit, parseUnits("300", 6));
    assert.equal(extSharesAfterDeposit, parseUnits("300", 6));

    const positionsAfterDeposit = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "getExternalVaultPositions",
      args: [],
    });
    assert.equal(positionsAfterDeposit.length, 1);
    assert.equal(positionsAfterDeposit[0].assets, parseUnits("300", 6));
    assert.equal(positionsAfterDeposit[0].assetsNormalized, parseUnits("300", 18));

    const withdrawTx = await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "withdrawFromExternalVault",
      args: [externalVault.address, parseUnits("100", 6), ZERO_ADDRESS],
    });

    const withdrawEvent = await getEventArgs<ExternalVaultWithdrawArgs>(ctx, withdrawTx, "ExternalVaultWithdraw");
    assert.equal(withdrawEvent.assets, parseUnits("100", 6));
    assert.equal(withdrawEvent.receiver.toLowerCase(), ctx.stableVault.address.toLowerCase());

    const redeemTx = await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "redeemFromExternalVault",
      args: [externalVault.address, parseUnits("200", 6), ZERO_ADDRESS],
    });

    const redeemEvent = await getEventArgs<ExternalVaultRedeemArgs>(ctx, redeemTx, "ExternalVaultRedeem");
    assert.equal(redeemEvent.sharesBurned, parseUnits("200", 6));
    assert.equal(redeemEvent.assetsReceived, parseUnits("200", 6));

    const [vaultUsdcFinal, extUsdcFinal, extSharesFinal, totalAssetsFinal] = await Promise.all([
      ctx.publicClient.readContract({
        address: ctx.usdc.address,
        abi: ctx.usdc.abi,
        functionName: "balanceOf",
        args: [ctx.stableVault.address],
      }),
      ctx.publicClient.readContract({
        address: ctx.usdc.address,
        abi: ctx.usdc.abi,
        functionName: "balanceOf",
        args: [externalVault.address],
      }),
      ctx.publicClient.readContract({
        address: externalVault.address,
        abi: externalVault.abi,
        functionName: "balanceOf",
        args: [ctx.stableVault.address],
      }),
      ctx.publicClient.readContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "totalAssets",
        args: [],
      }),
    ]);

    assert.equal(vaultUsdcFinal, parseUnits("1000", 6));
    assert.equal(extUsdcFinal, 0n);
    assert.equal(extSharesFinal, 0n);
    assert.equal(totalAssetsFinal, totalAssetsBefore);

    const positionsFinal = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "getExternalVaultPositions",
      args: [],
    });
    assert.equal(positionsFinal.length, 0);
  });

  it("tracks external yield in positions and requires managed-asset adjustment to reflect in totalAssets", async () => {
    await seedUsdcVault("1000");
    const externalVault = await deployExternalVaultForUsdc();

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "depositIntoExternalVault",
      args: [externalVault.address, parseUnits("200", 6)],
    });

    await ctx.owner.writeContract({
      address: ctx.usdc.address,
      abi: ctx.usdc.abi,
      functionName: "mint",
      args: [externalVault.address, parseUnits("50", 6)],
    });

    const positions = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "getExternalVaultPositions",
      args: [],
    });
    assert.equal(positions.length, 1);
    assert.equal(positions[0].shareBalance, parseUnits("200", 6));
    assert.ok(positions[0].assets > parseUnits("200", 6));
    assert.ok(positions[0].assets <= parseUnits("250", 6));
    assert.equal(positions[0].assetsNormalized, positions[0].assets * 10n ** 12n);

    const totalAssetsBeforeAdjust = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "totalAssets",
      args: [],
    });
    assert.equal(totalAssetsBeforeAdjust, parseUnits("1000", 18));

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "redeemFromExternalVault",
      args: [externalVault.address, parseUnits("200", 6), ZERO_ADDRESS],
    });

    const vaultUsdcAfterRedeem = await ctx.publicClient.readContract({
      address: ctx.usdc.address,
      abi: ctx.usdc.abi,
      functionName: "balanceOf",
      args: [ctx.stableVault.address],
    });
    const realizedProfitRaw = vaultUsdcAfterRedeem - parseUnits("1000", 6);
    assert.ok(realizedProfitRaw > 0n);

    const totalAssetsStillOld = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "totalAssets",
      args: [],
    });
    assert.equal(totalAssetsStillOld, parseUnits("1000", 18));

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "adjustManagedAssets",
      args: [realizedProfitRaw * 10n ** 12n],
    });

    const totalAssetsAfterAdjust = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "totalAssets",
      args: [],
    });
    assert.equal(totalAssetsAfterAdjust, parseUnits("1000", 18) + realizedProfitRaw * 10n ** 12n);
  });

  it("allows unwind after external vault is removed from allowlist but blocks new deposits", async () => {
    await seedUsdcVault("1000");
    const externalVault = await deployExternalVaultForUsdc();

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "depositIntoExternalVault",
      args: [externalVault.address, parseUnits("200", 6)],
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "setExternalVaultAllowed",
      args: [externalVault.address, false],
    });

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "depositIntoExternalVault",
        args: [externalVault.address, parseUnits("1", 6)],
      }),
      /ExternalVaultNotAllowed/,
    );

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "withdrawFromExternalVault",
      args: [externalVault.address, parseUnits("50", 6), ZERO_ADDRESS],
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "redeemFromExternalVault",
      args: [externalVault.address, parseUnits("150", 6), ZERO_ADDRESS],
    });

    const extShares = await ctx.publicClient.readContract({
      address: externalVault.address,
      abi: externalVault.abi,
      functionName: "balanceOf",
      args: [ctx.stableVault.address],
    });
    assert.equal(extShares, 0n);
  });

  it("supports external withdraw/redeem with explicit receiver=stableVault address", async () => {
    await seedUsdcVault("1000");
    const externalVault = await deployExternalVaultForUsdc();

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "depositIntoExternalVault",
      args: [externalVault.address, parseUnits("100", 6)],
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "withdrawFromExternalVault",
      args: [externalVault.address, parseUnits("20", 6), ctx.stableVault.address],
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "redeemFromExternalVault",
      args: [externalVault.address, parseUnits("80", 6), ctx.stableVault.address],
    });

    const extShares = await ctx.publicClient.readContract({
      address: externalVault.address,
      abi: externalVault.abi,
      functionName: "balanceOf",
      args: [ctx.stableVault.address],
    });
    assert.equal(extShares, 0n);
  });

  it("blocks external vault operations while paused and resumes after unpause", async () => {
    await seedUsdcVault("500");
    const externalVault = await deployExternalVaultForUsdc();

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "depositIntoExternalVault",
      args: [externalVault.address, parseUnits("100", 6)],
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "pause",
      args: [],
    });

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "depositIntoExternalVault",
        args: [externalVault.address, parseUnits("10", 6)],
      }),
      /(EnforcedPause|Pausable)/,
    );

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "withdrawFromExternalVault",
        args: [externalVault.address, parseUnits("10", 6), ZERO_ADDRESS],
      }),
      /(EnforcedPause|Pausable)/,
    );

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "redeemFromExternalVault",
        args: [externalVault.address, parseUnits("10", 6), ZERO_ADDRESS],
      }),
      /(EnforcedPause|Pausable)/,
    );

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "unpause",
      args: [],
    });

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "withdrawFromExternalVault",
      args: [externalVault.address, parseUnits("50", 6), ZERO_ADDRESS],
    });
  });

  it("rejects external vault whose underlying asset is not an allowed deposit token", async () => {
    const badToken = await ctx.viem.deployContract("MockERC20", ["Bad", "BAD", 6], {
      client: { wallet: ctx.owner },
    });

    const badExternalVault = await ctx.viem.deployContract(
      "DummyERC4626",
      [badToken.address, "Bad External", "xBAD"],
      { client: { wallet: ctx.owner } },
    );

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "setExternalVaultAllowed",
      args: [badExternalVault.address, true],
    });

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.stableVault.address,
        abi: ctx.stableVault.abi,
        functionName: "depositIntoExternalVault",
        args: [badExternalVault.address, parseUnits("1", 6)],
      }),
      /TokenNotAllowed/,
    );
  });

  it("returns correctly normalized positions for 18-decimal underlying asset", async () => {
    await seedDaiVault("1000");
    const externalVault = await deployExternalVaultForDai();

    await ctx.owner.writeContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "depositIntoExternalVault",
      args: [externalVault.address, parseUnits("200", 18)],
    });

    const positions = await ctx.publicClient.readContract({
      address: ctx.stableVault.address,
      abi: ctx.stableVault.abi,
      functionName: "getExternalVaultPositions",
      args: [],
    });

    assert.equal(positions.length, 1);
    assert.equal(positions[0].asset.toLowerCase(), ctx.dai.address.toLowerCase());
    assert.equal(positions[0].assets, parseUnits("200", 18));
    assert.equal(positions[0].assetsNormalized, parseUnits("200", 18));
  });
});
