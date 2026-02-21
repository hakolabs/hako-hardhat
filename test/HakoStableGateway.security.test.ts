import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { keccak256, parseUnits } from "viem";
import { deployGatewayFixture } from "./gatewayFixtures.js";
import { type GatewayTestCtx, approveAndDepositGateway } from "./hakoStableGatewayTestUtils.js";

describe("HakoStableGateway roles and pause security", () => {
  let ctx: GatewayTestCtx;

  beforeEach(async () => {
    ctx = await deployGatewayFixture();
  });

  async function seedUsdc(amount = "500") {
    await approveAndDepositGateway(ctx, {
      token: ctx.usdc,
      amount: parseUnits(amount, 6),
      receiver: ctx.user.account.address,
    });
  }

  it("assigns all critical roles to initial owner", async () => {
    const roleNames = [
      "DEFAULT_ADMIN_ROLE",
      "UPGRADER_ROLE",
      "GUARDIAN_ROLE",
      "WITHDRAW_FINALIZER_ROLE",
      "ASSET_MANAGER_ROLE",
      "CONFIG_MANAGER_ROLE",
    ] as const;

    for (const roleName of roleNames) {
      const role = await ctx.publicClient.readContract({
        address: ctx.gateway.address,
        abi: ctx.gateway.abi,
        functionName: roleName,
        args: [],
      });

      const [ownerHasRole, userHasRole] = await Promise.all([
        ctx.publicClient.readContract({
          address: ctx.gateway.address,
          abi: ctx.gateway.abi,
          functionName: "hasRole",
          args: [role, ctx.owner.account.address],
        }),
        ctx.publicClient.readContract({
          address: ctx.gateway.address,
          abi: ctx.gateway.abi,
          functionName: "hasRole",
          args: [role, ctx.user.account.address],
        }),
      ]);

      assert.equal(ownerHasRole, true);
      assert.equal(userHasRole, false);
    }
  });

  it("default admin can grant and revoke asset manager role", async () => {
    await seedUsdc("10");

    const assetManagerRole = await ctx.publicClient.readContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "ASSET_MANAGER_ROLE",
      args: [],
    });

    await ctx.owner.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "grantRole",
      args: [assetManagerRole, ctx.operator.account.address],
    });

    await ctx.operator.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "transferOut",
      args: [keccak256("0x7777"), ctx.usdc.address, ctx.owner.account.address, 1n, keccak256("0x01")],
    });

    await ctx.owner.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "revokeRole",
      args: [assetManagerRole, ctx.operator.account.address],
    });

    await assert.rejects(
      ctx.operator.writeContract({
        address: ctx.gateway.address,
        abi: ctx.gateway.abi,
        functionName: "transferOut",
        args: [keccak256("0x8888"), ctx.usdc.address, ctx.owner.account.address, 1n, keccak256("0x01")],
      }),
      /AccessControl/,
    );
  });

  it("non-admin cannot grant roles", async () => {
    const assetManagerRole = await ctx.publicClient.readContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "ASSET_MANAGER_ROLE",
      args: [],
    });

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.gateway.address,
        abi: ctx.gateway.abi,
        functionName: "grantRole",
        args: [assetManagerRole, ctx.user.account.address],
      }),
      /AccessControl/,
    );
  });

  it("pause blocks operational methods guarded by whenNotPaused", async () => {
    await seedUsdc("800");

    const externalVault = await ctx.viem.deployContract(
      "DummyERC4626",
      [ctx.usdc.address, "Pause Test Vault", "pUSDC"],
      { client: { wallet: ctx.owner } },
    );
    await ctx.owner.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "setExternalVaultAllowed",
      args: [externalVault.address, true],
    });

    await ctx.owner.writeContract({
      address: ctx.gateway.address,
      abi: ctx.gateway.abi,
      functionName: "pause",
      args: [],
    });

    const amount = parseUnits("10", 6);
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

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.gateway.address,
        abi: ctx.gateway.abi,
        functionName: "requestWithdrawal",
        args: [ctx.usdc.address, amount, ctx.user.account.address],
      }),
      /(EnforcedPause|Pausable)/,
    );

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.gateway.address,
        abi: ctx.gateway.abi,
        functionName: "transferOut",
        args: [keccak256("0xbbbb"), ctx.usdc.address, ctx.owner.account.address, amount, keccak256("0x01")],
      }),
      /(EnforcedPause|Pausable)/,
    );

    await assert.rejects(
      ctx.owner.writeContract({
        address: ctx.gateway.address,
        abi: ctx.gateway.abi,
        functionName: "depositIntoExternalVault",
        args: [externalVault.address, amount],
      }),
      /(EnforcedPause|Pausable)/,
    );
  });

  it("withdraw finalizer can complete and cancel while paused, non-finalizer cannot", async () => {
    await seedUsdc("500");

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

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.gateway.address,
        abi: ctx.gateway.abi,
        functionName: "completeWithdrawal",
        args: [1n],
      }),
      /AccessControl/,
    );

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
  });

  it("only config manager can call config methods", async () => {
    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.gateway.address,
        abi: ctx.gateway.abi,
        functionName: "addAllowedDepositToken",
        args: [ctx.usdt.address],
      }),
      /AccessControl/,
    );

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.gateway.address,
        abi: ctx.gateway.abi,
        functionName: "removeAllowedDepositToken",
        args: [ctx.usdc.address],
      }),
      /AccessControl/,
    );

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.gateway.address,
        abi: ctx.gateway.abi,
        functionName: "setMinDeposit",
        args: [parseUnits("2", 18)],
      }),
      /AccessControl/,
    );

    await assert.rejects(
      ctx.user.writeContract({
        address: ctx.gateway.address,
        abi: ctx.gateway.abi,
        functionName: "setExternalVaultAllowed",
        args: [ctx.usdc.address, true],
      }),
      /AccessControl/,
    );
  });
});
