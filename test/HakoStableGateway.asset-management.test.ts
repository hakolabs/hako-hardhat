import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { keccak256, parseUnits, type Hex } from "viem";
import { deployGatewayFixture } from "./gatewayFixtures.js";
import {
  ZERO_ADDRESS,
  type GatewayTestCtx,
  approveAndDepositGateway,
  getGatewayEventArgs,
  readTokenBalance,
} from "./hakoStableGatewayTestUtils.js";

type GatewayTransferOutArgs = {
  operationId: Hex;
  token: `0x${string}`;
  to: `0x${string}`;
  amountToken: bigint;
  reasonCode: Hex;
};

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

describe("HakoStableGateway asset management", () => {
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

  async function deployUsdcExternalVault() {
    const externalVault = await ctx.viem.deployContract(
      "DummyERC4626",
      [ctx.usdc.address, "Gateway External USDC", "gxUSDC"],
      { client: { wallet: ctx.owner } },
    );

    await ctx.owner.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "setExternalVaultAllowed",
      args: [externalVault.address, true],
    });

    return externalVault;
  }

  it("transferOut is replay-protected and does not require token allowlist", async () => {
    await seedUsdc("300");

    const otherToken = await ctx.viem.deployContract("MockERC20", ["Other", "OTH", 6], {
      client: { wallet: ctx.owner },
    });
    await ctx.owner.writeContract({
      address: otherToken.address,
      abi: otherToken.abi,
      functionName: "mint",
      args: [ctx.gateway.address, parseUnits("20", 6)],
    });

    const operationId = keccak256("0xfeed0001");
    const reasonCode = keccak256("0xa1");
    const ownerOtherBefore = await readTokenBalance(ctx, otherToken, ctx.owner.account.address);

    const txHash = await ctx.owner.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "transferOut",
      args: [operationId, otherToken.address, ctx.owner.account.address, parseUnits("10", 6), reasonCode],
    });

    const event = await getGatewayEventArgs<GatewayTransferOutArgs>(ctx, txHash, "GatewayTransferOut");
    assert.equal(event.operationId.toLowerCase(), operationId.toLowerCase());
    assert.equal(event.token.toLowerCase(), otherToken.address.toLowerCase());
    assert.equal(event.to.toLowerCase(), ctx.owner.account.address.toLowerCase());
    assert.equal(event.amountToken, parseUnits("10", 6));
    assert.equal(event.reasonCode.toLowerCase(), reasonCode.toLowerCase());

    const ownerOtherAfter = await readTokenBalance(ctx, otherToken, ctx.owner.account.address);
    assert.equal(ownerOtherAfter, ownerOtherBefore + parseUnits("10", 6));

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.gateway.address,
        abi: ctx.gateway.abi,
        functionName: "transferOut",
        args: [operationId, otherToken.address, ctx.owner.account.address, 1n, reasonCode],
      }),
      /OperationAlreadyProcessed/,
    );
  });

  it("transferOut reverts on insufficient token balance", async () => {
    await seedUsdc("50");

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.gateway.address,
        abi: ctx.gateway.abi,
        functionName: "transferOut",
        args: [keccak256("0xfeed0002"), ctx.usdc.address, ctx.owner.account.address, parseUnits("51", 6), keccak256("0xb2")],
      }),
      /ERC20InsufficientBalance/,
    );
  });

  it("external vault lifecycle keeps custody balances and positions consistent", async () => {
    await seedUsdc("1000");
    const externalVault = await deployUsdcExternalVault();

    const depositTx = await ctx.owner.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "depositIntoExternalVault",
      args: [externalVault.address, parseUnits("400", 6)],
    });
    const depositEvent = await getGatewayEventArgs<ExternalVaultDepositArgs>(ctx, depositTx, "ExternalVaultDeposit");
    assert.equal(depositEvent.assets, parseUnits("400", 6));
    assert.equal(depositEvent.sharesMinted, parseUnits("400", 6));

    const [gatewayUsdcAfterDeposit, extUsdcAfterDeposit, extSharesAfterDeposit] = await Promise.all([
      readTokenBalance(ctx, ctx.usdc, ctx.gateway.address),
      readTokenBalance(ctx, ctx.usdc, externalVault.address),
      readTokenBalance(ctx, { address: externalVault.address, abi: externalVault.abi }, ctx.gateway.address),
    ]);
    assert.equal(gatewayUsdcAfterDeposit, parseUnits("600", 6));
    assert.equal(extUsdcAfterDeposit, parseUnits("400", 6));
    assert.equal(extSharesAfterDeposit, parseUnits("400", 6));

    const positions = await ctx.publicClient.readContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "getExternalVaultPositions",
      args: [],
    });
    assert.equal(positions.length, 1);
    assert.equal(positions[0].assets, parseUnits("400", 6));
    assert.equal(positions[0].assetsNormalized, parseUnits("400", 18));

    const withdrawTx = await ctx.owner.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "withdrawFromExternalVault",
      args: [externalVault.address, parseUnits("150", 6), ZERO_ADDRESS],
    });
    const withdrawEvent =
      await getGatewayEventArgs<ExternalVaultWithdrawArgs>(ctx, withdrawTx, "ExternalVaultWithdraw");
    assert.equal(withdrawEvent.assets, parseUnits("150", 6));
    assert.equal(withdrawEvent.receiver.toLowerCase(), ctx.gateway.address.toLowerCase());

    const redeemTx = await ctx.owner.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "redeemFromExternalVault",
      args: [externalVault.address, parseUnits("250", 6), ZERO_ADDRESS],
    });
    const redeemEvent = await getGatewayEventArgs<ExternalVaultRedeemArgs>(ctx, redeemTx, "ExternalVaultRedeem");
    assert.equal(redeemEvent.sharesBurned, parseUnits("250", 6));
    assert.equal(redeemEvent.assetsReceived, parseUnits("250", 6));

    const [gatewayUsdcFinal, extUsdcFinal, extSharesFinal] = await Promise.all([
      readTokenBalance(ctx, ctx.usdc, ctx.gateway.address),
      readTokenBalance(ctx, ctx.usdc, externalVault.address),
      readTokenBalance(ctx, { address: externalVault.address, abi: externalVault.abi }, ctx.gateway.address),
    ]);
    assert.equal(gatewayUsdcFinal, parseUnits("1000", 6));
    assert.equal(extUsdcFinal, 0n);
    assert.equal(extSharesFinal, 0n);
  });

  it("external vault safety: allowlist, cache, and receiver restrictions", async () => {
    await seedUsdc("500");
    const externalVault = await deployUsdcExternalVault();

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.gateway.address,
        abi: ctx.gateway.abi,
        functionName: "withdrawFromExternalVault",
        args: [externalVault.address, parseUnits("1", 6), ZERO_ADDRESS],
      }),
      /ExternalVaultUnknown/,
    );

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.gateway.address,
        abi: ctx.gateway.abi,
        functionName: "redeemFromExternalVault",
        args: [externalVault.address, parseUnits("1", 6), ZERO_ADDRESS],
      }),
      /ExternalVaultUnknown/,
    );

    await ctx.owner.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "depositIntoExternalVault",
      args: [externalVault.address, parseUnits("100", 6)],
    });

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.gateway.address,
        abi: ctx.gateway.abi,
        functionName: "withdrawFromExternalVault",
        args: [externalVault.address, parseUnits("1", 6), ctx.user.account.address],
      }),
      /ExternalReceiverNotAllowed/,
    );

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.gateway.address,
        abi: ctx.gateway.abi,
        functionName: "redeemFromExternalVault",
        args: [externalVault.address, parseUnits("1", 6), ctx.user.account.address],
      }),
      /ExternalReceiverNotAllowed/,
    );

    await ctx.owner.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "setExternalVaultAllowed",
      args: [externalVault.address, false],
    });

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.gateway.address,
        abi: ctx.gateway.abi,
        functionName: "depositIntoExternalVault",
        args: [externalVault.address, parseUnits("1", 6)],
      }),
      /ExternalVaultNotAllowed/,
    );

    await ctx.owner.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "withdrawFromExternalVault",
      args: [externalVault.address, parseUnits("100", 6), ZERO_ADDRESS],
    });
  });

  it("rejects external vault deposit if underlying asset token is not allowlisted", async () => {
    const usdtVault = await ctx.viem.deployContract(
      "DummyERC4626",
      [ctx.usdt.address, "Gateway External USDT", "gxUSDT"],
      { client: { wallet: ctx.owner } },
    );

    await ctx.owner.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "setExternalVaultAllowed",
      args: [usdtVault.address, true],
    });

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.gateway.address,
        abi: ctx.gateway.abi,
        functionName: "depositIntoExternalVault",
        args: [usdtVault.address, parseUnits("1", 6)],
      }),
      /TokenNotAllowed/,
    );
  });
});
